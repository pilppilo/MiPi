import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { composeMipi } from "../src/agent/composition.ts";
import { heldAsMeasured, heldUntil } from "../src/agent/gates.ts";
import { bindLimitRecorder, limitOf, ProviderLimits } from "../src/agent/limits.ts";
import { BACKGROUND_CONTEXT as ctx } from "../src/agent/pi/context.ts";
import { createProviders, ProviderUsageCache } from "../src/agent/providers.ts";
import { Spend } from "../src/agent/spend.ts";
import { readUsage } from "../src/agent/usage.ts";
import { opencodeGoExtension } from "../src/extensions/optional/opencode-go/index.ts";
import { goLimit } from "../src/extensions/optional/opencode-go/limit.ts";
import { afterNextChicagoMidnight, chicagoDay } from "../src/lib/cap-day.ts";
import { parseUsageReadout } from "../src/protocol.ts";

const GO_ERROR =
  '429 {"error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached"}}';
const label = "OpenCode Go";
const provider = "faux";
const now = Date.UTC(2026, 10, 24, 18);

const providerExtension = {
  name: "faux-provider",
  tier: "optional" as const,
  providers: [{ provider, limit: { label, parse: goLimit } }],
};

const sampleBuiltIn = {
  name: "sample",
  tier: "builtin" as const,
  pi: defineExtension({ name: "sample" }),
};

function compose(models = createModels()) {
  return composeMipi({
    models,
    model: { provider, modelId: "faux-1" },
    extensions: [providerExtension, sampleBuiltIn],
  });
}

