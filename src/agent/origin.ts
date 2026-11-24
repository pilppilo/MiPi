/**
 * Input origin (COD-209): where an input came from, read from its request id. Pi Durable stores the request id with
 * every input, so origin needs no document of its own and holds for inputs stored before it existed.
 *
 * Core owns the request-id scheme: `<prefix>:<rest>`, and this table says what each prefix means. Doors and the
 * reminders build their ids with their own prefix (`src/lib/requests.ts`); an extension reads origin from here and
 * never parses an id itself. The table is data rather than registrations because tools read it from inside their own
 * commits, where only the code is shared.
 */
import type { ConversationId, ToolRegistration } from "./pi/durable.ts";
import { LiveDoc } from "./pi/durable.ts";

/** Where one input came from. `automated` inputs were not sent by a person at that moment (a reminder's occurrence). */
export type InputOrigin = {
  /** The door or part that admitted it, as stored in what it leads to (a lesson's `from.source`). */
  readonly source: string;
  readonly automated: boolean;
};

/** An input whose id has no known prefix, or none: today's fallback. */
export const UNKNOWN_ORIGIN: InputOrigin = { source: "unknown", automated: false };

/** The request-id prefixes and what they mean. */
const PREFIXES: Readonly<Record<string, InputOrigin>> = {
  web: { source: "web", automated: false },
  tg: { source: "telegram", automated: false },
  relay: { source: "relay", automated: false },
  sched: { source: "reminder", automated: true },
};

/** The origin of one input, from its request id. */
export function originOf(requestId: string | undefined): InputOrigin {
  if (requestId === undefined) return UNKNOWN_ORIGIN;
  const colon = requestId.indexOf(":");
  if (colon <= 0) return UNKNOWN_ORIGIN;
  return PREFIXES[requestId.slice(0, colon)] ?? UNKNOWN_ORIGIN;
}

type ToolTx = Parameters<Parameters<Parameters<ToolRegistration["execute"]>[1]["commit"]>[0]>[0];

/**
 * The origin of the running turn. A turn can answer several inputs together; one a person sent names the turn before an
 * automated one does, since a reminder answered beside a person's message is not who asked.
 */
export async function runOrigin(tx: ToolTx, conversationId: ConversationId): Promise<InputOrigin> {
  const placed = (await tx.doc(LiveDoc, conversationId)).run?.inputs ?? [];
  const origins: InputOrigin[] = [];
  for (const id of placed) origins.push(originOf((await tx.submission(id))?.requestId));
  return (
    origins.find((origin) => !origin.automated && origin !== UNKNOWN_ORIGIN) ??
    origins[0] ??
    UNKNOWN_ORIGIN
  );
}
