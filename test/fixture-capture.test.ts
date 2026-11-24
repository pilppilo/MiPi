/**
 * Captures a fixture database (COD-185): an agent's storage with every kind of data this build writes, exported the
 * way the admin API exports it, written to `test/fixtures/db/<version>.json`. Runs only from
 * `node scripts/fixture-capture.ts`; `test/fixtures.test.ts` replays every committed fixture into a fresh agent, so a
 * later build that can't read what this one wrote fails there.
 *
 * The data is made by MiPi's own composition and doors on a faux model: a web conversation that remembered a lesson,
 * a Telegram chat with a sent reply and a repeating reminder (on a clock fixed in the past, so it never fires on replay), a relay exchange, a background memory pass, and the
 * agent's own settings, the spend cap's count among them.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { boundConversation, startingProfile } from "../src/agent/conversations.ts";
import { composeMipi } from "../src/agent/composition.ts";
import { AnswerSettlement } from "../src/agent/answers.ts";
import { PROFILES } from "./mipi.ts";
import { MemoryPassRuntime, MEMORY_IDLE_MS } from "../src/extensions/builtin/memory/memory-pass.ts";
import { ModelList } from "../src/agent/model-list.ts";
import { Proactive } from "../src/agent/proactive.ts";
import { Spend } from "../src/agent/spend.ts";
import { RelayRuntime } from "../src/doors/relay/relay.ts";
import { AgentSettings, withOwnHost } from "../src/agent/settings.ts";
import { TelegramChannelRuntime } from "../src/doors/telegram/channel.ts";
import { stampInput } from "../src/agent/stamp.ts";
import type { ExportHeader, ExportPage, ExportRow } from "../src/agent/maintenance.ts";
import worker from "../src/worker/index.ts";
import { MIPI_VERSION } from "../src/version.ts";

const ctx = BACKGROUND_CONTEXT;
const capturing =
  (env as unknown as { MIPI_CAPTURE_FIXTURE?: string }).MIPI_CAPTURE_FIXTURE === "1";
const fixtures = (env as unknown as { FIXTURES: Fetcher }).FIXTURES;

/** A fixture: an export, as `GET /api/admin/export/*` gives it. */
export type Fixture = { readonly header: ExportHeader; readonly rows: readonly ExportRow[] };

