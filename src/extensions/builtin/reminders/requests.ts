/**
 * The reminders' request ids (`sched:`, registered as automated in `index.ts`). Each occurrence has its own, so a
 * retried admission admits nothing twice.
 */
import { clientKey } from "../../../lib/requests.ts";

/** One occurrence of a reminder (M6): the first is 0. */
export function reminderRequest(reminderId: string, occurrence: number): string {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error("Invalid occurrence");
  return `sched:${clientKey(reminderId)}:${occurrence}`;
}
