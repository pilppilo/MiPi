/**
 * The `reminders` built-in (M6, COD-210): `schedule`, its reminders (`app.reminder`) and the older scheduled
 * deliveries (`app.deliver-scheduled-instruction`), with their tasks. It registers the `sched` and `held` request-id prefixes
 * as automated, so core knows a reminder's own run. Proactive runs (`RecordRun`, `RoundBudget`), the gates and delivery
 * are core: this extension reaches them through connectors and never names a door.
 */
import { defineExtension } from "../../../agent/pi/durable.ts";
import type { MipiExtension } from "../../../agent/extensions.ts";
import { ScheduledReminder } from "./reminder-task.ts";
import { DeliverScheduledInstruction } from "./schedule-task.ts";
import { readSchedules, scheduleTool } from "./schedule.ts";

export const remindersExtension: MipiExtension = {
  name: "reminders",
  tier: "builtin",
  replaceable: true,
  origins: [
    { prefix: "sched", source: "reminder", automated: true },
    // A held reminder sent on restore (COD-198): core admits it, with the id the reminder parked with.
    { prefix: "held", source: "reminder", automated: true },
  ],
  schedules: readSchedules,
  pi: defineExtension({
    name: "reminders",
    tools: [scheduleTool],
    // The legacy delivery task stays for schedules stored before reminders (M6).
    tasks: [DeliverScheduledInstruction, ScheduledReminder],
  }),
};
