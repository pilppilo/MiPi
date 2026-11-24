/**
 * Request ids say where an input came from, and Pi Durable stores them with its record of the input. A request id is
 * unique in its conversation, so an input retried with the same one is admitted once (pattern from pi-pocket
 * src/server/requests.ts @ 2f060f2). Each door and the reminders build their own, with the prefix they register
 * (`src/agent/origin.ts`); this file keeps only what they share.
 */

/** The key a client gave a request it may retry, made safe for an id. Empty when nothing usable is left. */
export const clientKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
