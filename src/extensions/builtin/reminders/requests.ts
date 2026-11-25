/**
 * The reminders' request ids (`sched:` and `held:`, registered as automated in `index.ts`). Each occurrence has its own, so a
 * retried admission admits nothing twice.
 */
import { clientKey } from "../../../lib/requests.ts";

/** One occurrence of a reminder (M6): the first is 0. */
export function reminderRequest(reminderId: string, occurrence: number): string {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error("Invalid occurrence");
  return `sched:${clientKey(reminderId)}:${occurrence}`;
}

/**
 * A one-time reminder held while its bot was archived, sent on restore (COD-198): one id per reminder, so a second
 * restore sends nothing twice. Core sends it with the id the reminder gave when it parked.
 */
export function heldReminderRequest(reminderId: string): string {
  const key = clientKey(reminderId);
  if (key.length === 0) throw new Error("The reminder id has no usable characters");
  return `held:${key}`;
}
