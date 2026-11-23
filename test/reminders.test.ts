/**
 * Reminders (M6): the schedule tool on MiPi's real harness options, a faux model, Durable Object SQLite, and a test
 * clock the Harness and the Telegram door share (`reminder-agent.ts`).
 */
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { BATCH_WINDOW_MS } from "../src/agent/telegram.ts";
import {
  decideOccurrence,
  LATE_WINDOW_MS,
  MAX_ACTIVE_REMINDERS,
  nextOccurrence,
  ScheduledReminder,
} from "../src/tools/reminder-task.ts";
import { DeliverScheduledInstruction } from "../src/tools/schedule-task.ts";
import {
  boundId,
  CHAT,
  clock,
  ctx,
  inObject,
  openAgent,
  reminders,
  said,
  schedules,
  text,
  userTexts,
  ZONE,
} from "./reminder-agent.ts";

describe("reminders", () => {
  it("delivers a Telegram reminder to its chat with no browser open, across /new and a restart", () =>
    inObject(async (storage) => {
      let agent = await openAgent(storage, [
        schedules({ instruction: "Stretch", when: "in 2m" }),
        ...said("I'll remind you."),
      ]);
      try {
        await agent.channel.admit(text(1, "Remind me in 2 min to stretch"));
        await agent.advance(BATCH_WINDOW_MS);
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["I'll remind you."]);
        const [reminder] = await reminders(agent.harness);
        expect(reminder!.input.destination).toEqual({ kind: "telegram", chatId: CHAT });
        const madeIn = await boundId(agent.harness);
        // The chat moves to a new conversation, and the agent restarts, before the time comes.
        await agent.channel.admit({
          kind: "command",
          updateId: 2,
          chatId: CHAT,
          command: "new",
          argument: "",
        });
        await agent.settle();
        agent = await agent.restart(said("Time to stretch!"));
        await agent.advance(2 * 60_000);
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Time to stretch!" }]);
        // It ran in the conversation it was made in, with no second reminder left.
        const delivered = await userTexts(agent.harness, madeIn);
        expect(delivered.at(-1)).toMatch(
          /^Scheduled instruction due now \(.+\): Stretch\n\n\[Notes for this run\]\n/,
        );
        expect(await reminders(agent.harness)).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("keeps a web reminder in its web conversation", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, [
        schedules({ instruction: "Water the plants", delaySeconds: 60 }),
        ...said("Scheduled.", "Water the plants now."),
      ]);
      try {
        const root = await agent.harness.root(ctx);
        await (
          await root.submit({ type: "input", content: "remind me in a minute" }, ctx)
        ).wait(ctx);
        const [reminder] = await reminders(agent.harness);
        expect(reminder!.input.destination).toEqual({ kind: "web", conversationId: root.id });
        await agent.advance(60_000);
        expect(agent.sent).toEqual([]);
        const context = await root.context(ctx);
        expect(context.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [expect.objectContaining({ text: "Water the plants now." })],
        });
      } finally {
        await agent.close();
      }
    }));

  it("skips a repeat while its last time still runs, and a time that came too late", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const held: FauxResponseStep = async () => {
        await release.promise;
        return fauxAssistantMessage([fauxText("Checked.")]);
      };
      const agent = await openAgent(storage, [held, ...said("Checked again.")]);
      try {
        const root = await agent.harness.root(ctx);
        const start = clock.now;
        await root.commit(
          (tx) =>
            tx.createTask(
              ScheduledReminder,
              {
                id: "reminder:repeat",
                conversationId: root.id,
                instruction: "Check the build",
                zone: ZONE,
                first: start,
                every: { minutes: 10 },
                destination: { kind: "web", conversationId: root.id },
              },
              { ownership: { kind: "conversation" }, background: true },
            ),
          ctx,
        );
        agent.harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 20));
        // 10 minutes on, the first time's turn still runs: this time is skipped, not stacked.
        clock.now = start + 10 * 60_000;
        agent.harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 20));
        let [state] = await reminders(agent.harness);
        expect(state!.checkpoint).toMatchObject({ sent: 1, skippedBusy: 1, skippedLate: 0 });
        expect(state!.checkpoint!.at).toBe(start + 20 * 60_000);
        release.resolve();
        await agent.harness.waitForIdle(ctx);
        // The 20-minute time comes 30 minutes late: skipped, and the next time is the first after now.
        clock.now = start + 50 * 60_000;
        agent.harness.resume();
        await new Promise((resolve) => setTimeout(resolve, 20));
        [state] = await reminders(agent.harness);
        expect(state!.checkpoint).toMatchObject({ sent: 1, skippedBusy: 1, skippedLate: 1 });
        expect(state!.checkpoint!.at).toBe(start + 60 * 60_000);
        expect(
          (await userTexts(agent.harness, root.id)).filter((content) =>
            content.startsWith("Scheduled instruction due now"),
          ),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await agent.close();
      }
    }));

  it(`refuses a new schedule once ${MAX_ACTIVE_REMINDERS} are waiting`, () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, [
        schedules({ instruction: "One too many", delaySeconds: 60 }),
        ...said("That didn't work."),
      ]);
      try {
        const root = await agent.harness.root(ctx);
        await root.commit(async (tx) => {
          for (let index = 0; index < MAX_ACTIVE_REMINDERS; index++) {
            await tx.createTask(
              ScheduledReminder,
              {
                id: `reminder:${index}`,
                conversationId: root.id,
                instruction: `Later ${index}`,
                zone: ZONE,
                first: clock.now + 24 * 60 * 60_000,
                destination: { kind: "web", conversationId: root.id },
              },
              { ownership: { kind: "conversation" }, background: true },
            );
          }
        }, ctx);
        await (await root.submit({ type: "input", content: "and one more" }, ctx)).wait(ctx);
        const results = (await root.context(ctx)).messages.filter(
          (message) => message.role === "toolResult",
        );
        expect(results).toEqual([
          expect.objectContaining({
            isError: true,
            content: [
              expect.objectContaining({ text: expect.stringMatching(/already 25 schedules/) }),
            ],
          }),
        ]);
        expect(await reminders(agent.harness)).toHaveLength(MAX_ACTIVE_REMINDERS);
      } finally {
        await agent.close();
      }
    }));

  it("still delivers a schedule stored by an earlier build", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, said("Done the old way."));
      try {
        const root = await agent.harness.root(ctx);
        const legacy = await root.commit(
          (tx) =>
            tx.createTask(
              DeliverScheduledInstruction,
              {
                id: "schedule:legacy",
                conversationId: root.id,
                instruction: "Old reminder",
                runAt: clock.now - 1,
              },
              { ownership: { kind: "conversation" }, background: true },
            ),
          ctx,
        );
        agent.harness.resume();
        await agent.harness.waitForTask(legacy, ctx);
        await agent.harness.waitForIdle(ctx);
        expect((await userTexts(agent.harness, root.id)).at(-1)).toMatch(
          /^Scheduled instruction due now \(.+\): Old reminder$/,
        );
      } finally {
        await agent.close();
      }
    }));

  it("answers two Telegram reminders that come due in the same wake", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, said("First one.", "Second one."));
      try {
        const root = await agent.harness.root(ctx);
        const due = clock.now + 60_000;
        await root.commit(async (tx) => {
          for (const name of ["a", "b"]) {
            await tx.createTask(
              ScheduledReminder,
              {
                id: `reminder:${name}`,
                conversationId: root.id,
                instruction: `Reminder ${name}`,
                zone: ZONE,
                first: due,
                destination: { kind: "telegram", chatId: CHAT },
              },
              { ownership: { kind: "conversation" }, background: true },
            );
          }
        }, ctx);
        // Only what the door's watchers do, as between alarms: no recover() here.
        clock.now += 60_000;
        agent.harness.resume();
        for (let wait = 0; wait < 100 && agent.sent.length < 2; wait++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(agent.sent.map(({ text: sent }) => sent).sort()).toEqual([
          "First one.",
          "Second one.",
        ]);
      } finally {
        await agent.close();
      }
    }));

  it("keeps a reminder made by a web turn on the web while a Telegram message waits behind it", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const heldSchedule: FauxResponseStep = async () => {
        await release.promise;
        return fauxAssistantMessage(
          [fauxToolCall("schedule", { instruction: "From the web", delaySeconds: 60 })],
          { stopReason: "toolUse" },
        );
      };
      const agent = await openAgent(storage, [
        heldSchedule,
        ...said("Scheduled from the web.", "Answering Telegram."),
      ]);
      try {
        // The chat's conversation exists; a web turn runs in it.
        await agent.channel.admit({
          kind: "command",
          updateId: 1,
          chatId: CHAT,
          command: "version",
          argument: "",
        });
        const conversationId = await boundId(agent.harness);
        const conversation = await agent.harness.conversation(conversationId as never, ctx);
        await conversation!.submit({ type: "input", content: "remind me from the web" }, ctx);
        // A Telegram message arrives while it runs: queued behind it.
        await agent.channel.admit(text(2, "and a question from Telegram"));
        release.resolve();
        await agent.settle();
        const [reminder] = await reminders(agent.harness);
        expect(reminder!.input.destination).toEqual({ kind: "web", conversationId });
        expect(agent.sent.map(({ text: sent }) => sent)).toContain("Answering Telegram.");
      } finally {
        release.resolve();
        await agent.close();
      }
    }));

  it("doesn't let a reminder's own turn make another reminder", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, [
        schedules({ instruction: "Again", delaySeconds: 60 }),
        ...said("Couldn't schedule from here."),
      ]);
      try {
        const root = await agent.harness.root(ctx);
        await root.commit(
          (tx) =>
            tx.createTask(
              ScheduledReminder,
              {
                id: "reminder:once",
                conversationId: root.id,
                instruction: "Schedule yourself again",
                zone: ZONE,
                first: clock.now,
                destination: { kind: "web", conversationId: root.id },
              },
              { ownership: { kind: "conversation" }, background: true },
            ),
          ctx,
        );
        await agent.advance(1);
        const results = (await root.context(ctx)).messages.filter(
          (message) => message.role === "toolResult",
        );
        expect(results).toEqual([expect.objectContaining({ isError: true })]);
        expect(await reminders(agent.harness)).toEqual([]);
      } finally {
        await agent.close();
      }
    }));
});

