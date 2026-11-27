/**
 * Admin routes for deploy scripts: status, export, restore, and point-in-time rollback of the owner's agent.
 * The Worker lets only the deploy scripts through (`authenticate(…, "admin")` in `index.ts`): the Access service
 * token once Access is on, `Authorization: Bearer <ADMIN_TOKEN>` before.
 *
 *   GET  /api/admin/status
 *   GET  /api/admin/events?after=&source=&level=&limit= → { events, health } (COD-235; any state, writes nothing)
 *   POST /api/admin/export/begin                      → export header (pauses the agent)
 *   GET  /api/admin/export/page?cursor=<json>         → { rows, next? }
 *   POST /api/admin/export/end                        → { consistent } (reopens the agent)
 *   POST /api/admin/restore/begin   { header, confirm } (wipes the agent!)
 *   POST /api/admin/restore/rows    { rows }
 *   POST /api/admin/restore/end     { rows: counts }  → status (reopens the agent if the guard allows)
 *   POST /api/admin/restore-bookmark { bookmark, confirm }
 */
import type { ExportCursor, ExportHeader, ExportRow } from "../agent/maintenance.ts";
import type { DiagQuery } from "../agent/diag.ts";
import { DIAG_LEVELS, type DiagLevel, MAX_DIAG_EVENTS } from "../protocol.ts";

/** `GET /api/admin/events` answers this many events when no `limit` is given. */
export const ADMIN_EVENTS_DEFAULT_LIMIT = 100;
const MAX_SOURCE_CHARACTERS = 64;
const LEVELS: ReadonlySet<string> = new Set(DIAG_LEVELS);

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BadRequest("Expected a JSON body");
  }
}

class BadRequest extends Error {}

function parseCursor(value: string | null): ExportCursor | undefined {
  if (value === null || value === "") return undefined;
  const cursor = JSON.parse(value) as Partial<ExportCursor>;
  if (!Number.isInteger(cursor.table) || typeof cursor.after !== "number") {
    throw new BadRequest("Bad cursor");
  }
  return cursor as ExportCursor;
}

const wholeNumber = (value: string, name: string, min: number, max: number): number => {
  if (!/^\d+$/.test(value)) throw new BadRequest(`${name} must be a whole number`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new BadRequest(`${name} must be from ${min} to ${max}`);
  }
  return number;
};

/** The events route's query, strictly: an unknown parameter, or a value out of range, is a 400. */
export function parseEventsQuery(params: URLSearchParams): DiagQuery {
  for (const name of params.keys()) {
    if (!["after", "source", "level", "limit"].includes(name)) {
      throw new BadRequest(`Unknown parameter ${name}`);
    }
  }
  for (const name of ["after", "source", "level", "limit"]) {
    if (params.getAll(name).length > 1) throw new BadRequest(`${name} is given twice`);
  }
  const after = params.get("after");
  const source = params.get("source");
  const level = params.get("level");
  const limit = params.get("limit");
  if (source !== null && (source.length === 0 || source.length > MAX_SOURCE_CHARACTERS)) {
    throw new BadRequest(`source must be 1 to ${MAX_SOURCE_CHARACTERS} characters`);
  }
  let levels: DiagLevel[] | undefined;
  if (level !== null) {
    levels = level.split(",").map((item) => {
      if (!LEVELS.has(item)) {
        throw new BadRequest(
          `level must be one or more of ${DIAG_LEVELS.join(", ")}, comma-separated`,
        );
      }
      return item as DiagLevel;
    });
  }
  return {
    ...(after === null ? {} : { after: wholeNumber(after, "after", 0, Number.MAX_SAFE_INTEGER) }),
    ...(source === null ? {} : { source }),
    ...(levels === undefined ? {} : { levels: [...new Set(levels)] }),
    limit:
      limit === null ? ADMIN_EVENTS_DEFAULT_LIMIT : wholeNumber(limit, "limit", 1, MAX_DIAG_EVENTS),
  };
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const agent = env.AGENT.getByName(env.MIPI_OWNER);
  const route = `${request.method} ${path}`;
  try {
    switch (route) {
      case "GET /api/admin/status":
        return json(await agent.adminStatus(), 200);
      case "GET /api/admin/events":
        return json(
          await agent.adminEvents(parseEventsQuery(new URL(request.url).searchParams)),
          200,
        );
      case "POST /api/admin/export/begin":
        return json(await agent.exportBegin(), 200);
      case "GET /api/admin/export/page":
        return json(
          await agent.exportPage(parseCursor(new URL(request.url).searchParams.get("cursor"))),
          200,
        );
      case "POST /api/admin/export/end":
        return json(await agent.exportEnd(), 200);
      case "POST /api/admin/restore/begin": {
        const { header, confirm } = await body<{ header: ExportHeader; confirm: string }>(request);
        await agent.restoreBegin(header, confirm);
        return json({ ok: true }, 200);
      }
      case "POST /api/admin/restore/rows": {
        const { rows } = await body<{ rows: ExportRow[] }>(request);
        await agent.restoreRows(rows);
        return json({ ok: true, rows: rows.length }, 200);
      }
      case "POST /api/admin/restore/end": {
        const { rows } = await body<{ rows: Record<string, number> }>(request);
        return json(await agent.restoreEnd(rows), 200);
      }
      case "POST /api/admin/restore-bookmark": {
        const { bookmark, confirm } = await body<{ bookmark: string; confirm: string }>(request);
        try {
          await agent.restoreBookmark(bookmark, confirm);
        } catch (error) {
          // The object resets itself to apply the bookmark, so the call ends in an error by design.
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("Confirm")) throw error;
          return json({ ok: true, restarting: true }, 202);
        }
        return json({ ok: true }, 200);
      }
      default:
        return json({ error: "Not found" }, 404);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, error instanceof BadRequest ? 400 : 409);
  }
}
