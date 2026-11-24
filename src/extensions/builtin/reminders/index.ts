/**
 * The `reminders` built-in (M6): `schedule`, its reminders (`app.reminder`) and the older scheduled deliveries
 * (`app.deliver-scheduled-instruction`), with their tasks. Proactive runs (`RecordRun`, `RoundBudget`) are core.
 *
 * Its code still lives in `src/tools/` and writes Telegram's documents itself; COD-210 moves it here and onto core's
 * delivery. Until then it is a built-in by registration only.
 */
import { defineExtension } from "../../../agent/pi/durable.ts";
import type { MipiExtension } from "../../../agent/extensions.ts";
import { ScheduledReminder } from "../../../tools/reminder-task.ts";
import { DeliverScheduledInstruction } from "../../../tools/schedule-task.ts";
import { scheduleTool } from "../../../tools/schedule.ts";

export const remindersExtension: MipiExtension = {
  name: "reminders",
  tier: "builtin",
  replaceable: true,
  pi: defineExtension({
    name: "reminders",
    tools: [scheduleTool],
    // The legacy delivery task stays for schedules stored before reminders (M6).
    tasks: [DeliverScheduledInstruction, ScheduledReminder],
  }),
};
