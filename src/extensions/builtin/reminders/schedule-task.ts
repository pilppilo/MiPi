import { type ConversationId, defineDoc, defineTask } from "../../../agent/pi/durable.ts";
import { formatScheduledInstruction } from "../../../protocol.ts";
import { connectorsOf } from "../../../agent/connectors.ts";
import { heldUntil, holdNow, providerHoldUntil, tellHeld } from "../../../agent/gates.ts";
import { AgentSettings } from "../../../agent/settings.ts";
import { localTime } from "../../../agent/stamp.ts";
import { isTransientModelFailure, TRANSIENT_REMINDER_COOLDOWN_MS } from "../../../agent/limits.ts";

export type ScheduleCadence = {
  readonly unit: "minute" | "hour" | "day" | "week" | "month";
  readonly interval: number;
};

export type ScheduleRecurrence = {
  readonly cadence: ScheduleCadence;
  /** IANA timezone used to interpret calendar recurrence, including daylight-saving transitions. */
  readonly timezone: string;
};

/** Durable input of one scheduled delivery. */
export type ScheduledInstruction = {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly instruction: string;
  /** Unix timestamp in milliseconds. */
  readonly runAt: number;
  readonly recurrence?: ScheduleRecurrence;
  /** The legacy delivery that created this recurring successor. */
  readonly previousRequestId?: string;
};

type DeliveryState = { phase: "wait" } | { phase: "mark" } | { phase: "deliver" };

type LocalDateTime = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const localFormatters = new Map<string, Intl.DateTimeFormat>();

const localFormatter = (timezone: string): Intl.DateTimeFormat => {
  let formatter = localFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone: timezone,
      calendar: "iso8601",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    localFormatters.set(timezone, formatter);
  }
  return formatter;
};

const localDateTime = (timestamp: number, timezone: string): LocalDateTime => {
  const fields = Object.fromEntries(
    localFormatter(timezone)
      .formatToParts(timestamp)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: fields.year!,
    month: fields.month!,
    day: fields.day!,
    hour: fields.hour!,
    minute: fields.minute!,
    second: fields.second!,
    millisecond: ((timestamp % 1_000) + 1_000) % 1_000,
  };
};

const localEpoch = (value: LocalDateTime): number =>
  Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    value.millisecond,
  );

const sameLocalDateTime = (left: LocalDateTime, right: LocalDateTime): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second &&
  left.millisecond === right.millisecond;

/** Resolve a local wall-clock time using Temporal-compatible DST disambiguation. */
const localDateTimeToEpoch = (value: LocalDateTime, timezone: string): number => {
  const target = localEpoch(value);
  const offsets = new Set<number>();
  for (const distance of [-2 * DAY_MS, -DAY_MS, 0, DAY_MS, 2 * DAY_MS]) {
    const sample = target + distance;
    offsets.add(localEpoch(localDateTime(sample, timezone)) - sample);
  }
  const candidates = [...offsets].map((offset) => target - offset);
  const exact = candidates
    .filter((candidate) => sameLocalDateTime(localDateTime(candidate, timezone), value))
    .sort((left, right) => left - right);
  if (exact.length > 0) return exact[0]!;

  // A skipped spring-forward time moves ahead by the size of the timezone gap.
  const shifted = candidates
    .map((candidate) => ({
      candidate,
      wallClockDelta: localEpoch(localDateTime(candidate, timezone)) - target,
    }))
    .filter(({ wallClockDelta }) => wallClockDelta > 0)
    .sort(
      (left, right) =>
        left.wallClockDelta - right.wallClockDelta || left.candidate - right.candidate,
    );
  if (shifted.length === 0) {
    throw new Error(`Cannot resolve local recurrence deadline in ${timezone}`);
  }
  return shifted[0]!.candidate;
};

