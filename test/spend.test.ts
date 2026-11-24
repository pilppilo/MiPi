/**
 * The daily spend cap and the pause switch (M9, COD-193): today's spend measured from every conversation's `pi.usage`,
 * the cap holding reminders and their runs, and `MIPI_PAUSED` holding everything. MiPi's real harness with a faux
 * model, on Durable Object SQLite (`reminder-agent.ts`).
 */
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Usage } from "@earendil-works/pi-ai";
import { type Harness, UsageDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { afterNextChicagoMidnight, CAP_NOTICE, Proactive } from "../src/agent/proactive.ts";
import {
  holdOf,
  measureSpend,
  PAUSED_REPLY,
  parsePaused,
  parseSpendCap,
  Spend,
  SPEND_NOTICE,
  spentToday,
} from "../src/agent/spend.ts";
import { BATCH_WINDOW_MS } from "../src/agent/telegram.ts";
import { TelegramChannel } from "../src/agent/telegram-state.ts";
import { recordUsage } from "../src/agent/side-calls.ts";
import { chicagoDay } from "../src/lib/cap-day.ts";
import { type ReminderInput, ScheduledReminder } from "../src/tools/reminder-task.ts";
import {
  DeliverScheduledInstruction,
  heldSuccessor,
  type ScheduledInstruction,
} from "../src/tools/schedule-task.ts";
import {
  type Agent,
  CHAT,
  clock,
  ctx,
  inObject,
  openAgent,
  reminders,
  said,
  text,
  userTexts,
  ZONE,
} from "./reminder-agent.ts";

/** Noon in Chicago, so a test's minutes never cross midnight. */
const NOON = Date.UTC(2026, 10, 23, 18, 0);

const usageWorth = (dollars: number): Usage => ({
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: dollars },
});

/** Adds `dollars` to a conversation's `pi.usage`, as a response or a tool would. */
const spendOn = (
  harness: Harness,
  conversationId: number,
  dollars: number,
  bucket: "models" | "tools" = "models",
) =>
  harness.commit(async (tx) => {
    const ledger = await tx.doc(UsageDoc, conversationId as never);
    const key = bucket === "models" ? "faux/faux-1" : "web_fetch";
    const current = ledger[bucket][key];
    if (current === undefined) ledger[bucket][key] = usageWorth(dollars);
    else current.cost.total += dollars;
  }, ctx);

const measure = (harness: Harness, now = clock.now) =>
  harness.commit(async (tx) => ({ ...(await measureSpend(tx, now)) }), ctx);

const setSpend = (harness: Harness, change: { limit?: number; paused?: boolean }) =>
  harness.commit(async (tx) => {
    Object.assign(await tx.doc(Spend), change);
  }, ctx);

const sentTexts = (agent: Agent) => agent.sent.map(({ text: sent }) => sent);
const telegram = { kind: "telegram", chatId: CHAT } as const;

/** A reminder due in a minute. */
async function remind(
  harness: Harness,
  id: string,
  instruction: string,
  destination: ReminderInput["destination"],
  every?: ReminderInput["every"],
): Promise<void> {
  const root = await harness.root(ctx);
  await root.commit(
    (tx) =>
      tx.createTask(
        ScheduledReminder,
        {
          id,
          conversationId: root.id,
          instruction,
          zone: ZONE,
          first: clock.now + 60_000,
          destination,
          ...(every === undefined ? {} : { every }),
        },
        { ownership: { kind: "conversation" }, background: true },
      ),
    ctx,
  );
}

/**
 * A tool round during which `dollars` are spent elsewhere (the faux provider reports no cost of its own): the round's
 * `afterTools` check then measures it.
 */
const toolRoundSpending =
  (spend: () => Promise<unknown>): FauxResponseStep =>
  async () => {
    await spend();
    return fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" });
  };