describe("reminder times", () => {
  const at = Date.UTC(2026, 10, 23, 14);

  it("sends a one-time reminder however late, and skips only repeats", () => {
    const late = at + LATE_WINDOW_MS + 1;
    expect(decideOccurrence({ repeating: false, at, now: late, previousBusy: true })).toBe("send");
    expect(decideOccurrence({ repeating: true, at, now: late, previousBusy: false })).toBe(
      "skip-late",
    );
    expect(
      decideOccurrence({ repeating: true, at, now: at + LATE_WINDOW_MS, previousBusy: false }),
    ).toBe("send");
    expect(decideOccurrence({ repeating: true, at, now: at, previousBusy: true })).toBe(
      "skip-busy",
    );
  });

  it("steps a repeat from its own time to the first one after now", () => {
    expect(nextOccurrence({ minutes: 10 }, at, at, ZONE)).toBe(at + 10 * 60_000);
    // A slightly early alarm (now before the recorded time) never gives that time again.
    expect(nextOccurrence({ minutes: 10 }, at, at - 5_000, ZONE)).toBe(at + 10 * 60_000);
    expect(nextOccurrence({ at: "08:00" }, at, at - 5_000, ZONE)).toBeGreaterThan(at);
    expect(nextOccurrence({ minutes: 10 }, at, at + 35 * 60_000, ZONE)).toBe(at + 40 * 60_000);
    // Thirty days down: the next time, in one step, still on the 10-minute grid from the recorded time.
    const month = 30 * 24 * 60 * 60_000;
    expect(nextOccurrence({ minutes: 10 }, at, at + month + 1, ZONE)).toBe(
      at + month + 10 * 60_000,
    );
    // A windowed repeat after a long pause: the next slot after now, inside its window.
    const windowed = nextOccurrence(
      { minutes: 30, window: { from: "09:00", to: "17:00" } },
      at,
      at + month,
      ZONE,
    );
    expect(windowed).toBeGreaterThan(at + month);
    expect(windowed - (at + month)).toBeLessThanOrEqual(24 * 60 * 60_000);
    // A clock-time repeat stays on the clock: Monday 08:00 Chicago is 14:00Z in November.
    expect(new Date(nextOccurrence({ at: "08:00" }, at, at, ZONE)).toISOString()).toBe(
      "2026-11-24T14:00:00.000Z",
    );
  });
});
