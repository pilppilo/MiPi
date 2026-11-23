import { int, obj, opt, str } from "../agent/pi/schema.ts";
import { defineDoc, type ToolRegistration } from "../agent/pi/durable.ts";
import {
  DeliverScheduledInstruction,
  nextRecurrenceRunAt,
  type ScheduleRecurrence,
  type ScheduledInstruction,
  ScheduleDeliveries,
} from "./schedule-task.ts";
import { MAX_PROMPT_CHARACTERS } from "../protocol.ts";
import { AgentSettings } from "../agent/settings.ts";
import { DEFAULT_TIME_ZONE } from "../agent/stamp.ts";
import { TelegramChannel } from "../agent/telegram-state.ts";
import { describeMoment, describeRepeat, parseWhen, type Repeat, WHEN_HELP } from "../lib/when.ts";
import {
  MAX_ACTIVE_REMINDERS,
  type ReminderDestination,
  type ReminderInput,
  ScheduledReminder,
} from "./reminder-task.ts";

export const SCHEDULE_TOOL_NAME = "schedule";

const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;
const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** The schedule a tool task created, so a safe replay returns it instead of creating another. */
const ScheduleIntent = defineDoc<{ scheduled?: ScheduledInstruction; reminder?: ReminderInput }>({
  kind: "app.schedule-intent",
  version: 1,
  scope: "task",
  initial: () => ({}),
  // Written once per tool task.
  checkpointWhen: () => false,
});

type ScheduleArguments = {
  readonly instruction: string;
  readonly delaySeconds?: number;
  readonly at?: string;
  readonly when?: string;
  readonly sourceScheduleId?: string;
};

/** The first time and, for a repeat, the repeat, from exactly one of `delaySeconds`, `at` and `when`. */
function resolveWhen(
  args: ScheduleArguments,
  now: number,
  zone: string,
): { readonly first: number; readonly every?: Repeat } {
  const given = [args.delaySeconds, args.at, args.when].filter((value) => value !== undefined);
  if (given.length !== 1) throw new Error("Provide exactly one of delaySeconds, at, or when");
  if (args.when !== undefined) {
    const parsed = parseWhen(args.when, now, zone);
    if (parsed.rest.length > 0) {
      throw new Error(`when must be only the time, without "${parsed.rest}". ${WHEN_HELP}`);
    }
    return parsed.every === undefined
      ? { first: parsed.next }
      : { first: parsed.next, every: parsed.every };
  }
  return { first: resolveRunAt(args, now) };
}

function resolveRunAt({ delaySeconds, at }: ScheduleArguments, now: number): number {
  if (delaySeconds !== undefined) return now + delaySeconds * 1000;
  const runAt = TIMEZONE_SUFFIX.test(at!) ? Date.parse(at!) : Number.NaN;
  if (!Number.isFinite(runAt)) {
    throw new Error("at must be an ISO 8601 date-time with a timezone offset");
  }
  if (runAt <= now) throw new Error("at must be in the future");
  if (runAt > now + MAX_DELAY_SECONDS * 1000) throw new Error("at is too far in the future");
  return runAt;
}

function copyScheduledInstruction(scheduled: ScheduledInstruction): ScheduledInstruction {
  return {
    id: scheduled.id,
    conversationId: scheduled.conversationId,
    instruction: scheduled.instruction,
    runAt: scheduled.runAt,
    ...(scheduled.recurrence === undefined
      ? {}
      : {
          recurrence: {
            cadence: {
              unit: scheduled.recurrence.cadence.unit,
              interval: scheduled.recurrence.cadence.interval,
            },
            timezone: scheduled.recurrence.timezone,
          },
        }),
  };
}

