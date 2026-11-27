/**
 * The diagnostic event stream (COD-216): a capped, structured record of the agent's hops, holds and faults, kept in
 * the Durable Object's own SQLite beside Pi Durable's tables but outside Pi Durable (no document, no commit), so it
 * keeps recording while the agent is refused and never shows in a commit, an export or a backup.
 *
 * Core defines the connector (`DiagSink`) and hands it to doors and extensions at composition time, as with delivery
 * and wake sources: each emitter tags its own `source`. Emitting is synchronous and never throws, so it is safe inside
 * `blockConcurrencyWhile`, a hook or a task phase. Core code: it names no door and no extension.
 *
 * What an event may hold is guarded here, whatever the emitter passes: no prompt text, message bodies, tool output,
 * cookies, JWTs or tokens. Summaries are one scrubbed line; `detail` is a few flat, scrubbed values.
 */
import {
  DIAG_LEVELS,
  DIAG_OUTCOMES,
  type DiagDetail,
  type DiagEvent,
  type DiagLevel,
  type DiagOutcome,
} from "../protocol.ts";

export const DIAG_TABLE = "app_diag_events";
/** Rows kept: the oldest go as new ones come in. */
export const DIAG_MAX_ROWS = 1_000;
export const DIAG_DEFAULT_LIMIT = 200;
export const DIAG_MAX_LIMIT = 500;

const MAX_SUMMARY = 200;
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_STRING = 120;
const MAX_NAME = 60;
const MAX_ID = 120;

/** What an emitter passes: an event without its id, and with its time optional (now). */
export type DiagInput = Omit<DiagEvent, "id" | "ts" | "detail"> & {
  readonly ts?: number;
  /** Flat values only; anything else, and any key that could hold content or a secret, is dropped. */
  readonly detail?: Readonly<Record<string, unknown>>;
};

/** Where diagnostic events go. */
export interface DiagSink {
  emit(event: DiagInput): void;
}

/** A sink that drops everything: the default where no agent composed one (tests, bare tools). */
export const NOOP_DIAG: DiagSink = { emit() {} };

export interface DiagQuery {
  /** Only events after this id, oldest first. Without it: the newest `limit`, oldest first. */
  readonly after?: number;
  readonly source?: string;
  readonly levels?: readonly DiagLevel[];
  /** Default `DIAG_DEFAULT_LIMIT`, at most `DIAG_MAX_LIMIT`. */
  readonly limit?: number;
}

// ---- The guardrail ----

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bBearer\s+\S+/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]"],
  // Telegram bot tokens, alone or in a Bot API path (`/bot<id>:<token>/sendMessage`).
  [/\bbot\d{3,}:[A-Za-z0-9_-]{10,}/gi, "bot[redacted]"],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]"],
  [
    /([?&#](?:token|key|api[_-]?key|access[_-]?token|auth|secret|sig|signature|password|code)=)[^&\s#]+/gi,
    "$1[redacted]",
  ],
];

/** Keys that hold content: dropped when the key is exactly one of these. */
const CONTENT_KEYS = new Set(["prompt", "body", "content", "text", "message", "messages", "input"]);
/** Keys that may hold a credential: dropped when the key contains one of these. */
const SECRET_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "authorization",
  "jwt",
  "apikey",
  "credential",
];
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;

/** Removes the secrets a log line commonly carries. */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

/** One scrubbed line of at most `max` characters. */
export function diagLine(text: string, max: number = MAX_SUMMARY): string {
  const line = scrubSecrets(text).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const isSensitiveKey = (key: string): boolean => {
  const folded = key.toLowerCase().replace(/[_.-]/g, "");
  return CONTENT_KEYS.has(folded) || SECRET_KEY_PARTS.some((part) => folded.includes(part));
};

/** `detail` as it may be stored: flat, scrubbed, at most `MAX_DETAIL_KEYS` keys; undefined when nothing is left. */
export function diagDetail(
  detail: Readonly<Record<string, unknown>> | undefined,
): DiagDetail | undefined {
  if (detail === undefined) return undefined;
  const kept: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (count >= MAX_DETAIL_KEYS) break;
    if (!KEY_SHAPE.test(key) || isSensitiveKey(key)) continue;
    if (typeof value === "string") kept[key] = diagLine(value, MAX_DETAIL_STRING);
    else if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
    else if (typeof value === "boolean") kept[key] = value;
    else continue;
    count += 1;
  }
  return count === 0 ? undefined : kept;
}

