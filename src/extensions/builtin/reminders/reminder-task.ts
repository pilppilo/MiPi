/**
 * Reminders (M6): one durable task per schedule that sleeps until each time, admits that occurrence as input to the
 * conversation it was made in, and, for a repeat, sleeps again until the next time. The task owns its repeat, so a
 * repeating reminder no longer depends on the model scheduling a successor (the legacy `schedule-task.ts` way, kept
 * for schedules made before this).
 *
 * Where the answer goes was decided when the reminder was made and is stored with it, as a delivery destination: a
 * reminder made from Telegram answers in that private chat, whether or not a browser is open and even after `/new`
 * rebinds the chat; one made on the web stays in its conversation. Core judges and delivers the answer (`proactive.ts`,
 * `delivery.ts`); this task only admits the occurrence and asks the gates first. Each occurrence has its own request id (`sched:<reminder>:<n>`), so a retried
 * admission admits nothing twice. Pattern from pi-pocket src/server/schedules.ts @ 2f060f2 (wait → send, skip while
 * the last one is still queued, late times move to the next).
 */
import { type ConversationId, defineTask } from "../../../agent/pi/durable.ts";
import { isTransientModelFailure, TRANSIENT_REMINDER_COOLDOWN_MS } from "../../../agent/limits.ts";
import { connectorsOf } from "../../../agent/connectors.ts";
import type { DeliveryDestination } from "../../../agent/delivery.ts";
import {
  expectProactive,
  heldUntil,
  measureToday,
  proactiveHold,
  type ProactiveHold,
  tellHeld,
} from "../../../agent/gates.ts";
import { recentProactiveSends, transientReminderUntil } from "../../../agent/proactive.ts";
import { localTime } from "../../../agent/stamp.ts";
import { describeRepeat, nextRepeat, type Repeat } from "../../../lib/when.ts";
import { formatReminder } from "../../../protocol.ts";
import { reminderRequest } from "./requests.ts";

/** A repeat time this late is skipped: past a maintenance pause or a slow alarm, but not hours late. */
export const LATE_WINDOW_MS = 15 * 60_000;
/** Reminders of this agent that may be waiting at once, legacy schedules included. */
export const MAX_ACTIVE_REMINDERS = 25;

/** Where a reminder's answer goes: a delivery destination, opaque here (`delivery.ts`). */
export type ReminderDestination = DeliveryDestination;

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
  /** Repeat times skipped because proactive runs reached the daily cap (M6) or the spend cap (M9). */
  skippedCap?: number;
  /** Repeat times skipped while MiPi was paused (`MIPI_PAUSED`, M9). */
  skippedPaused?: number;
  /** Last submission whose cooldown was checked, including when settlement had not observed it yet. */
  cooldownChecked?: number;
};

/** What a held one-time reminder says where its destination can push, sent as it is without the model. */
const HELD_REASON: Readonly<Record<ProactiveHold, string>> = {
  "run-cap": "daily limit reached",
  "spend-cap": "daily spend cap reached",
  "provider-limit": "the provider's usage limit is reached",
  paused: "MiPi is paused",
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
      // Today's spend first, in a commit of its own: the next one submits, and its submit must be its first write.
      await runtime.commit(async (tx) => {
        await measureToday(tx, now);
        return undefined;
      }, context);
      const { delivery } = connectorsOf(runtime.registry);
      await runtime.commit(async (tx) => {
        // Reads first; the submit is this commit's first table write. Documents may change before it.
        const previous =
          state.sent === 0
            ? undefined
            : await tx.submissionByRequest(
                conversation.id,
                reminderRequest(input.id, state.sent - 1),
              );
        const cooldownChecked = state.cooldownChecked;
        if (
          input.every !== undefined &&
          previous !== undefined &&
          previous.id !== cooldownChecked &&
          isTransientModelFailure(previous)
        ) {
          const until =
            (await transientReminderUntil(tx, previous.id)) ?? now + TRANSIENT_REMINDER_COOLDOWN_MS;
          if (until > now) {
            const at =
              state.at >= until
                ? state.at
                : nextOccurrence(input.every, state.at, until - 1, input.zone);
            return {
              status: "running",
              checkpoint: { ...state, phase: "wait", at, cooldownChecked: previous.id },
            };
          }
        }
        const decision = decideOccurrence({
          repeating: input.every !== undefined,
          at: state.at,
          now,
          previousBusy: previous?.status === "queued" || previous?.status === "placed",
        });
        const requestId = reminderRequest(input.id, state.sent);
        const existing =
          decision === "send"
            ? await tx.submissionByRequest(conversation.id, requestId)
            : undefined;
        let sent = state.sent;
        // pi-ledger L7. The run's first model round is checked here, and counted after the submit. A pause or the
        // spend cap holds it as the run cap does (M9).
        const held: ProactiveHold | undefined =
          decision !== "send" || existing !== undefined ? undefined : await proactiveHold(tx, now);
        if (held !== undefined) {
          const pushable = delivery.canPush(input.destination) ? input.destination : undefined;
          // The owner paused MiPi: no notice. A cap tells once a day.
          await tellHeld(tx, delivery, held, pushable, now);
          if (input.every === undefined) {
            if (pushable !== undefined) {
              // A reminder asked for is never dropped: sent as it is, without the model.
              await delivery.send(
                tx,
                pushable,
                {
                  id: `reminder-capped:${input.id}`,
                  text: `Reminder: ${input.instruction} (sent without MiPi: ${HELD_REASON[held]}).`,
                },
                now,
              );
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }
            // Nowhere to push (the web): it runs once the caps reset, past Chicago midnight (or looks again then, if
            // still paused).
            return {
              status: "running",
              checkpoint: { ...state, phase: "wait", at: await heldUntil(tx, held, now, true) },
            };
          }
        } else if (decision === "send") {
          const content = formatReminder(
            input,
            localTime(now, input.zone),
            input.every === undefined ? undefined : describeRepeat(input.every),
            (await recentProactiveSends(tx)).map(({ sentAt, snippet }) => ({
              at: localTime(sentAt, input.zone),
              snippet,
            })),
          );
          const submissionId =
            existing?.id ??
            (await conversation.admit(tx, {
              type: "input",
              content,
              requestId,
              // Behind whatever runs now, as every door's input; it joins that turn's follow-ups.
              whenBusy: "followUp",
            }));
          if (existing === undefined) {
            // Its answer is judged and delivered when it settles, and its first round is charged now (core).
            await expectProactive(
              tx,
              {
                submissionId,
                sourceId: input.id,
                instruction: input.instruction,
                conversationId: conversation.id,
                destination: input.destination,
                ...(input.every === undefined ? {} : { repeating: true }),
              },
              now,
            );
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
            ...(cooldownChecked === undefined ? {} : { cooldownChecked }),
            skippedBusy: state.skippedBusy + (decision === "skip-busy" ? 1 : 0),
            skippedLate: state.skippedLate + (decision === "skip-late" ? 1 : 0),
            skippedCap:
              (state.skippedCap ?? 0) +
              (held === "run-cap" || held === "spend-cap" || held === "provider-limit" ? 1 : 0),
            ...(held === "paused" || state.skippedPaused !== undefined
              ? { skippedPaused: (state.skippedPaused ?? 0) + (held === "paused" ? 1 : 0) }
              : {}),
          },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