const addDays = (value: LocalDateTime, days: number): LocalDateTime => {
  const date = new Date(
    Date.UTC(
      value.year,
      value.month - 1,
      value.day + days,
      value.hour,
      value.minute,
      value.second,
      value.millisecond,
    ),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
};

const addMonths = (value: LocalDateTime, months: number): LocalDateTime => {
  const monthIndex = value.year * 12 + value.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { ...value, year, month, day: Math.min(value.day, lastDay) };
};

/** First recurrence deadline after `now`, advanced from the previous scheduled deadline. */
export function nextRecurrenceRunAt(
  previousRunAt: number,
  recurrence: ScheduleRecurrence,
  now: number,
): number {
  const { interval, unit } = recurrence.cadence;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new Error("recurrence cadence interval must be a positive integer");
  }
  if (unit === "minute" || unit === "hour") {
    const duration = interval * (unit === "minute" ? MINUTE_MS : HOUR_MS);
    const occurrences = Math.max(1, Math.floor((now - previousRunAt) / duration) + 1);
    const next = previousRunAt + occurrences * duration;
    if (!Number.isSafeInteger(next))
      throw new Error("recurrence deadline is outside the safe range");
    return next;
  }

  let local = localDateTime(previousRunAt, recurrence.timezone);
  for (let attempts = 0; attempts < 1_000_000; attempts++) {
    local =
      unit === "month"
        ? addMonths(local, interval)
        : addDays(local, interval * (unit === "week" ? 7 : 1));
    const next = localDateTimeToEpoch(local, recurrence.timezone);
    if (next > now) return next;
    // Continue from the resolved instant so catch-up follows the same sequence as materialized runs.
    local = localDateTime(next, recurrence.timezone);
  }
  throw new Error("recurrence deadline search exceeded its safety limit");
}

/** Deliveries currently running, so `schedule` can reject accidental recursion. */
export const ScheduleDeliveries = defineDoc<{
  active: Array<{
    scheduleId: string;
    conversationId: ConversationId;
    instruction: string;
    runAt: number;
    recurrence?: ScheduleRecurrence;
    successor?: ScheduledInstruction;
  }>;
  transientFailures?: Array<{ requestId: string; until: number }>;
}>({
  kind: "app.schedule-deliveries",
  version: 1,
  scope: "session",
  initial: () => ({ active: [] }),
  // Changed by every delivery for the life of the session: store a small base whenever none is active, as the
  // built-in inbox does, so replay stays short.
  checkpointWhen: (value) => value.active.length === 0,
});