describe("provider limits", () => {
  it("distinguishes wrapped plan errors from transient 429s and billing, and claims a parser only once", () => {
    const registration = opencodeGoExtension.providers![0]!;
    const providers = createProviders([{ owner: "go", registration }]);
    expect(limitOf(providers, registration.provider, GO_ERROR, now)).toMatchObject({
      kind: "usage",
      label,
    });
    expect(limitOf(providers, registration.provider, "429 Too Many Requests", now)).toMatchObject({
      kind: "rate",
    });
    expect(
      limitOf(providers, registration.provider, "Monthly usage limit reached", now)?.kind,
    ).toBe("usage");
    for (const text of [
      "402 billing: add available balance",
      "401 Unauthorized",
      "400 Bad Request",
    ]) {
      expect(limitOf(providers, registration.provider, text, now)).toBeUndefined();
    }
    expect(limitOf(providers, "other", GO_ERROR, now)).toBeUndefined();
    expect(() =>
      createProviders([
        { owner: "go", registration },
        { owner: "other", registration },
      ]),
    ).toThrow("limit parser is registered by both");
  });

  it("records the error before settlement on a conversation with stored extension edits and clears it after success", async () => {
    await runInDurableObject(
      env.AGENT.getByName("provider-limit-hook"),
      async (_instance, state) => {
        await state.blockConcurrencyWhile(async () => {});
        const faux = fauxProvider();
        faux.setResponses([
          fauxAssistantMessage([], { stopReason: "error", errorMessage: GO_ERROR }),
          fauxAssistantMessage([fauxText("Recovered")]),
        ]);
        const models = createModels();
        models.setProvider(faux.provider);
        const storage = () => openDurableObjectSqliteStorage(state.storage);
        const original = compose(models);
        const options = original.options;
        const settings =
          typeof options.settings === "function" ? options.settings() : options.settings;
        const oldHarness = await Harness.open(
          await storage(),
          {
            ...options,
            settings: {
              ...settings,
              extensions: original.extensions.selection.filter(
                ({ name }) => name !== "provider-limits",
              ),
            },
          },
          ctx,
        );
        const oldRoot = await oldHarness.root(ctx);
        await oldRoot.commit((tx) => original.switchOff(tx, oldRoot.id, ["sample"]), ctx);
        await oldHarness.close(ctx);

        const composition = compose(models);
        const harness = await Harness.open(await storage(), composition.options, ctx);
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const resetAt = now + 45 * 60_000;
        let reads = 0;
        const usage = new ProviderUsageCache([
          {
            provider,
            label,
            read: async () => {
              reads++;
              started.resolve();
              await release.promise;
              return {
                provider,
                label,
                status: "ok",
                windows: [
                  { name: "rolling", percent: 100, limited: true, resetsAt: resetAt - 500 },
                  { name: "weekly", percent: 100, limited: true, resetsAt: resetAt },
                  { name: "monthly", percent: 5, limited: false, resetsAt: resetAt + 500 },
                ],
              };
            },
          },
        ]);
        try {
          bindLimitRecorder(
            composition.limitExtension,
            harness,
            composition.providers,
            usage,
            () => now,
          );
          const root = await harness.root(ctx);
          const submission = await root.submit(
            { type: "input", content: "Try", requestId: "web:limit" },
            ctx,
          );
          const settlement = submission.wait(ctx);
          await started.promise;
          expect((await submission.status(ctx)).status).toBe("placed");
          expect((await harness.snapshot(ProviderLimits, ctx))?.entries[provider]).toBeUndefined();
          release.resolve();
          expect(await settlement).toMatchObject({
            status: "unanswered",
            reason: "model_error",
            detail: GO_ERROR,
          });
          expect((await harness.snapshot(ProviderLimits, ctx))?.entries[provider]).toMatchObject({
            resetAt,
            resetFrom: "usage",
            label,
          });
          const readout = await readUsage(harness, usage, now, { fresh: false });
          expect(parseUsageReadout(JSON.parse(JSON.stringify(readout)))).toMatchObject({
            held: "provider-limit",
            limits: [{ provider, label, resetAt }],
          });
          expect(reads).toBe(1);
          const next = await root.submit(
            { type: "input", content: "Try again", requestId: "web:retry" },
            ctx,
          );
          expect((await next.wait(ctx)).status).toBe("done");
          expect((await harness.snapshot(ProviderLimits, ctx))?.entries).toEqual({});
        } finally {
          release.resolve();
          await harness.close(ctx);
        }
      },
    );
  });

  it("retries a transient 429 without reading usage or persisting a limit, then falls back if a plan reset is unavailable", async () => {
    const faux = fauxProvider();
    const transient = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "429 Too Many Requests",
    });
    faux.setResponses([
      transient,
      transient,
      fauxAssistantMessage([], { stopReason: "error", errorMessage: GO_ERROR }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const composition = compose(models);
    const options = composition.options;
    const settings = typeof options.settings === "function" ? options.settings() : options.settings;
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        ...options,
        settings: { ...settings, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
      },
      ctx,
    );
    let reads = 0;
    const usage = new ProviderUsageCache([
      {
        provider,
        label,
        read: async () => {
          reads++;
          throw new Error("Usage endpoint unavailable");
        },
      },
    ]);
    try {
      bindLimitRecorder(
        composition.limitExtension,
        harness,
        composition.providers,
        usage,
        () => now,
      );
      const root = await harness.root(ctx);
      const rate = await root.submit({ type: "input", content: "Try", requestId: "web:rate" }, ctx);
      expect(await rate.wait(ctx)).toMatchObject({
        status: "unanswered",
        detail: "429 Too Many Requests",
      });
      expect(reads).toBe(0);
      expect(await harness.snapshot(ProviderLimits, ctx)).toBeUndefined();
      const plan = await root.submit(
        { type: "input", content: "Try again", requestId: "web:plan" },
        ctx,
      );
      expect(await plan.wait(ctx)).toMatchObject({ status: "unanswered", detail: GO_ERROR });
      expect(reads).toBe(1);
      expect((await harness.snapshot(ProviderLimits, ctx))?.entries[provider]).toEqual({
        label,
        at: now,
      });
      expect(await harness.commit((tx) => heldUntil(tx, "provider-limit", now), ctx)).toBe(
        now + 5 * 60_000,
      );
    } finally {
      await harness.close(ctx);
    }
  });

  it("uses the latest cap or provider deadline and treats expired records as inactive on read", async () => {
    const harness = await Harness.open(new MemoryStorage(), compose().options, ctx);
    try {
      await harness.commit(async (tx) => {
        Object.assign(await tx.doc(Spend), { limit: 1, day: chicagoDay(now), spent: 1 });
        const limits = await tx.doc(ProviderLimits);
        const midnight = afterNextChicagoMidnight(now);
        limits.entries = {
          faux: { label, at: now },
          other: { label: "Other", at: now, resetAt: midnight - 1 },
        };
        expect(await heldUntil(tx, "spend-cap", now)).toBe(midnight);
        limits.entries.other!.resetAt = midnight + 1;
        expect(await heldUntil(tx, "spend-cap", now)).toBe(midnight + 1);
        expect(await heldAsMeasured(tx, midnight + 1)).toBeUndefined();
        (await tx.doc(Spend)).limit = 0;
      }, ctx);
      expect((await harness.snapshot(ProviderLimits, ctx))?.entries).toHaveProperty("faux");
      const usage = new ProviderUsageCache([]);
      const readout = await readUsage(harness, usage, now, { fresh: false });
      expect(readout.limits?.find((limit) => limit.provider === provider)).not.toHaveProperty(
        "resetAt",
      );
      expect(
        (await readUsage(harness, usage, now + 5 * 60_000, { fresh: false })).limits?.map(
          ({ provider }) => provider,
        ),
      ).toEqual(["other"]);
    } finally {
      await harness.close(ctx);
    }
  });
});