describe("settings", () => {
  it("reads MIPI_DAILY_SPEND_CAP as dollars, and anything else as no cap", () => {
    expect(parseSpendCap(undefined)).toEqual({});
    expect(parseSpendCap(" ")).toEqual({});
    expect(parseSpendCap("1")).toEqual({ cap: 1 });
    expect(parseSpendCap("0.25")).toEqual({ cap: 0.25 });
    expect(parseSpendCap("0")).toEqual({ cap: 0 });
    // `off` turns a cap from wrangler.jsonc off for a lane.
    expect(parseSpendCap("off")).toEqual({});
    expect(parseSpendCap(" None ")).toEqual({});
    expect(parseSpendCap("$1")).toEqual({ invalid: "$1" });
    expect(parseSpendCap("-1")).toEqual({ invalid: "-1" });
  });

  it("reads MIPI_PAUSED as on or off, and pauses on anything else", () => {
    for (const off of [undefined, "", "0", "false", "No", " off "]) {
      expect(parsePaused(off)).toEqual({ paused: false });
    }
    for (const on of ["1", "true", "YES", "on"]) expect(parsePaused(on)).toEqual({ paused: true });
    expect(parsePaused("maybe")).toEqual({ paused: true, invalid: "maybe" });
  });

  it("holds background work when paused, or once today's spend reaches the cap", () => {
    const day = chicagoDay(NOON);
    expect(holdOf({ spent: 5 }, NOON)).toBeUndefined();
    expect(holdOf({ spent: 0.99, day, limit: 1 }, NOON)).toBeUndefined();
    expect(holdOf({ spent: 1, day, limit: 1 }, NOON)).toBe("spend-cap");
    // Yesterday's spend doesn't hold today.
    expect(holdOf({ spent: 5, day: "2026-11-22", limit: 1 }, NOON)).toBeUndefined();
    expect(holdOf({ spent: 0, paused: true }, NOON)).toBe("paused");
  });
});

describe("measuring", () => {
  it("starts today's count when the agent first opens, with the cap from its settings", () =>
    inObject(async (storage) => {
      // MiPi's own agent opened this object first; this harness reads what its start wrote.
      const agent = await openAgent(storage);
      try {
        const spend = await agent.harness.snapshot(Spend, ctx);
        expect(spend).toMatchObject({ spent: 0, lastTotal: 0, limit: 1 });
        expect(spend?.paused).toBeUndefined();
      } finally {
        await agent.close();
      }
    }));

  it("counts every conversation's spend once, subagents' and tools' too, and never gives it back", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const root = await harness.root(ctx);
        const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
        // A subagent: a conversation owned by a task, as `search_history` makes one.
        const child = await root.commit(async (tx) => {
          const taskId = await tx.createTask(
            ScheduledReminder,
            {
              id: "reminder:owner",
              conversationId: root.id,
              instruction: "Owns a subagent",
              zone: ZONE,
              first: clock.now + 86_400_000,
              destination: telegram,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          return tx.createConversation({ ownership: { kind: "task", taskId } });
        }, ctx);
        expect(child.owner).toBeDefined();

        // Spend before the first measure is nobody's today. (The agent's start measured once; start over.)
        await harness.commit(async (tx) => {
          const state = await tx.doc(Spend);
          delete state.lastTotal;
        }, ctx);
        await spendOn(harness, root.id, 3);
        expect(await measure(harness)).toMatchObject({
          day: chicagoDay(NOON),
          spent: 0,
          lastTotal: 3,
        });

        await spendOn(harness, root.id, 0.1);
        await spendOn(harness, other.id, 0.05, "tools");
        await spendOn(harness, child.id, 0.02);
        // A title's side call counts in its conversation, as the memory pass's does.
        await harness.commit(
          (tx) => recordUsage(tx, other.id, { provider: "faux", id: "title" }, usageWorth(0.01)),
          ctx,
        );
        expect((await measure(harness)).spent).toBeCloseTo(0.18, 10);

        // A conversation's usage gone: nothing given back; later spend counts from where the total now stands.
        await harness.commit(async (tx) => {
          const ledger = await tx.doc(UsageDoc, root.id);
          ledger.models = {};
        }, ctx);
        expect((await measure(harness)).spent).toBeCloseTo(0.18, 10);
        await spendOn(harness, other.id, 0.03);
        expect((await measure(harness)).spent).toBeCloseTo(0.21, 10);
      } finally {
        await agent.close();
      }
    }));

  it("starts afresh at Chicago midnight, on a daylight-saving day too", () =>
    inObject(async (storage) => {
      // Sunday, Nov 1, 2026 is the day the clocks go back in Chicago: 23:30 CST is 05:30 UTC on Nov 2.
      const late = Date.UTC(2026, 10, 2, 5, 30);
      clock.now = late;
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const root = await harness.root(ctx);
        await measure(harness, late);
        await spendOn(harness, root.id, 0.4);
        expect(await measure(harness, late)).toMatchObject({ day: "2026-11-01", spent: 0.4 });
        const next = afterNextChicagoMidnight(late);
        expect(next).toBe(Date.UTC(2026, 10, 2, 6, 0, 1));
        // Before any measure on the new day, it has spent nothing.
        expect(spentToday((await harness.snapshot(Spend, ctx))!, next)).toBe(0);
        await spendOn(harness, root.id, 0.1);
        expect(await measure(harness, next)).toMatchObject({ day: "2026-11-02" });
        expect((await harness.snapshot(Spend, ctx))?.spent).toBeCloseTo(0.1, 10);
      } finally {
        await agent.close();
      }
    }));
});

