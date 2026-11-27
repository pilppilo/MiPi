/**
 * What a failed heartbeat adds to its report (COD-235): the agent's latest warnings and errors, from
 * `GET /api/admin/events`. Best effort: a failure to read them is one line in the report, never a second failure.
 */
import type { AdminCall } from "./admin-client.ts";
import { type DiagEvent, parseDiagSnapshot } from "../src/protocol.ts";

export const HEARTBEAT_EVENTS_PATH = "/api/admin/events?level=warn,error&limit=10";

/** One event as a report line. */
export const eventLine = (event: DiagEvent): string =>
  `${new Date(event.ts).toISOString()} ${event.level} ${event.source} ${event.kind}: ${event.summary.replaceAll(/\s+/g, " ")}`;

/** The latest warnings and errors as report lines, newest last; one explanatory line when they can't be read. */
export async function recentFaultLines(call: AdminCall): Promise<string[]> {
  try {
    const { events } = parseDiagSnapshot(await call<unknown>("GET", HEARTBEAT_EVENTS_PATH));
    return events.length === 0 ? ["No recent warnings or errors."] : events.map(eventLine);
  } catch (error) {
    return [
      `Recent events unavailable: ${(error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ")}`,
    ];
  }
}
