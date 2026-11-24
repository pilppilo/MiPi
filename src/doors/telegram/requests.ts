/**
 * The Telegram door's request ids (`tg:`, registered in `index.ts`). A request id is unique in its conversation, so an
 * update Telegram delivers again under the same id is admitted once.
 */

/** A Telegram message, keyed by its `update_id`: Telegram redelivers an update with the same id. */
export function telegramRequest(updateId: number): string {
  if (!Number.isSafeInteger(updateId) || updateId < 0)
    throw new Error("Invalid Telegram update id");
  return `tg:${updateId}`;
}

/** A burst of Telegram messages sent as one input, keyed by the first message's `update_id`. */
export function telegramBatchRequest(firstUpdateId: number): string {
  if (!Number.isSafeInteger(firstUpdateId) || firstUpdateId < 0)
    throw new Error("Invalid Telegram update id");
  return `tg:batch:${firstUpdateId}`;
}