describe("the spend cap", () => {
  it("sends a one-time Telegram reminder without the model, with one notice, and keeps chat working", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, said("Still here."));
      try {
        const root = await agent.harness.root(ctx);
        await measure(agent.harness);
        await spendOn(agent.harness, root.id, 0.5);
        await setSpend(agent.harness, { limit: 0.4 });
        await remind(agent.harness, "reminder:pills", "Take the pills", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          SPEND_NOTICE,
          "Reminder: Take the pills (sent without MiPi: daily spend cap reached).",
        ]);
        // The owner's own message still goes through; the first one today gets one line saying so.
        await agent.channel.admit(text(1, "Are you there?"));
        await agent.advance(BATCH_WINDOW_MS);
        expect(sentTexts(agent).slice(2)).toEqual([
          expect.stringMatching(/^Heads up: MiPi has spent about \$0\.50 today, over its \$0\.40/),
          "Still here.",
        ]);
        await agent.channel.admit(text(2, "And again?"));
        await agent.advance(BATCH_WINDOW_MS);
        expect(sentTexts(agent).filter((sent) => sent.startsWith("Heads up"))).toHaveLength(1);
      } finally {
        await agent.close();
      }
    }));

  it("doesn't warn about the cap when Telegram sends an earlier message again", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, said("Hi."));
      try {
        const root = await agent.harness.root(ctx);
        await measure(agent.harness);
        await agent.channel.admit(text(1, "Hello"));
        await agent.advance(BATCH_WINDOW_MS);
        // The cap is crossed after that message, then Telegram delivers it again.
        await spendOn(agent.harness, root.id, 0.5);
        await setSpend(agent.harness, { limit: 0.4 });
        await agent.channel.admit(text(1, "Hello"));
        await agent.settle();
        expect(sentTexts(agent)).toEqual(["Hi."]);
      } finally {
        await agent.close();
      }
    }));

  it("skips a held repeat and waits a held web reminder until midnight, without the model", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage);
      try {
        await setSpend(agent.harness, { limit: 0 });
        const root = await agent.harness.root(ctx);
        await remind(agent.harness, "reminder:web", "Water plants", {
          kind: "web",
          conversationId: root.id,
        });
        await remind(agent.harness, "reminder:rep", "Drink water", telegram, { minutes: 60 });
        await agent.advance(60_000);
        const waiting = await reminders(agent.harness);
        expect(waiting.find(({ input }) => input.id === "reminder:web")?.checkpoint).toMatchObject({
          at: afterNextChicagoMidnight(clock.now),
        });
        expect(waiting.find(({ input }) => input.id === "reminder:rep")?.checkpoint).toMatchObject({
          sent: 0,
          skippedCap: 1,
        });
        expect(sentTexts(agent)).toEqual([SPEND_NOTICE]);
        // The run cap never counted a round: nothing ran.
        expect((await agent.harness.snapshot(Proactive, ctx))?.cap?.count ?? 0).toBe(0);
        expect(
          (await userTexts(agent.harness, root.id)).filter((content) =>
            content.startsWith("Scheduled instruction"),
          ),
        ).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("stops a reminder run after the tool round that crossed it, with the spend notice", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      let harness: Harness | undefined;
      let elsewhere: number | undefined;
      const agent = await openAgent(storage, [
        toolRoundSpending(() => spendOn(harness!, elsewhere!, 0.5)),
        ...said("Never reached."),
      ]);
      harness = agent.harness;
      try {
        elsewhere = (await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx))
          .id;
        await measure(harness);
        await setSpend(harness, { limit: 0.4 });
        await remind(harness, "reminder:x", "Watch the pot", telegram);
        await agent.advance(60_000);
        // Admitted under the cap; $0.50 went out during its first tool round, so the run stopped after it.
        expect(sentTexts(agent)).toEqual([SPEND_NOTICE]);
        expect(sentTexts(agent)).not.toContain(CAP_NOTICE);
        expect((await harness.snapshot(Spend, ctx))?.spent).toBeCloseTo(0.5, 10);
      } finally {
        await agent.close();
      }
    }));
});

