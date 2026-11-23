/**
 * Request ids say where an input came from, and Pi Durable stores them with its record of the input. A request id is
 * unique in its conversation, so an input retried with the same one is admitted once (pattern from pi-pocket
 * src/server/requests.ts @ 2f060f2). Doors add theirs as they arrive: `tg:<update_id>` (M5), `relay:<key>` (M7).
 */

/** The key a client gave a request it may retry, made safe for an id. Empty when nothing usable is left. */
export const clientKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

/** A message from the web client, keyed by the request id its outbox retries with. */
export function webRequest(key: string): string {
  const safe = clientKey(key);
  if (safe.length === 0) throw new Error("The request id has no usable characters");
  return `web:${safe}`;
}

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

/** What a relay `Idempotency-Key` may be. Checked, never cleaned: cleaning could make two keys one. */
export const RELAY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isRelayKey = (key: string): boolean => RELAY_KEY_PATTERN.test(key);

/** A relay message (M7), keyed by the client's `Idempotency-Key`: a retry with the same key admits nothing twice. */
export function relayRequest(key: string): string {
  if (!isRelayKey(key)) throw new Error("A relay key is 1 to 64 letters, digits, - or _");
  return `relay:${key}`;
}

/** One occurrence of a reminder (M6): the first is 0. The same id on a retry admits nothing twice. */
export function reminderRequest(reminderId: string, occurrence: number): string {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error("Invalid occurrence");
  return `sched:${clientKey(reminderId)}:${occurrence}`;
}
