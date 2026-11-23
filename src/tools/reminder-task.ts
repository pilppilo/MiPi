/**
 * Reminders (M6): one durable task per schedule that sleeps until each time, admits that occurrence as input to the
 * conversation it was made in, and, for a repeat, sleeps again until the next time. The task owns its repeat, so a
 * repeating reminder no longer depends on the model scheduling a successor (the legacy `schedule-task.ts` way, kept
 * for schedules made before this).
 *
 * Where the answer goes was decided when the reminder was made and is stored with it: a reminder made from Telegram
 * answers in that private chat, whether or not a browser is open and even after `/new` rebinds the chat; one made on
 * the web stays in its conversation. Each occurrence has its own request id (`sched:<reminder>:<n>`), so a retried
 * admission admits nothing twice. Pattern from pi-pocket src/server/schedules.ts @ 2f060f2 (wait → send, skip while
 * the last one is still queued, late times move to the next).
 */
import { type ConversationId, defineTask } from "../agent/pi/durable.ts";
import { localTime } from "../agent/stamp.ts";
import {
  afterNextChicagoMidnight,
  hasRound,
  noticeCap,
  Proactive,
  type ReminderDestination,
  takeRound,
} from "../agent/proactive.ts";
import { TelegramChannel } from "../agent/telegram-state.ts";
import { enqueueReply, TelegramOutbox } from "../agent/telegram-outbox.ts";
import { reminderRequest } from "../lib/requests.ts";
import { describeRepeat, nextRepeat, type Repeat } from "../lib/when.ts";
import { formatReminder } from "../protocol.ts";

/** A repeat time this late is skipped: past a maintenance pause or a slow alarm, but not hours late. */
export const LATE_WINDOW_MS = 15 * 60_000;
/** Reminders of this agent that may be waiting at once, legacy schedules included. */
export const MAX_ACTIVE_REMINDERS = 25;

export type { ReminderDestination } from "../agent/proactive.ts";

export type ReminderInput = {
  readonly id: string;
  /** The conversation it was made in, where every occurrence is admitted. */
  readonly conversationId: ConversationId;
  readonly instruction: string;
  /** The owner's zone when it was made: clock-time repeats follow it across daylight saving. */
  readonly zone: string;
  /** The first time, on the Harness clock. */
  readonly first: number;
  readonly every?: Repeat;
  readonly destination: ReminderDestination;
};

type ReminderProgress = {
  /** The time this occurrence is for. */
  at: number;
  /** Occurrences admitted so far; the next one's request id uses it. */
  sent: number;
  /** Repeat times skipped because the last occurrence was still queued or running. */
  skippedBusy: number;
  /** Repeat times skipped because they came more than `LATE_WINDOW_MS` late. */
  skippedLate: number;
  /** Repeat times skipped because proactive runs reached the daily cap (M6). */
  skippedCap?: number;
};

/** A phase sees only its own checkpoint, so the phases are a tagged union. */
export type ReminderState =
  | ({ phase: "wait" } & ReminderProgress)
  | ({ phase: "send" } & ReminderProgress);

export type OccurrenceDecision = "send" | "skip-late" | "skip-busy";

/**
 * What one due time does. A one-time reminder always goes out, however late (a short pause must not lose "remind me
 * in 2 min"). A repeat skips a time that came too late, or while its last occurrence still waits or runs, so repeats
 * never stack up.
 */
export function decideOccurrence(options: {
  readonly repeating: boolean;
  readonly at: number;
  readonly now: number;
  readonly previousBusy: boolean;
}): OccurrenceDecision {
  if (!options.repeating) return "send";
  if (options.now - options.at > LATE_WINDOW_MS) return "skip-late";
  return options.previousBusy ? "skip-busy" : "send";
}

/**
 * The first repeat time after `now`, in constant time, however long the agent was down. A plain interval keeps its
 * phase from the recorded time; a clock time or a windowed interval is anchored to the wall clock, so the next one
 * after `now` (or after the recorded time, when that is later) is the right one.
 */
export function nextOccurrence(every: Repeat, at: number, now: number, zone: string): number {
  // `Repeat` is when.ts's shape, which has no tag: a plain interval has `minutes` and no window.
  if ("minutes" in every && every.window === undefined) {
    const step = every.minutes * 60_000;
    return at + (Math.max(0, Math.floor((now - at) / step)) + 1) * step;
  }
  return nextRepeat(every, Math.max(at, now), zone);
}

