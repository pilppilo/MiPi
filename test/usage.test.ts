/**
 * The usage readout (M9, COD-193): each provider's own figures where MiPi can read them (OpenCode Go first), MiPi's
 * own estimate always, and the same readout on every door (Telegram `/usage` here; the web and admin status use the
 * same `readUsage`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, UsageDoc } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { createHarnessOptions } from "../src/agent/composition.ts";
import { Proactive } from "../src/agent/proactive.ts";
import { measureSpend, Spend } from "../src/agent/spend.ts";
import { readUsage, usageText } from "../src/agent/usage.ts";
import {
  GO_USAGE_URL,
  goUsageSource,
  parseGoUsage,
  ProviderUsageCache,
  USAGE_CACHE_MS,
  type UsageSource,
  usageSources,
} from "../src/agent/usage-sources.ts";
import { parseUsageReadout, type UsageReadout } from "../src/protocol.ts";
import { CHAT, clock, inObject, openAgent } from "./reminder-agent.ts";

const ctx = BACKGROUND_CONTEXT;
const NOON = Date.UTC(2026, 10, 23, 18, 0);

const goBody = (rolling: "ok" | "rate-limited" = "ok") => ({
  usage: {
    rolling: { status: rolling, percent: 12.4, resetsAt: "2026-11-23T22:00:00.000Z" },
    weekly: { status: "ok", percent: 34, resetsAt: "2026-11-30T06:00:00.000Z" },
    monthly: { status: "ok", percent: 101, resetsAt: "2026-12-01T06:00:00.000Z" },
  },
});

/** A fetch that answers with `status` and `body`, and records each request. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

const env =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe("OpenCode Go's usage", () => {
  it("reads the rolling, weekly and monthly windows", () => {
    expect(parseGoUsage(goBody("rate-limited"))).toEqual([
      {
        name: "rolling",
        percent: 12.4,
        limited: true,
        resetsAt: Date.parse("2026-11-23T22:00:00.000Z"),
      },
      {
        name: "weekly",
        percent: 34,
        limited: false,
        resetsAt: Date.parse("2026-11-30T06:00:00.000Z"),
      },
      // Over 100 is shown as 100.
      {
        name: "monthly",
        percent: 100,
        limited: false,
        resetsAt: Date.parse("2026-12-01T06:00:00.000Z"),
      },
    ]);
  });

  it("refuses any other shape with a short reason", () => {
    expect(() => parseGoUsage({})).toThrow("unexpected shape");
    expect(() =>
      parseGoUsage({ usage: { ...goBody().usage, weekly: { status: "ok", percent: 3 } } }),
    ).toThrow("weekly usage");
    expect(() =>
      parseGoUsage({
        usage: { ...goBody().usage, rolling: { status: "busy", percent: 3, resetsAt: "x" } },
      }),
    ).toThrow("rolling usage");
  });

  it("has no reader without a key, and prefers the usage key, with the workspace when set", async () => {
    expect(goUsageSource(env({}))).toBeUndefined();
    expect(goUsageSource(env({ OPENCODE_API_KEY: "  " }))).toBeUndefined();
    // `off` is what the deploy writes when a lane has no usage key: the model key is used.
    const off = fakeFetch(200, goBody());
    await goUsageSource(env({ OPENCODE_API_KEY: "model-key", OPENCODE_USAGE_KEY: "off" }))!.read(
      off.fetcher,
    );
    expect(off.calls[0]!.headers.Authorization).toBe("Bearer model-key");
    expect(usageSources(env({}))).toEqual([]);
    const { calls, fetcher } = fakeFetch(200, goBody());
    const source = goUsageSource(
      env({
        OPENCODE_API_KEY: "model-key",
        OPENCODE_USAGE_KEY: "usage-key",
        OPENCODE_ORG_ID: "wrk_1",
      }),
    )!;
    const usage = await source.read(fetcher);
    expect(usage).toMatchObject({ provider: "opencode-go", label: "OpenCode Go", status: "ok" });
    expect(calls).toEqual([
      {
        url: GO_USAGE_URL,
        headers: {
          Authorization: "Bearer usage-key",
          Accept: "application/json",
          "x-opencode-org-id": "wrk_1",
        },
      },
    ]);
    const fallback = fakeFetch(200, goBody());
    await goUsageSource(env({ OPENCODE_API_KEY: "model-key" }))!.read(fallback.fetcher);
    expect(fallback.calls[0]!.headers).toEqual({
      Authorization: "Bearer model-key",
      Accept: "application/json",
    });
  });

  it("says why when the key can't read usage", async () => {
    const source = goUsageSource(env({ OPENCODE_API_KEY: "k" }))!;
    for (const [status, reason] of [
      [401, "the key has no usage permission"],
      [403, "no Go plan for this key"],
      [500, "it answered 500"],
    ] as const) {
      expect(await source.read(fakeFetch(status, {}).fetcher)).toEqual({
        provider: "opencode-go",
        label: "OpenCode Go",
        status: "unavailable",
        reason,
      });
    }
  });
});

describe("the provider cache", () => {
  it("shares one read between callers at the same moment", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source: UsageSource = {
      provider: "p",
      label: "P",
      read: async () => {
        reads += 1;
        await gate;
        return { provider: "p", label: "P", status: "ok", windows: [] };
      },
    };
    const cache = new ProviderUsageCache([source]);
    const both = Promise.all([cache.read(0), cache.read(0)]);
    release();
    await both;
    expect(reads).toBe(1);
  });

  it("reads each source at most every five minutes, a failure too", async () => {
    let reads = 0;
    let fail = true;
    const source: UsageSource = {
      provider: "p",
      label: "P",
      read: async () => {
        reads += 1;
        if (fail) throw new Error("down");
        return { provider: "p", label: "P", status: "ok", windows: [] };
      },
    };
    const cache = new ProviderUsageCache([source]);
    expect(await cache.read(0)).toEqual([
      { provider: "p", label: "P", status: "unavailable", reason: "down" },
    ]);
    fail = false;
    await cache.read(USAGE_CACHE_MS - 1);
    expect(reads).toBe(1);
    expect(await cache.read(USAGE_CACHE_MS)).toEqual([
      { provider: "p", label: "P", status: "ok", windows: [] },
    ]);
    expect(reads).toBe(2);
    // Without reading: what is cached, until it is five minutes old.
    expect(cache.cached(USAGE_CACHE_MS + 1)).toHaveLength(1);
    expect(cache.cached(2 * USAGE_CACHE_MS)).toEqual([]);
    expect(reads).toBe(2);
  });
});

describe("the readout", () => {
  const openHarness = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    return Harness.open(
      new MemoryStorage(),
      createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
      ctx,
    );
  };

  it("shows today's spend, the caps and each provider's windows, and the wire keeps it whole", async () => {
    const harness = await openHarness();
    try {
      const root = await harness.root(ctx);
      await harness.commit((tx) => measureSpend(tx, NOON), ctx);
      await harness.commit(async (tx) => {
        const ledger = await tx.doc(UsageDoc, root.id);
        ledger.models["faux/faux-1"] = {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
        };
        (await tx.doc(Spend)).limit = 1;
        Object.assign(await tx.doc(Proactive), {
          limit: 50,
          cap: { day: "2026-11-23", count: 3, noticeSent: false },
        });
      }, ctx);
      const { fetcher } = fakeFetch(200, goBody("rate-limited"));
      const providers = new ProviderUsageCache(
        usageSources(env({ OPENCODE_API_KEY: "k" })),
        fetcher,
      );
      const readout = await readUsage(harness, providers, NOON);
      expect(readout).toMatchObject({
        day: "2026-11-23",
        cap: 1,
        runs: { used: 3, cap: 50 },
        providers: [{ label: "OpenCode Go", status: "ok" }],
      });
      expect(readout.spent).toBeCloseTo(0.123, 10);
      expect(readout.held).toBeUndefined();
      expect(parseUsageReadout(JSON.parse(JSON.stringify(readout)))).toEqual(readout);

      // The admin status's readout writes nothing and asks no provider: more spend shows only after a measure.
      await harness.commit(async (tx) => {
        const ledger = await tx.doc(UsageDoc, root.id);
        ledger.models["faux/faux-1"]!.cost.total += 1;
      }, ctx);
      const before = await harness.snapshot(Spend, ctx);
      const stored = await readUsage(harness, providers, NOON, { fresh: false });
      expect(stored.spent).toBeCloseTo(0.123, 10);
      expect(stored.providers).toEqual(readout.providers);
      expect(await harness.snapshot(Spend, ctx)).toEqual(before);

      const text = usageText(readout, "America/Chicago").split("\n");
      expect(text[0]).toBe(
        "Today: about $0.12 of the $1.00 daily cap (MiPi's estimate at list prices).",
      );
      expect(text[1]).toBe("Scheduled runs: 3 of 50 rounds.");
      expect(text[2]).toMatch(
        /^OpenCode Go: rolling 12%, limit reached \(resets .+\); weekly 34% \(resets .+\); monthly 100% \(resets .+\)\.$/,
      );
    } finally {
      await harness.close(ctx);
    }
  });

  it("stands alone without a provider reader, and says when work is held", () => {
    const base: UsageReadout = {
      day: "2026-11-23",
      spent: 2,
      runs: { used: 0, cap: 50 },
      providers: [],
    };
    expect(usageText(base, undefined).split("\n")).toEqual([
      "Today: about $2.00 (MiPi's estimate at list prices; no daily cap).",
      "Scheduled runs: 0 of 50 rounds.",
    ]);
    expect(usageText({ ...base, cap: 1, held: "spend-cap" }, undefined)).toContain(
      "Over the spend cap: scheduled runs and background work wait until tomorrow.",
    );
    expect(
      usageText(
        {
          ...base,
          held: "paused",
          providers: [
            {
              provider: "opencode-go",
              label: "OpenCode Go",
              status: "unavailable",
              reason: "down",
            },
          ],
        },
        undefined,
      ).split("\n"),
    ).toEqual([
      "Today: about $2.00 (MiPi's estimate at list prices; no daily cap).",
      "Scheduled runs: 0 of 50 rounds.",
      "MiPi is paused (MIPI_PAUSED).",
      "OpenCode Go: usage unavailable (down).",
    ]);
  });

  it("answers /usage on Telegram, and says so when a door has no readout", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const command = (updateId: number) =>
        ({ kind: "command", updateId, chatId: CHAT, command: "usage", argument: "" }) as const;
      let agent = await openAgent(storage, [], async () => "Today: about $0.00.");
      try {
        await agent.channel.admit(command(1));
        await agent.settle();
        expect(agent.sent.map(({ text }) => text)).toEqual(["Today: about $0.00."]);
        agent = await agent.restart();
        // The same agent, without the door's readout this time.
        await agent.close();
        agent = await openAgent(storage);
        await agent.channel.admit(command(2));
        await agent.settle();
        expect(agent.sent.map(({ text }) => text)).toEqual(["Usage isn't available here."]);
      } finally {
        await agent.close();
      }
    }));
});
