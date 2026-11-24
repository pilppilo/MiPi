/**
 * The relay's request ids (`relay:`, registered in `index.ts`): a retry with the same `Idempotency-Key` admits nothing
 * twice.
 */

/** What a relay `Idempotency-Key` may be. Checked, never cleaned: cleaning could make two keys one. */
export const RELAY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isRelayKey = (key: string): boolean => RELAY_KEY_PATTERN.test(key);

/** A relay message (M7), keyed by the client's `Idempotency-Key`. */
export function relayRequest(key: string): string {
  if (!isRelayKey(key)) throw new Error("A relay key is 1 to 64 letters, digits, - or _");
  return `relay:${key}`;
}
