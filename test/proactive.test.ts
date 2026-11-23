/**
 * Proactive runs (M6 part 3): reminders that may stay quiet (`NO_SEND`), what they sent lately, and the daily cap on
 * the model rounds they use. The agent is MiPi's real harness with a faux model (`reminder-agent.ts`).
 */
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  afterNextChicagoMidnight,
  CAP_NOTICE,
  chicagoDay,
  MIXED_FALLBACK,
  parseDailyRunCap,
  Proactive,
  type ProactiveState,
  RECENT_SENDS_KEPT,
  RUN_ROUND_LIMIT,
  takeRound,
} from "../src/agent/proactive.ts";
import { BATCH_WINDOW_MS } from "../src/agent/telegram.ts";
import { isNoSend, visibleAnswer } from "../src/lib/proactive-text.ts";
import { formatReminder, parseScheduledInstruction } from "../src/protocol.ts";
import { type ReminderInput, ScheduledReminder } from "../src/tools/reminder-task.ts";
import {
  type Agent,
  boundId,
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

/** Noon in Chicago, so a test's minutes never cross the cap's midnight. */
const NOON = Date.UTC(2026, 10, 23, 18, 0);

const toolRound = (name = "no_such_tool"): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" });

/** Creates a reminder due in a minute. */
async function remind(
  harness: Harness,
  id: string,
  instruction: string,
  destination: ReminderInput["destination"],
  every?: ReminderInput["every"],
  conversationId?: number,
): Promise<void> {
  const root =
    conversationId === undefined
      ? await harness.root(ctx)
      : (await harness.conversation(conversationId as never, ctx))!;
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

const telegram = { kind: "telegram", chatId: CHAT } as const;
const sentTexts = (agent: Agent) => agent.sent.map(({ text: sent }) => sent);
const proactive = (harness: Harness) => harness.snapshot(Proactive, ctx);
const setLimit = (harness: Harness, limit: number) =>
  harness.commit(async (tx) => {
    (await tx.doc(Proactive)).limit = limit;
  }, ctx);

describe("proactive text", () => {
  it("knows NO_SEND only as the whole visible answer", () => {
    expect(isNoSend("NO_SEND")).toBe(true);
    expect(isNoSend("  NO_SEND\n")).toBe(true);
    expect(isNoSend("<think>nothing new</think>\nNO_SEND")).toBe(true);
    expect(isNoSend("NO_SEND, but the oven is on")).toBe(false);
    expect(isNoSend("no_send")).toBe(false);
    expect(visibleAnswer("<think>x</think> Hello")).toBe("Hello");
  });

  it("gives the model its notes and keeps them out of what the client shows", () => {
    const content = formatReminder(
      { id: "r", instruction: "Check the mail" },
      "Mon, Nov 23, 2026, 12:00 CST",
      "daily at 12:00",
      [{ at: "Mon, Nov 23, 2026, 9:00 CST", snippet: "Two letters came." }],
    );
    expect(content).toContain("answer exactly NO_SEND");
    expect(content).toContain("- Mon, Nov 23, 2026, 9:00 CST: Two letters came.");
    expect(content).toContain("It repeats daily at 12:00");
    expect(parseScheduledInstruction(content)).toBe("Check the mail");
    // One-time reminders carry notes too, and still parse.
    const once = formatReminder({ id: "r", instruction: "Stretch" }, "now");
    expect(parseScheduledInstruction(once)).toBe("Stretch");
    expect(once).not.toContain("Messages scheduled runs sent lately");
  });
});

describe("daily cap", () => {
  it("reads MIPI_DAILY_RUN_CAP strictly", () => {
    expect(parseDailyRunCap(undefined)).toEqual({ cap: 50 });
    expect(parseDailyRunCap(" ")).toEqual({ cap: 50 });
    expect(parseDailyRunCap("0")).toEqual({ cap: 0 });
    expect(parseDailyRunCap("12")).toEqual({ cap: 12 });
    expect(parseDailyRunCap("12abc")).toEqual({ cap: 50, invalid: "12abc" });
    expect(parseDailyRunCap("-1")).toEqual({ cap: 50, invalid: "-1" });
    expect(parseDailyRunCap("1.5")).toEqual({ cap: 50, invalid: "1.5" });
  });

  it("counts rounds per Chicago day and starts again at Chicago midnight", () => {
    const state: ProactiveState = {
      pending: [],
      runs: [],
      stopped: [],
      toolErrors: [],
      recentSends: [],
      limit: 2,
    };
    // 23:30 in Chicago is already the next day in UTC.
    const late = Date.UTC(2026, 10, 24, 5, 30);
    expect(chicagoDay(late)).toBe("2026-11-23");
    expect(takeRound(state, late)).toBe(true);
    expect(takeRound(state, late)).toBe(true);
    expect(takeRound(state, late)).toBe(false);
    expect(state.cap).toEqual({ day: "2026-11-23", count: 2, noticeSent: false });
    const reset = afterNextChicagoMidnight(late);
    expect(reset).toBe(Date.UTC(2026, 10, 24, 6, 0, 1));
    expect(takeRound(state, reset)).toBe(true);
    expect(state.cap).toEqual({ day: "2026-11-24", count: 1, noticeSent: false });
    // Across a DST change: the first Sunday of November 2026 is Nov 1.
    expect(afterNextChicagoMidnight(Date.UTC(2026, 10, 1, 4, 0))).toBe(
      Date.UTC(2026, 10, 1, 5, 0, 1),
    );
    state.limit = 0;
    expect(takeRound(state, reset)).toBe(false);
  });
});

describe("proactive runs", () => {
  it("stays quiet on NO_SEND, with or without thinking, and sends a real answer", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(
        storage,
        said("NO_SEND", "<think>nothing due</think>\nNO_SEND", "The mail came."),
      );
      try {
        await remind(agent.harness, "reminder:a", "Check the oven", telegram);
        await agent.advance(60_000);
        await remind(agent.harness, "reminder:b", "Check the door", telegram);
        await agent.advance(60_000);
        expect(agent.sent).toEqual([]);
        await remind(agent.harness, "reminder:c", "Check the mail", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual(["The mail came."]);
        const state = await proactive(agent.harness);
        expect(state?.pending).toEqual([]);
        expect(state?.recentSends).toEqual([
          expect.objectContaining({
            chatId: CHAT,
            reminderId: "reminder:c",
            snippet: "The mail came.",
          }),
        ]);
        expect(state?.cap).toMatchObject({ count: 3 });
      } finally {
        await agent.close();
      }
    }));

  it("shows the next reminder what was sent lately, bounded, across /new", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const answers = Array.from({ length: RECENT_SENDS_KEPT + 2 }, (_, index) => `Sent ${index}.`);
      const agent = await openAgent(storage, [...said(...answers), ...said("Fresh start.")]);
      try {
        for (const [index] of answers.entries()) {
          await remind(agent.harness, `reminder:${index}`, `Check ${index}`, telegram);
          await agent.advance(60_000);
        }
        const state = await proactive(agent.harness);
        expect(state?.recentSends.map(({ snippet }) => snippet)).toEqual(
          answers.slice(-RECENT_SENDS_KEPT),
        );
        // A new conversation still sees them: they live in the session, not the transcript.
        await agent.channel.admit({
          kind: "command",
          updateId: 1,
          chatId: CHAT,
          command: "new",
          argument: "",
        });
        await agent.settle();
        const root = await agent.harness.root(ctx);
        await remind(agent.harness, "reminder:last", "Check again", telegram);
        await agent.advance(60_000);
        const last = (await userTexts(agent.harness, root.id)).at(-1)!;
        expect(last).toContain(`: Sent ${answers.length - 1}.`);
        expect(last).not.toContain(": Sent 1.\n");
      } finally {
        await agent.close();
      }
    }));

  it("tells the owner when a reminder's tool fails, even if it says NO_SEND", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, [toolRound(), ...said("NO_SEND")]);
      try {
        await remind(agent.harness, "reminder:t", "Check the feed", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          expect.stringMatching(
            /^The reminder "Check the feed" hit a failed tool \(no_such_tool\): /,
          ),
        ]);
        // Both model rounds counted: one at admission, one after the tool round.
        expect((await proactive(agent.harness))?.cap).toMatchObject({ count: 2 });
      } finally {
        await agent.close();
      }
    }));

  it("sends a reminder's real answer along with its failed-tool notice", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, [toolRound(), ...said("The feed is down.")]);
      try {
        await remind(agent.harness, "reminder:t", "Check the feed", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          expect.stringMatching(
            /^The reminder "Check the feed" hit a failed tool \(no_such_tool\): .+\n\nThe feed is down\.$/s,
          ),
        ]);
      } finally {
        await agent.close();
      }
    }));

  it("never drops a reminder whose answer is only thinking", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, said("<think>only thinking</think>"));
      try {
        await remind(agent.harness, "reminder:e", "Stretch", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual(['The reminder "Stretch" ran but produced no answer.']);
      } finally {
        await agent.close();
      }
    }));

  it("answers a message and a reminder that shared a run once, never with NO_SEND", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const release = Promise.withResolvers<void>();
      const held: FauxResponseStep = async () => {
        await release.promise;
        return fauxAssistantMessage([fauxText("About your message…")]);
      };
      const agent = await openAgent(storage, [held, ...said("NO_SEND")]);
      try {
        await agent.channel.admit(text(1, "Hi"));
        clock.now += BATCH_WINDOW_MS;
        agent.harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await agent.channel.recover();
        // A second message and a reminder of the chat's conversation arrive while the first turn runs: they wait
        // together and get one answer.
        await agent.channel.admit(text(2, "And another thing"));
        await remind(
          agent.harness,
          "reminder:m",
          "Check the oven",
          telegram,
          undefined,
          await boundId(agent.harness),
        );
        clock.now += 60_000;
        agent.harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 20));
        release.resolve();
        await agent.settle();
        expect(sentTexts(agent)).toEqual(["About your message…", MIXED_FALLBACK]);
      } finally {
        release.resolve();
        await agent.close();
      }
    }));

  it(`stops a reminder after ${RUN_ROUND_LIMIT} rounds and says so`, () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(
        storage,
        Array.from({ length: RUN_ROUND_LIMIT + 2 }, () => toolRound()),
      );
      try {
        await remind(agent.harness, "reminder:loop", "Keep looking", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          `The reminder "Keep looking" stopped after ${RUN_ROUND_LIMIT} rounds.`,
        ]);
        expect((await proactive(agent.harness))?.cap).toMatchObject({ count: RUN_ROUND_LIMIT });
      } finally {
        await agent.close();
      }
    }));

  it("stops at the daily cap with one notice, across a restart, and keeps chat working", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      let agent = await openAgent(storage, [toolRound(), toolRound(), ...said("Hello there.")]);
      try {
        await setLimit(agent.harness, 2);
        await remind(agent.harness, "reminder:x", "Watch the pot", telegram);
        await agent.advance(60_000);
        // Admission took round 1, the first tool round round 2; the second tool round hit the cap.
        expect(sentTexts(agent)).toEqual([CAP_NOTICE]);
        expect((await proactive(agent.harness))?.cap).toEqual({
          day: chicagoDay(clock.now),
          count: 2,
          noticeSent: true,
        });

        agent = await agent.restart(said("Still here."));
        // A one-time reminder at the cap is sent as it is, without the model, and no second notice.
        await remind(agent.harness, "reminder:y", "Take the pills", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          "Reminder: Take the pills (sent without MiPi: daily limit reached).",
        ]);
        // Chat doesn't count against the cap.
        await agent.channel.admit(text(2, "Are you there?"));
        await agent.advance(BATCH_WINDOW_MS);
        expect(sentTexts(agent).at(-1)).toBe("Still here.");
        expect(await reminders(agent.harness)).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("sends a second capped Telegram reminder without waiting for the next alarm", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage);
      try {
        await setLimit(agent.harness, 0);
        await remind(agent.harness, "reminder:1", "First pill", telegram);
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual([
          CAP_NOTICE,
          "Reminder: First pill (sent without MiPi: daily limit reached).",
        ]);
        // The day's notice is spent, so this commit changes only the outbox.
        await remind(agent.harness, "reminder:2", "Second pill", telegram);
        clock.now += 60_000;
        agent.harness.resume();
        // Only what the door's watchers do, as between alarms: no recover() here.
        for (let wait = 0; wait < 100 && agent.sent.length < 3; wait++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(sentTexts(agent).at(-1)).toBe(
          "Reminder: Second pill (sent without MiPi: daily limit reached).",
        );
      } finally {
        await agent.close();
      }
    }));

  it("sends a capped web reminder's notice to the chat that wrote last", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, said("Hi."));
      try {
        await agent.channel.admit(text(1, "Hello"));
        await agent.advance(BATCH_WINDOW_MS);
        await setLimit(agent.harness, 0);
        const root = await agent.harness.root(ctx);
        await remind(agent.harness, "reminder:w", "Water plants", {
          kind: "web",
          conversationId: root.id,
        });
        await agent.advance(60_000);
        expect(sentTexts(agent)).toEqual(["Hi.", CAP_NOTICE]);
      } finally {
        await agent.close();
      }
    }));

  it("waits a capped web reminder until the cap resets, and skips a capped repeat", () =>
    inObject(async (storage) => {
      clock.now = NOON;
      const agent = await openAgent(storage, said("Done on the web."));
      try {
        await setLimit(agent.harness, 0);
        const root = await agent.harness.root(ctx);
        await remind(agent.harness, "reminder:web", "Water plants", {
          kind: "web",
          conversationId: root.id,
        });
        await remind(agent.harness, "reminder:rep", "Drink water", telegram, { minutes: 60 });
        await agent.advance(60_000);
        const waiting = await reminders(agent.harness);
        const web = waiting.find(({ input }) => input.id === "reminder:web");
        expect(web?.checkpoint).toMatchObject({
          // Asleep until a second past midnight; it sends when it wakes.
          at: afterNextChicagoMidnight(clock.now),
        });
        const repeat = waiting.find(({ input }) => input.id === "reminder:rep");
        expect(repeat?.checkpoint).toMatchObject({ sent: 0, skippedCap: 1 });
        // No model ran. The web reminder was blocked first with no chat to tell, so the notice waited for the repeat's.
        expect(sentTexts(agent)).toEqual([CAP_NOTICE]);
        expect((await proactive(agent.harness))?.cap).toMatchObject({ count: 0, noticeSent: true });
        const scheduled = async () =>
          (await userTexts(agent.harness, root.id)).filter((content) =>
            content.startsWith("Scheduled instruction"),
          );
        expect(await scheduled()).toEqual([]);

        // The next Chicago day, with room again: the web reminder runs.
        await setLimit(agent.harness, 5);
        clock.now = web!.checkpoint!.at as number;
        agent.harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await agent.settle();
        expect(await scheduled()).toEqual([expect.stringContaining(": Water plants\n")]);
        expect((await proactive(agent.harness))?.cap).toMatchObject({
          day: chicagoDay(clock.now),
          count: 1,
        });
      } finally {
        await agent.close();
      }
    }));
});