const reminderResult = (reminder: ReminderInput, now: number) => {
  const where =
    reminder.destination.kind === "telegram" ? "this Telegram chat" : "this conversation";
  const when =
    reminder.every === undefined
      ? describeMoment(reminder.first, reminder.zone, now)
      : `${describeRepeat(reminder.every)}, first ${describeMoment(reminder.first, reminder.zone, now)}`;
  return {
    output: [
      {
        type: "text" as const,
        text: `Scheduled ${when} (${reminder.zone}): ${where} will receive ${JSON.stringify(reminder.instruction)}. It runs on its own${reminder.every === undefined ? "" : " every time"}; nothing further is needed now.`,
      },
    ],
    details: {
      id: reminder.id,
      instruction: reminder.instruction,
      first: new Date(reminder.first).toISOString(),
      ...(reminder.every === undefined ? {} : { every: describeRepeat(reminder.every) }),
      destination: reminder.destination.kind,
    },
  };
};

/**
 * Where a reminder made now answers: the Telegram chat whose message this run is answering, when there is one (its
 * input waits in the door's state until answered), otherwise the conversation itself, on the web.
 */
function destinationOf(
  channel:
    | {
        readonly inputs: readonly {
          readonly updateId?: number;
          readonly chatId: number;
          readonly conversationId: number;
        }[];
      }
    | undefined,
  conversationId: number,
): ReminderDestination {
  const telegram = channel?.inputs.find(
    (input) => input.conversationId === conversationId && input.updateId !== undefined,
  );
  return telegram === undefined
    ? { kind: "web", conversationId }
    : { kind: "telegram", chatId: telegram.chatId };
}

const scheduleResult = (scheduled: ScheduledInstruction, now: number) => {
  const runAt = new Date(scheduled.runAt).toISOString();
  const seconds = Math.max(0, Math.round((scheduled.runAt - now) / 1000));
  return {
    output: [
      {
        type: "text" as const,
        text: `Scheduled. At ${runAt} (in ${seconds} seconds) this conversation will receive: ${JSON.stringify(scheduled.instruction)}. Nothing further is needed now.`,
      },
    ],
    details: {
      id: scheduled.id,
      instruction: scheduled.instruction,
      runAt,
      ...(scheduled.recurrence === undefined ? {} : { recurrence: scheduled.recurrence }),
    },
  };
};

/**
 * Creates a delivery task that sleeps until its deadline. The Harness reports the sleep through `onWake`, so the
 * tool does not touch the Durable Object alarm.
 */