/** An emitter's input as it is stored: every field guarded. */
export function sanitizeDiag(input: DiagInput, now: number): Omit<DiagEvent, "id"> {
  const ts = input.ts !== undefined && Number.isFinite(input.ts) ? Math.trunc(input.ts) : now;
  const detail = diagDetail(input.detail);
  const reqId = input.reqId === undefined ? undefined : diagLine(input.reqId, MAX_ID);
  const taskId = input.taskId === undefined ? undefined : diagLine(input.taskId, MAX_ID);
  const convId =
    input.convId !== undefined && Number.isSafeInteger(input.convId) && input.convId > 0
      ? input.convId
      : undefined;
  const durationMs =
    input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? Math.round(input.durationMs)
      : undefined;
  return {
    ts,
    level: input.level,
    source: diagLine(input.source, MAX_NAME) || "unknown",
    kind: diagLine(input.kind, MAX_NAME) || "unknown",
    outcome: input.outcome,
    summary: diagLine(input.summary),
    ...(reqId ? { reqId } : {}),
    ...(convId === undefined ? {} : { convId }),
    ...(taskId ? { taskId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** An error's message, for a summary or `detail` (scrubbed when stored). */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---- The log ----

/** A SQLite value, as Durable Object SQL stores it (`SqlStorageValue`). */
type SqlValue = ArrayBuffer | string | number | null;

/**
 * The part of Durable Object SQL (`ctx.storage.sql`) the log uses. Structural, so modules that only emit (and the
 * scripts that import them) don't need the Workers types.
 */
export interface DiagSql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): T[]; one(): T };
}

export interface DiagLogOptions {
  /**
   * Whether a write may happen now. The agent says no while maintenance runs (`agent-do.ts`): an export's
   * fingerprint includes the database size, so a write there would fail it. A refused event goes to the console.
   */
  readonly canWrite?: () => boolean;
  /** Each stored event, after the write (the live tail, COD-235). */
  readonly onEmit?: (event: DiagEvent) => void;
  readonly maxRows?: number;
  readonly now?: () => number;
}

type Row = {
  id: number;
  ts: number;
  level: string;
  source: string;
  kind: string;
  outcome: string;
  summary: string;
  req_id: string | null;
  conv_id: number | null;
  task_id: string | null;
  duration_ms: number | null;
  detail: string | null;
};

const LEVELS: ReadonlySet<string> = new Set(DIAG_LEVELS);
const OUTCOMES: ReadonlySet<string> = new Set(DIAG_OUTCOMES);

/** A stored row read back: stored data is a trust boundary, so a row an older or broken build wrote is skipped. */
function eventOf(row: Row): DiagEvent | undefined {
  if (!LEVELS.has(row.level) || !OUTCOMES.has(row.outcome)) return undefined;
  let detail: DiagDetail | undefined;
  if (row.detail !== null) {
    try {
      const parsed: unknown = JSON.parse(row.detail);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        detail = diagDetail(parsed as Record<string, unknown>);
      }
    } catch {
      // Unreadable detail: the event shows without it.
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    level: row.level as DiagLevel,
    source: row.source,
    kind: row.kind,
    outcome: row.outcome as DiagOutcome,
    summary: row.summary,
    ...(row.req_id === null ? {} : { reqId: row.req_id }),
    ...(row.conv_id === null ? {} : { convId: row.conv_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(detail === undefined ? {} : { detail }),
  };
}

const COLUMNS =
  "id, ts, level, source, kind, outcome, summary, req_id, conv_id, task_id, duration_ms, detail";

/**
 * The agent's diagnostic log, in raw Durable Object SQLite (`app_diag_events`). The table is made on the first write,
 * never by a read, so reading a fresh database writes nothing. `AUTOINCREMENT` keeps ids rising after the oldest rows
 * are trimmed and after a restart, so a reader's cursor never sees an id twice.
 */
export class DiagLog implements DiagSink {
  readonly #sql: DiagSql;
  readonly #canWrite: () => boolean;
  readonly #onEmit: ((event: DiagEvent) => void) | undefined;
  readonly #maxRows: number;
  readonly #now: () => number;
  #ready = false;
  #warned = false;

  constructor(sql: DiagSql, options: DiagLogOptions = {}) {
    this.#sql = sql;
    this.#canWrite = options.canWrite ?? (() => true);
    this.#onEmit = options.onEmit;
    this.#maxRows = Math.max(1, Math.trunc(options.maxRows ?? DIAG_MAX_ROWS));
    this.#now = options.now ?? Date.now;
  }

  /** Records one event. Never throws: a failed write is reported once to the console and the event is dropped. */
  emit(input: DiagInput): void {
    let event: DiagEvent;
    try {
      const clean = sanitizeDiag(input, this.#now());
      if (!this.#canWrite()) {
        // Not stored (maintenance): Cloudflare's logs keep it, in the same shape.
        console.log(JSON.stringify({ message: "Diagnostic event (not stored)", diag: clean }));
        return;
      }
      this.#ensure();
      const { id } = this.#sql
        .exec<{ id: number }>(
          `INSERT INTO ${DIAG_TABLE} (ts, level, source, kind, outcome, summary, req_id, conv_id, task_id, duration_ms, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          clean.ts,
          clean.level,
          clean.source,
          clean.kind,
          clean.outcome,
          clean.summary,
          clean.reqId ?? null,
          clean.convId ?? null,
          clean.taskId ?? null,
          clean.durationMs ?? null,
          clean.detail === undefined ? null : JSON.stringify(clean.detail),
        )
        .one();
      // Keeps the newest `maxRows`: deletes the row `maxRows` back from the newest, and everything older.
      this.#sql.exec(
        `DELETE FROM ${DIAG_TABLE} WHERE id <= (SELECT id FROM ${DIAG_TABLE} ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        this.#maxRows,
      );
      event = { id, ...clean };
    } catch (error) {
      // Made again on the next write, in case the table went (a wipe this log wasn't told of).
      this.#ready = false;
      if (!this.#warned) {
        this.#warned = true;
        console.error(
          JSON.stringify({
            message: "Recording a diagnostic event failed",
            error: errorText(error),
          }),
        );
      }
      return;
    }
    try {
      this.#onEmit?.(event);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Publishing a diagnostic event failed",
          error: errorText(error),
        }),
      );
    }
  }

  /** Stored events, oldest first. Writes nothing: an absent table reads as empty. */
  read(query: DiagQuery = {}): readonly DiagEvent[] {
    if (!this.#exists()) return [];
    const limit = Math.min(
      DIAG_MAX_LIMIT,
      Math.max(1, Math.trunc(query.limit ?? DIAG_DEFAULT_LIMIT) || DIAG_DEFAULT_LIMIT),
    );
    const where: string[] = [];
    const bindings: SqlValue[] = [];
    if (query.after !== undefined) {
      where.push("id > ?");
      bindings.push(Math.trunc(query.after));
    }
    if (query.source !== undefined) {
      where.push("source = ?");
      bindings.push(query.source);
    }
    if (query.levels !== undefined && query.levels.length > 0) {
      where.push(`level IN (${query.levels.map(() => "?").join(", ")})`);
      bindings.push(...query.levels);
    }
    const filter = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const sql =
      query.after !== undefined
        ? `SELECT ${COLUMNS} FROM ${DIAG_TABLE} ${filter} ORDER BY id ASC LIMIT ?`
        : `SELECT * FROM (SELECT ${COLUMNS} FROM ${DIAG_TABLE} ${filter} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    return this.#sql
      .exec<Row>(sql, ...bindings, limit)
      .toArray()
      .flatMap((row) => {
        const event = eventOf(row);
        return event === undefined ? [] : [event];
      });
  }

  /** Forgets that the table exists: after `deleteAll()` (a restore), the next write makes it again. */
  reset(): void {
    this.#ready = false;
  }

  #exists(): boolean {
    return (
      this.#sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", DIAG_TABLE)
        .toArray().length > 0
    );
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${DIAG_TABLE} (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL,
         level TEXT NOT NULL,
         source TEXT NOT NULL,
         kind TEXT NOT NULL,
         outcome TEXT NOT NULL,
         summary TEXT NOT NULL,
         req_id TEXT,
         conv_id INTEGER,
         task_id TEXT,
         duration_ms INTEGER,
         detail TEXT
       )`,
    );
    this.#sql.exec(`CREATE INDEX IF NOT EXISTS ${DIAG_TABLE}_source ON ${DIAG_TABLE} (source, id)`);
    this.#sql.exec(`CREATE INDEX IF NOT EXISTS ${DIAG_TABLE}_level ON ${DIAG_TABLE} (level, id)`);
    this.#ready = true;
  }
}