const OWNER = "fixture-capture";
const call = async <T>(method: string, path: string): Promise<T> => {
  const response = await worker.fetch(
    new Request(`https://mipi.example${path}`, {
      method,
      headers: { Authorization: "Bearer test-admin-token" },
    }),
    { ...env, MIPI_OWNER: OWNER } as unknown as Env,
  );
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

async function seed(): Promise<void> {
  const stub = env.AGENT.getByName(OWNER);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.blockConcurrencyWhile(async () => {});
    const faux = fauxProvider();
    // Answers by what was asked, so the doors' order of requests doesn't matter.
    const answer: FauxResponseStep = (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("Done.")]);
      const text = JSON.stringify(last?.content ?? "");
      if (text.includes("long-term memory")) {
        return fauxAssistantMessage([
          fauxText(JSON.stringify({ lessons: ["The owner's passport expires soon."] })),
        ]);
      }
      if (text.includes("Remember that")) {
        return fauxAssistantMessage(
          [fauxToolCall("remember", { text: "The owner drinks tea, not coffee." })],
          { stopReason: "toolUse" },
        );
      }
      if (text.includes("passport")) {
        return fauxAssistantMessage(
          [
            // A repeat, on the harness clock fixed in the past: on replay its time is long gone, so it is skipped as
            // late and sleeps until the next one, never firing. A one-time reminder would come due on a real date
            // and fire on every replay after it.
            fauxToolCall("schedule", {
              instruction: "Remind me to renew the passport",
              when: "every weekday 8:00",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (text.includes("PiDu")) return fauxAssistantMessage([fauxText("Hi PiDu.")]);
      return fauxAssistantMessage([fauxText("OK.")]);
    };
    faux.setResponses(Array.from({ length: 20 }, () => answer));
    const models = createModels();
    models.setProvider(faux.provider);
    // Pi Durable's clock, fixed on a Monday evening long before any replay: the reminder's times are all in the past.
    const harnessClock = Date.UTC(2026, 0, 5, 23, 0);
    const composition = composeMipi({ models, model: { provider: "faux", modelId: "faux-1" } });
    const harness = await Harness.open(
      await openDurableObjectSqliteStorage(state.storage),
      {
        ...composition.options,
        now: () => harnessClock,
      },
      ctx,
    );
    const clock = { now: Date.now() };
    const telegram = new TelegramChannelRuntime({
      harness,
      owner: "jerome",
      timeZone: "America/Chicago",
      profile: startingProfile("telegram", "default"),
      profiles: PROFILES,
      version: MIPI_VERSION,
      modelList: new ModelList(async () => ["deepseek-v4.1-flash"]),
      send: async () => ({ kind: "sent", messageId: 1 }),
      delivery: composition.connectors.delivery,
      armAlarm: async () => {},
      onWakeChange: () => {},
      report: (message, error) => {
        throw new Error(`${message}: ${String(error)}`);
      },
      now: () => clock.now,
    });
    // Core's answer settlement, run by hand below as the alarm would run it before the door.
    const answers = new AnswerSettlement({
      harness,
      connectors: composition.connectors,
      onWakeChange: () => {},
      report: (message, error) => {
        throw new Error(`${message}: ${String(error)}`);
      },
      now: () => clock.now,
    });
    const relay = new RelayRuntime({
      harness,
      timeZone: "America/Chicago",
      profile: startingProfile("relay", "default"),
      profiles: PROFILES,
      armAlarm: async () => {},
      report: (message, error) => {
        throw new Error(`${message}: ${String(error)}`);
      },
    });
    const pass = new MemoryPassRuntime({
      harness,
      models,
      untrustedTools: new Set(["web_fetch"]),
      onWakeChange: () => {},
      report: (message, error) => {
        throw new Error(`${message}: ${String(error)}`);
      },
      now: () => clock.now,
    });
    try {
      await harness.commit(async (tx) => {
        const settings = await tx.doc(AgentSettings);
        settings.timeZone = "America/Chicago";
        settings.ownHosts = withOwnHost(settings.ownHosts, "mipi-staging.example.workers.dev");
        (await tx.doc(Proactive)).limit = 50;
        // The spend cap's day (M9): measured once, with a cap and the notices' days set.
        const spend = await tx.doc(Spend);
        Object.assign(spend, {
          day: "2026-01-01",
          spent: 0.25,
          lastTotal: 0.25,
          limit: 1,
          noticeDay: "2026-01-01",
          ownerNoticeDay: "2026-01-01",
        });
      }, ctx);

      // Bound as the web door binds it, so the fixture holds the `web` channel binding too.
      const webId = await harness.commit(
        (tx) => boundConversation(tx, "web", startingProfile("web", "default"), PROFILES),
        ctx,
      );
      const web = (await harness.conversation(webId, ctx))!;
      await (
        await web.submit(
          {
            type: "input",
            content: stampInput(
              "jerome",
              "I drink tea, not coffee. Remember that.",
              "America/Chicago",
            ),
            requestId: "web:fixture-1",
          },
          ctx,
        )
      ).wait(ctx);

      await telegram.start();
      await telegram.admit({
        kind: "text",
        updateId: 1,
        chatId: 4242,
        text: "Remind me to renew my passport in a month",
      });
      clock.now += 3_000;
      await telegram.flushDue();
      await harness.waitForIdle(ctx);
      await answers.reconcile();
      await telegram.recover();

      expect(await relay.admit("fixture-relay", "Hello from PiDu")).toEqual({
        kind: "done",
        answer: "Hi PiDu.",
      });

      clock.now = Date.now() + MEMORY_IDLE_MS + 60_000;
      await pass.run();
      await harness.waitForIdle(ctx);
    } finally {
      pass.close();
      answers.close();
      telegram.close();
      relay.close();
      await harness.close(ctx);
    }
  });
  await evictDurableObject(stub);
}

describe.skipIf(!capturing)("fixture capture", () => {
  it(`writes ${MIPI_VERSION}.json`, async () => {
    await seed();
    const header = await call<ExportHeader>("POST", "/api/admin/export/begin");
    const rows: ExportRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await call<ExportPage>(
        "GET",
        `/api/admin/export/page${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
      );
      rows.push(...page.rows);
      cursor = page.next === undefined ? undefined : JSON.stringify(page.next);
    } while (cursor !== undefined);
    expect((await call<{ consistent: boolean }>("POST", "/api/admin/export/end")).consistent).toBe(
      true,
    );
    expect(header.meta.app_version).toBe(MIPI_VERSION);

    const fixture: Fixture = { header, rows };
    const written = await fixtures.fetch(`http://fixtures/${MIPI_VERSION}.json`, {
      method: "PUT",
      body: `${JSON.stringify(fixture, null, 1)}\n`,
    });
    expect(written.ok).toBe(true);
  }, 60_000);
});