describe("pause", () => {
  it("refuses Telegram messages before any window opens, and still answers commands", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage);
      try {
        await setSpend(agent.harness, { paused: true });
        await agent.channel.admit(text(1, "Hello?"));
        await agent.channel.admit({
          kind: "command",
          updateId: 2,
          chatId: CHAT,
          command: "version",
          argument: "",
        });
        await agent.settle();
        expect(sentTexts(agent)).toEqual([PAUSED_REPLY, "MiPi 0.0.0-test"]);
        expect((await agent.harness.snapshot(Proactive, ctx))?.pending ?? []).toEqual([]);
        const staged = await agent.harness.commit(
          async (tx) => (await tx.doc(TelegramChannel)).staged ?? [],
          ctx,
        );
        expect(staged).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("refuses a window staged before the pause, when it comes due and on /new", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      // No model response: a run would fail the test.
      const agent = await openAgent(storage);
      try {
        await agent.channel.admit(text(1, "Staged before the pause"));
        await setSpend(agent.harness, { paused: true });
        await agent.advance(BATCH_WINDOW_MS);
        expect(sentTexts(agent)).toEqual([PAUSED_REPLY]);

        await setSpend(agent.harness, { paused: false });
        await agent.channel.admit(text(2, "Staged again"));
        await setSpend(agent.harness, { paused: true });
        await agent.channel.admit({
          kind: "command",
          updateId: 3,
          chatId: CHAT,
          command: "new",
          argument: "",
        });
        await agent.settle();
        expect(sentTexts(agent)).toEqual([
          PAUSED_REPLY,
          PAUSED_REPLY,
          "Started a new conversation.",
        ]);
        const root = await agent.harness.root(ctx);
        expect(await userTexts(agent.harness, root.id)).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("holds every reminder kind without the model and without a notice", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage);
      try {
        await setSpend(agent.harness, { paused: true });
        const root = await agent.harness.root(ctx);
        await remind(agent.harness, "reminder:tg", "Stretch", telegram);
        await remind(agent.harness, "reminder:web", "Water plants", {
          kind: "web",
          conversationId: root.id,
        });
        await remind(agent.harness, "reminder:rep", "Drink water", telegram, { minutes: 60 });
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          "Reminder: Stretch (sent without MiPi: MiPi is paused).",
        ]);
        const waiting = await reminders(agent.harness);
        expect(waiting.find(({ input }) => input.id === "reminder:web")?.checkpoint).toMatchObject({
          at: afterNextChicagoMidnight(clock.now),
        });
        expect(waiting.find(({ input }) => input.id === "reminder:rep")?.checkpoint).toMatchObject({
          sent: 0,
          skippedPaused: 1,
        });
      } finally {
        await agent.close();
      }
    }));

  it("tells the chat that wrote last once when the spend cap holds an older delivery", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, said("Hi."));
      try {
        await agent.channel.admit(text(1, "Hello"));
        await agent.advance(BATCH_WINDOW_MS);
        await setSpend(agent.harness, { limit: 0 });
        const root = await agent.harness.root(ctx);
        await root.commit(
          (tx) =>
            tx.createTask(
              DeliverScheduledInstruction,
              {
                id: "schedule:once",
                conversationId: root.id,
                instruction: "Call mom",
                runAt: clock.now + 60_000,
              },
              { ownership: { kind: "conversation" }, background: true },
            ),
          ctx,
        );
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual(["Hi.", SPEND_NOTICE]);
      } finally {
        await agent.close();
      }
    }));

  it("holds an older scheduled delivery in a successor instead of delivering it", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage);
      try {
        await setSpend(agent.harness, { paused: true });
        const root = await agent.harness.root(ctx);
        const scheduled: ScheduledInstruction = {
          id: "schedule:legacy",
          conversationId: root.id,
          instruction: "Check the mail",
          runAt: clock.now + 60_000,
          recurrence: { cadence: { unit: "day", interval: 1 }, timezone: ZONE },
        };
        await root.commit(
          (tx) =>
            tx.createTask(DeliverScheduledInstruction, scheduled, {
              ownership: { kind: "conversation" },
              background: true,
            }),
          ctx,
        );
        await agent.advance(60_000);
        expect(await userTexts(agent.harness, root.id)).toEqual([]);
        const legacy = (await agent.harness.inspect(ctx)).tasks.filter(
          ({ record }) => record.kind === DeliverScheduledInstruction.definition.name,
        );
        const waiting = legacy.filter(({ record }) => record.state.status !== "terminal");
        expect(waiting.map(({ record }) => (record.input as ScheduledInstruction).id)).toEqual([
          `schedule:legacy~${scheduled.runAt + 86_400_000}`,
        ]);
        // Held again, the id keeps one time, not a chain of them.
        expect(heldSuccessor({ ...scheduled, id: "schedule:legacy~5" }, 9).id).toBe(
          "schedule:legacy~9",
        );
      } finally {
        await agent.close();
      }
    }));
});
