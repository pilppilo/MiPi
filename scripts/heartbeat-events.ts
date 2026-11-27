/**
 * What a failed heartbeat adds to its report (COD-235): the agent's latest warnings and errors, from
 * `GET /api/admin/events`. Best effort: a failure to read them is one line in the report, never a second failure.
 *
 * `heartbeat.yml` runs this with Node alone, without `pnpm install`, like `heartbeat-check.ts` and `admin-client.ts`:
 * nothing here may import a value from `src/` or a package. Types only (`import type` is stripped), and the response
 * is checked here for the fields a line uses.
 */
import type { AdminCall } from "./admin-client.ts";
import type { DiagEvent } from "../src/protocol.ts";

export const HEARTBEAT_EVENTS_PATH = "/api/admin/events?level=warn,error&limit=10";

/** The fields of an event that a report line shows. */
export type EventLineFields = Pick<DiagEvent, "ts" | "level" | "source" | "kind" | "summary">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The events of an answer from the admin API, checked for what a line reads; throws on anything else. */
export function parseEventLines(body: unknown): EventLineFields[] {
  const events = isRecord(body) ? body.events : undefined;
  if (!Array.isArray(events)) throw new Error("The events answer has no event list");
  return events.map((event: unknown) => {
    if (
      !isRecord(event) ||
      typeof event.ts !== "number" ||
      !Number.isFinite(event.ts) ||
      Math.abs(event.ts) > 8.64e15 ||
      typeof event.level !== "string" ||
      typeof event.source !== "string" ||
      typeof event.kind !== "string" ||
      typeof event.summary !== "string"
    ) {
      throw new Error("An event in the answer is invalid");
    }
    return {
      ts: event.ts,
      level: event.level as DiagEvent["level"],
      source: event.source,
      kind: event.kind,
      summary: event.summary,
    };
  });
}

/** One event as a report line. */
export const eventLine = (event: EventLineFields): string =>
  `${new Date(event.ts).toISOString()} ${event.level} ${event.source} ${event.kind}: ${event.summary.replaceAll(/\s+/g, " ")}`;

/** The latest warnings and errors as report lines, newest last; one explanatory line when they can't be read. */
export async function recentFaultLines(call: AdminCall): Promise<string[]> {
  try {
    const events = parseEventLines(await call<unknown>("GET", HEARTBEAT_EVENTS_PATH));
    return events.length === 0 ? ["No recent warnings or errors."] : events.map(eventLine);
  } catch (error) {
    return [
      `Recent events unavailable: ${(error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ")}`,
    ];
  }
}