export const DeliverScheduledInstruction = defineTask<ScheduledInstruction, DeliveryState, null>({
  name: "app.deliver-scheduled-instruction",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    // A durable sleep: the task holds no invocation until runAt, and `onWake` moves the alarm.
    wait: (task, runtime, context) =>
      runtime.sleepUntil(task.input.runAt, { phase: "mark" }, context),
    mark: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const deliveries = await tx.doc(ScheduleDeliveries);
        if (!deliveries.active.some(({ scheduleId }) => scheduleId === task.input.id)) {
          deliveries.active.push({
            scheduleId: task.input.id,
            conversationId: task.input.conversationId,
            instruction: task.input.instruction,
            runAt: task.input.runAt,
            ...(task.input.recurrence === undefined ? {} : { recurrence: task.input.recurrence }),
          });
        }
        return { status: "running", checkpoint: { phase: "deliver" } };
      }, context);
    },
    deliver: async (task, runtime, context) => {
      // M9: paused or over the spend cap, the delivery is held as reminders are. This task's checkpoint has no time of
      // its own to wait for, so a successor carries it instead: a repeating schedule's next time, or a one-time one's
      // next look past Chicago midnight. This occurrence is not delivered. One already submitted (a restart in the
      // middle of this phase) is never held: it went out.
      const now = runtime.now();
      let held = false;
      await runtime.commit(async (tx) => {
        if (
          (await tx.submissionByRequest(task.input.conversationId, task.input.id)) !== undefined
        ) {
          return undefined;
        }
        const { conversationId, previousRequestId, recurrence } = task.input;
        const hold = await holdNow(tx, now);
        let runAt: number | undefined;
        if (hold !== undefined) {
          // A pause tells nothing. This older kind has no destination of its own.
          await tellHeld(tx, connectorsOf(runtime.registry).delivery, hold, undefined, now);
          runAt =
            recurrence === undefined ||
            (hold !== "paused" && (await providerHoldUntil(tx, now)) !== undefined)
              ? await heldUntil(tx, hold, now)
              : nextRecurrenceRunAt(task.input.runAt, recurrence, now);
        } else if (recurrence !== undefined && previousRequestId !== undefined) {
          const previous = await tx.submissionByRequest(conversationId, previousRequestId);
          if (previous?.status === "queued" || previous?.status === "placed") {
            runAt = nextRecurrenceRunAt(task.input.runAt, recurrence, now);
          } else if (previous !== undefined && isTransientModelFailure(previous)) {
            const deliveries = await tx.doc(ScheduleDeliveries);
            const known = deliveries.transientFailures?.find(
              ({ requestId }) => requestId === previousRequestId,
            );
            const until = known?.until ?? now + TRANSIENT_REMINDER_COOLDOWN_MS;
            if (known === undefined) {
              rememberTransientFailure(deliveries, previousRequestId, until);
            }
            if (task.input.runAt < until) {
              runAt = nextRecurrenceRunAt(task.input.runAt, recurrence, Math.max(now, until - 1));
            }
          }
        }
        if (runAt === undefined) return undefined;
        held = true;
        await tx.createTask(DeliverScheduledInstruction, heldSuccessor(task.input, runAt), {
          ownership: { kind: "conversation" },
          conversationId: task.input.conversationId,
          background: true,
        });
        removeDelivery(await tx.doc(ScheduleDeliveries), task.input.id);
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
      if (held) return;
      try {
        // A recurring schedule has its own zone; otherwise the owner's, as this agent recorded it.
        let timeZone = task.input.recurrence?.timezone;
        if (timeZone === undefined) {
          await runtime.commit(async (tx) => {
            timeZone = (await tx.doc(AgentSettings)).timeZone;
          }, context);
        }
        const conversation = await runtime.conversation(task.input.conversationId, context);
        if (conversation !== undefined) {
          const submission = await conversation.submit(
            {
              type: "input",
              content: formatScheduledInstruction(task.input, localTime(Date.now(), timeZone)),
              requestId: task.input.id,
              whenBusy: "followUp",
            },
            context,
          );
          const settled = await submission.wait(context);
          const recurrence = task.input.recurrence;
          if (recurrence !== undefined && isTransientModelFailure(settled)) {
            const settledAt = runtime.now();
            await runtime.commit(async (tx) => {
              const deliveries = await tx.doc(ScheduleDeliveries);
              const source = deliveries.active.find(
                ({ scheduleId }) => scheduleId === task.input.id,
              );
              if (source === undefined) return undefined;
              const until = settledAt + TRANSIENT_REMINDER_COOLDOWN_MS;
              rememberTransientFailure(deliveries, task.input.id, until);
              if (source.successor !== undefined) return undefined;
              const at = nextRecurrenceRunAt(task.input.runAt, recurrence, until - 1);
              const successor = {
                ...heldSuccessor(task.input, at),
                previousRequestId: task.input.id,
              };
              await tx.createTask(DeliverScheduledInstruction, successor, {
                ownership: { kind: "conversation" },
                conversationId: task.input.conversationId,
                background: true,
              });
              source.successor = successor;
              return undefined;
            }, context);
          }
        } else {
          runtime.report(
            new Error(
              `Scheduled instruction ${task.input.id} conversation ${task.input.conversationId} is missing`,
            ),
          );
        }
      } finally {
        await runtime.commit(async (tx) => {
          removeDelivery(await tx.doc(ScheduleDeliveries), task.input.id);
          return { status: "running", checkpoint: { phase: "deliver" } };
        }, context);
      }

      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      );
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      removeDelivery(await tx.doc(ScheduleDeliveries), task.input.id);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

/**
 * The same schedule at `runAt`, under an id of its own (its request id): the base id, then `~` and the time. A held
 * successor held again replaces the time rather than growing the id.
 */
export function heldSuccessor(input: ScheduledInstruction, runAt: number): ScheduledInstruction {
  return {
    id: `${input.id.replace(/~\d+$/, "")}~${runAt}`,
    conversationId: input.conversationId,
    instruction: input.instruction,
    runAt,
    ...(input.previousRequestId === undefined
      ? {}
      : { previousRequestId: input.previousRequestId }),
    ...(input.recurrence === undefined
      ? {}
      : {
          recurrence: {
            cadence: {
              unit: input.recurrence.cadence.unit,
              interval: input.recurrence.cadence.interval,
            },
            timezone: input.recurrence.timezone,
          },
        }),
  };
}

function rememberTransientFailure(
  deliveries: { transientFailures?: Array<{ requestId: string; until: number }> },
  requestId: string,
  until: number,
): void {
  const failures = deliveries.transientFailures ?? [];
  if (failures.some((entry) => entry.requestId === requestId)) return;
  deliveries.transientFailures = [...failures, { requestId, until }].slice(-100);
}

const removeDelivery = (
  deliveries: { active: Array<{ scheduleId: string }> },
  scheduleId: string,
): void => {
  const index = deliveries.active.findIndex((delivery) => delivery.scheduleId === scheduleId);
  if (index !== -1) deliveries.active.splice(index, 1);
};