export const scheduleTool: ToolRegistration = {
  name: SCHEDULE_TOOL_NAME,
  description:
    "Schedule an instruction to be delivered at a later time, once or repeating. It arrives where the request came from (this Telegram chat, or this conversation on the web) as input, and is carried out with the normal tools. A repeat schedules itself every time. Use this whenever the user wants something to happen later; scheduling is the complete response to such a request.",
  parameters: obj({
    instruction: str({
      minLength: 1,
      maxLength: MAX_PROMPT_CHARACTERS,
      description:
        "What to do when the schedule fires, phrased as a self-contained request without timing words, e.g. 'Remind me to call the dentist'",
    }),
    delaySeconds: opt(
      int({
        minimum: 1,
        maximum: MAX_DELAY_SECONDS,
        description: "Run after this many seconds. Use for relative times such as 'in 10 minutes'",
      }),
    ),
    at: opt(
      str({
        description:
          "Run at this ISO 8601 date-time with a timezone offset, e.g. 2026-10-01T09:00:00+02:00. Use for absolute times",
      }),
    ),
    when: opt(
      str({
        minLength: 1,
        maxLength: 200,
        description: `When, in the owner's time zone, as people say it; use for repeats. ${WHEN_HELP} Repeats are at least 10 minutes apart. Provide exactly one of delaySeconds, at, or when`,
      }),
    ),
    sourceScheduleId: opt(
      str({
        description:
          "Only for an older recurring instruction whose delivery asks for it: the schedule ID given in that delivery. Omit delaySeconds, at, and when because the source determines them",
      }),
    ),
  }),
  replay: "safe",
  execute: async (args: ScheduleArguments, api, context) => {
    const intent = await api.snapshot(ScheduleIntent, api.taskId, context);
    if (intent?.reminder !== undefined) return reminderResult(intent.reminder, api.now());
    if (intent?.scheduled !== undefined) return scheduleResult(intent.scheduled, api.now());

    // Deadlines are stored on the Harness clock, which the sleeping delivery task wakes on.
    const now = api.now();
    let persisted: ScheduledInstruction;
    if (args.sourceScheduleId !== undefined) {
      if (args.delaySeconds !== undefined || args.at !== undefined || args.when !== undefined) {
        throw new Error(
          "A recurring successor derives its deadline and recurrence from sourceScheduleId; omit delaySeconds, at, and when",
        );
      }
      persisted = await api.commit(async (tx) => {
        const deliveries = await tx.doc(ScheduleDeliveries);
        const source = deliveries.active.find(
          (delivery) =>
            delivery.conversationId === api.conversationId &&
            delivery.scheduleId === args.sourceScheduleId,
        );
        if (source === undefined) {
          throw new Error("sourceScheduleId does not identify an active scheduled delivery");
        }
        if (source.recurrence === undefined) {
          throw new Error("the source schedule has no structured recurrence policy");
        }
        if (source.successor !== undefined) return copyScheduledInstruction(source.successor);
        const sourceRecurrence: ScheduleRecurrence = {
          cadence: {
            unit: source.recurrence.cadence.unit,
            interval: source.recurrence.cadence.interval,
          },
          timezone: source.recurrence.timezone,
        };
        const scheduled: ScheduledInstruction = {
          id: `schedule:${api.taskId}`,
          conversationId: api.conversationId,
          instruction: source.instruction,
          runAt: nextRecurrenceRunAt(source.runAt, sourceRecurrence, now),
          recurrence: sourceRecurrence,
        };
        source.successor = scheduled;
        await tx.createTask(DeliverScheduledInstruction, scheduled, {
          ownership: { kind: "conversation" },
          conversationId: api.conversationId,
          background: true,
        });
        return scheduled;
      }, context);
    } else {
      const zone = (await api.snapshot(AgentSettings, context))?.timeZone ?? DEFAULT_TIME_ZONE;
      const timing = resolveWhen(args, now, zone);
      const deliveries = await api.snapshot(ScheduleDeliveries, context);
      if (
        deliveries?.active.some(({ conversationId }) => conversationId === api.conversationId) ===
        true
      ) {
        throw new Error(
          "schedule may run during a scheduled delivery only to create its recurring successor",
        );
      }
      const requested: ReminderInput = {
        id: `reminder:${api.taskId}`,
        conversationId: api.conversationId,
        instruction: args.instruction,
        zone,
        first: timing.first,
        ...(timing.every === undefined ? {} : { every: timing.every }),
        destination: destinationOf(
          await api.snapshot(TelegramChannel, context),
          api.conversationId,
        ),
      };
      const reminder = await api.commit(async (tx) => {
        const intent = await tx.doc(ScheduleIntent, api.taskId);
        if (intent.reminder !== undefined) return intent.reminder;
        if ((await activeReminders(tx)) >= MAX_ACTIVE_REMINDERS) {
          throw new Error(
            `There are already ${MAX_ACTIVE_REMINDERS} schedules waiting, the most there may be. One has to run or be cancelled first.`,
          );
        }
        intent.reminder = requested;
        await tx.createTask(ScheduledReminder, requested, {
          ownership: { kind: "conversation" },
          conversationId: api.conversationId,
          background: true,
        });
        return requested;
      }, context);
      return reminderResult(reminder, now);
    }
    return scheduleResult(persisted, now);
  },
};

type ScanTx = Parameters<Parameters<Parameters<ToolRegistration["execute"]>[1]["commit"]>[0]>[0];

/** Schedules still waiting or running: reminders, and legacy deliveries still in storage. */
async function activeReminders(tx: ScanTx): Promise<number> {
  let count = 0;
  for (const kind of [
    ScheduledReminder.definition.name,
    DeliverScheduledInstruction.definition.name,
  ]) {
    let cursor: Parameters<typeof tx.scanTasks>[2];
    do {
      const page = await tx.scanTasks({ kind }, 100, cursor);
      count += page.items.filter(({ state }) => state.status !== "terminal").length;
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return count;
}