export const ScheduledReminder = defineTask<ReminderInput, ReminderState, null>({
  name: "app.reminder",
  version: 1,
  initial: (input) => ({ phase: "wait", at: input.first, sent: 0, skippedBusy: 0, skippedLate: 0 }),
  phases: {
    // A durable sleep: no invocation is held until the time, and `onWake` moves the alarm.
    wait: (task, runtime, context) => {
      const state = task.state.checkpoint;
      return runtime.sleepUntil(state.at, { ...state, phase: "send" }, context);
    },
    send: async (task, runtime, context) => {
      const { input } = task;
      const state = task.state.checkpoint;
      const conversation = await runtime.conversation(input.conversationId, context);
      if (conversation === undefined) {
        runtime.report(
          new Error(`Reminder ${input.id}'s conversation ${input.conversationId} is gone`),
        );
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
        return;
      }
      const now = runtime.now();
      await runtime.commit(async (tx) => {
        // Reads first; the submit is this commit's first table write. Documents may change before it.
        const previous =
          state.sent === 0
            ? undefined
            : await tx.submissionByRequest(
                conversation.id,
                reminderRequest(input.id, state.sent - 1),
              );
        const decision = decideOccurrence({
          repeating: input.every !== undefined,
          at: state.at,
          now,
          previousBusy: previous?.status === "queued" || previous?.status === "placed",
        });
        const proactive = await tx.doc(Proactive);
        const requestId = reminderRequest(input.id, state.sent);
        const existing =
          decision === "send"
            ? await tx.submissionByRequest(conversation.id, requestId)
            : undefined;
        let sent = state.sent;
        // pi-ledger L7. The run's first model round is checked here, and counted after the submit.
        const capped = decision === "send" && existing === undefined && !hasRound(proactive, now);
        if (capped) {
          const chat = input.destination.kind === "telegram" ? input.destination.chatId : undefined;
          noticeCap(
            proactive,
            await tx.doc(TelegramChannel),
            await tx.doc(TelegramOutbox),
            chat,
            now,
          );
          if (input.every === undefined) {
            if (chat !== undefined) {
              // A reminder asked for is never dropped: sent as it is, without the model.
              enqueueReply(
                await tx.doc(TelegramOutbox),
                {
                  id: `reminder-capped:${input.id}`,
                  chatId: chat,
                  text: `Reminder: ${input.instruction} (sent without MiPi: daily limit reached).`,
                },
                now,
              );
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }
            // On the web: it runs once the cap resets, past Chicago midnight.
            return {
              status: "running",
              checkpoint: { ...state, phase: "wait", at: afterNextChicagoMidnight(now) },
            };
          }
        } else if (decision === "send") {
          const content = formatReminder(
            input,
            localTime(now, input.zone),
            input.every === undefined ? undefined : describeRepeat(input.every),
            proactive.recentSends.map(({ sentAt, snippet }) => ({
              at: localTime(sentAt, input.zone),
              snippet,
            })),
          );
          const submissionId =
            existing?.id ??
            (await conversation.submit(tx, {
              type: "input",
              content,
              requestId,
              // Behind whatever runs now, as every door's input; it joins that turn's follow-ups.
              whenBusy: "followUp",
            }));
          if (existing === undefined) {
            // Its answer is judged and delivered when it settles (`proactive.ts`).
            const pending = await tx.doc(Proactive);
            takeRound(pending, now);
            pending.pending = [
              ...pending.pending,
              {
                submissionId,
                reminderId: input.id,
                instruction: input.instruction,
                conversationId: conversation.id,
                destination:
                  input.destination.kind === "telegram"
                    ? { kind: "telegram", chatId: input.destination.chatId }
                    : { kind: "web", conversationId: input.destination.conversationId },
              },
            ];
          }
          sent += 1;
        }
        if (input.every === undefined) {
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }
        return {
          status: "running",
          checkpoint: {
            phase: "wait",
            at: nextOccurrence(input.every, state.at, now, input.zone),
            sent,
            skippedBusy: state.skippedBusy + (decision === "skip-busy" ? 1 : 0),
            skippedLate: state.skippedLate + (decision === "skip-late" ? 1 : 0),
            skippedCap: (state.skippedCap ?? 0) + (capped ? 1 : 0),
          },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
