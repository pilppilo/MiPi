/**
 * Export and restore of the agent's Durable Object SQLite, in pages small enough for one invocation's CPU budget.
 * Plain SQL over `ctx.storage.sql`: it copies Pi Durable's tables as they are, without Pi Durable, so a restore works
 * even when the running code can't open the data (the rollback case). `app_meta` holds MiPi's own bookkeeping.
 *
 * An export is a JSON document: one header (versions, schema DDL) and the rows of every table, page by page.
 * Cloudflare's internal `_cf_*` tables and SQLite's `sqlite_*` tables are skipped; they can't be written back. The
 * diagnostic log (`app_diag_events`, `diag.ts`) is skipped too: it is operational, not the agent's data, and a
 * restore starts it empty.
 */
import { DIAG_TABLE } from "./diag.ts";

export const META_TABLE = "app_meta";

/** Keys MiPi keeps in `app_meta`. */
export type MetaKey =
  | "app_version"
  | "pi_durable_version"
  | "schema_version"
  | "task_versions"
  | "alarm_lost_at"
  | "maintenance"
  /** When the running export or restore began (ms since the epoch). */
  | "maintenance_started_at"
  | "restoring";

export type Meta = Partial<Record<MetaKey, string>>;

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** An export left running this long is abandoned: its script died, so the agent opens again. */
export const STALE_EXPORT_MS = 10 * 60_000;

/**
 * Whether an export flag is left over from a run that died. Only an export expires: a restore (or the `restoring`
 * flag) never does, so partial data never opens. A flag without a start time is from a build before the time was kept.
 */
export function isStaleExport(meta: Meta, now: number = Date.now()): boolean {
  if (meta.maintenance !== "export" || meta.restoring !== undefined) return false;
  const started = Number(meta.maintenance_started_at);
  return !Number.isFinite(started) || now - started >= STALE_EXPORT_MS;
}

export function ensureMeta(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/** Reads `app_meta` without writing: creating the table would move the storage bookmark mid-export. */
export function readMeta(sql: SqlStorage): Meta {
  const exists =
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", META_TABLE).toArray()
      .length > 0;
  if (!exists) return {};
  const rows = sql
    .exec<{ key: string; value: string }>(`SELECT key, value FROM ${META_TABLE}`)
    .toArray();
  return Object.fromEntries(rows.map(({ key, value }) => [key, value])) as Meta;
}

/** Sets keys; `undefined` deletes a key. */
export function writeMeta(sql: SqlStorage, changes: Meta): void {
  ensureMeta(sql);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) sql.exec(`DELETE FROM ${META_TABLE} WHERE key = ?`, key);
    else
      sql.exec(
        `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
  }
}

/** A schema object to recreate: a table, index, or trigger, as `sqlite_master` stores it. */
export interface SchemaObject {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

export interface ExportHeader {
  readonly format: "mipi-export";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  /** `app_meta` as it was at export, excluding local operational state. */
  readonly meta: Meta;
  readonly schema: readonly SchemaObject[];
}

/** A value as JSON: SQLite blobs become `{ "$b64": "…" }`. */
export type ExportValue = string | number | null | { readonly $b64: string };

export interface ExportRow {
  readonly table: string;
  readonly rowid: number;
  readonly values: Readonly<Record<string, ExportValue>>;
}

export interface ExportCursor {
  /** Index into the header's tables, in name order. */
  readonly table: number;
  /** Rows of that table after this rowid come next. */
  readonly after: number;
}

export interface ExportPage {
  readonly rows: readonly ExportRow[];
  /** Absent when this was the last page. */
  readonly next?: ExportCursor;
}

export interface PageLimits {
  readonly maxRows: number;
  /** Stop adding rows once the page's JSON reaches about this many characters. */
  readonly maxChars: number;
}

export const DEFAULT_PAGE_LIMITS: PageLimits = { maxRows: 500, maxChars: 1_000_000 };

const isExported = (name: string): boolean =>
  !name.startsWith("_cf_") &&
  !name.startsWith("sqlite_") &&
  name !== META_TABLE &&
  name !== DIAG_TABLE;

/** Tables, then their indexes and triggers, in a stable order. */
export function readSchema(sql: SqlStorage): readonly SchemaObject[] {
  const objects = sql
    .exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
    )
    .toArray();
  return objects
    .filter(({ name, tbl_name }) => isExported(name) && isExported(tbl_name))
    .map(({ type, name, tbl_name, sql: ddl }) => ({
      type: type as SchemaObject["type"],
      name,
      table: tbl_name,
      sql: ddl!,
    }));
}

/**
 * Tables the export can't page: it walks every table by `rowid`, which a `WITHOUT ROWID` table doesn't have. Pi
 * Durable 1.6.0 has none; a later version that adds one fails here, before the agent closes, and in the contract test.
 */
export function tablesWithoutRowid(
  sql: SqlStorage,
  schema: readonly SchemaObject[] = readSchema(sql),
): string[] {
  return schema
    .filter(({ type, sql: ddl }) => type === "table" && /\bWITHOUT\s+ROWID\b/i.test(ddl))
    .map(({ name }) => name);
}

/** Throws a clear error when the data has a table the export can't copy. */
export function assertExportable(sql: SqlStorage): void {
  const tables = tablesWithoutRowid(sql);
  if (tables.length > 0) {
    throw new Error(
      `Export can't copy WITHOUT ROWID table(s) ${tables.join(", ")}: maintenance.ts needs a key-based page for them`,
    );
  }
}

const tablesOf = (schema: readonly SchemaObject[]): readonly string[] =>
  schema.filter(({ type }) => type === "table").map(({ name }) => name);

export function exportHeader(sql: SqlStorage, now: Date = new Date()): ExportHeader {
  const {
    maintenance: _maintenance,
    maintenance_started_at: _startedAt,
    restoring: _restoring,
    alarm_lost_at: _alarmLostAt,
    ...meta
  } = readMeta(sql);
  return {
    format: "mipi-export",
    formatVersion: 1,
    exportedAt: now.toISOString(),
    meta,
    schema: readSchema(sql),
  };
}

function encodeValue(value: unknown): ExportValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (value instanceof ArrayBuffer) {
    let binary = "";
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return { $b64: btoa(binary) };
  }
  throw new TypeError(`Unexpected SQLite value: ${typeof value}`);
}

function decodeValue(value: ExportValue): SqlStorageValue {
  if (value !== null && typeof value === "object") {
    const binary = atob(value.$b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }
  return value;
}

/** One page of rows, starting at `cursor` (the first page when absent). */
export function exportPage(
  sql: SqlStorage,
  schema: readonly SchemaObject[],
  cursor: ExportCursor | undefined,
  limits: PageLimits = DEFAULT_PAGE_LIMITS,
): ExportPage {
  const tables = tablesOf(schema);
  const rows: ExportRow[] = [];
  let chars = 0;
  let table = cursor?.table ?? 0;
  let after = cursor?.after ?? Number.MIN_SAFE_INTEGER;

  while (table < tables.length) {
    const name = tables[table]!;
    const remaining = limits.maxRows - rows.length;
    const batch = sql
      .exec(
        `SELECT rowid AS __mipi_rowid, * FROM ${quote(name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        after,
        remaining,
      )
      .toArray();
    for (const raw of batch) {
      const { __mipi_rowid: rowid, ...columns } = raw as Record<string, unknown>;
      const row: ExportRow = {
        table: name,
        rowid: rowid as number,
        values: Object.fromEntries(
          Object.entries(columns).map(([column, value]) => [column, encodeValue(value)]),
        ),
      };
      rows.push(row);
      after = row.rowid;
      chars += JSON.stringify(row).length;
      if (rows.length >= limits.maxRows || chars >= limits.maxChars) {
        return { rows, next: { table, after } };
      }
    }
    if (batch.length < remaining) {
      table += 1;
      after = Number.MIN_SAFE_INTEGER;
    }
  }
  return { rows };
}

/** Recreates the exported tables, indexes, and triggers in an empty database. */
export function restoreSchema(sql: SqlStorage, header: ExportHeader): void {
  if (header.format !== "mipi-export" || header.formatVersion !== 1) {
    throw new Error("Not a MiPi export (format mipi-export, version 1)");
  }
  for (const object of header.schema) {
    // A build before the log was kept out of exports (after a rollback) copies it like any table: left out here.
    if (object.table === DIAG_TABLE) continue;
    if (!isExported(object.name) || !isExported(object.table)) {
      throw new Error(`Refusing to restore ${object.type} ${object.name}`);
    }
    sql.exec(object.sql);
  }
}

/** Inserts exported rows. Every row's table must be one the restored schema created. */
export function restoreRows(
  sql: SqlStorage,
  schema: readonly SchemaObject[],
  rows: readonly ExportRow[],
): void {
  const tables = new Set(tablesOf(schema));
  for (const row of rows) {
    if (row.table === DIAG_TABLE) continue;
    if (!tables.has(row.table)) throw new Error(`Row for unknown table ${row.table}`);
    const columns = Object.keys(row.values);
    const names = ["rowid", ...columns].map((column) =>
      column === "rowid" ? "rowid" : quote(column),
    );
    sql.exec(
      `INSERT INTO ${quote(row.table)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      row.rowid,
      ...columns.map((column) => decodeValue(row.values[column]!)),
    );
  }
}

/**
 * A cheap picture of the exported data: schema, per-table row count and highest rowid, and the database size. Taken
 * when an export begins and again when it ends; any difference means something wrote in between. (Durable Object
 * SQL allows neither `total_changes()` nor `PRAGMA schema_version`, and bookmarks advance on reads in local tests.)
 * It catches inserts, deletes, and schema changes, not an in-place update; while an export runs the harness is
 * closed and alarms are off, so nothing should write at all, and this is the check that it didn't.
 */
export function fingerprint(sql: SqlStorage): string {
  const schema = readSchema(sql);
  const tables = tablesOf(schema).map((name) => {
    const { n, max } = sql
      .exec<{ n: number; max: number | null }>(
        `SELECT count(*) AS n, max(rowid) AS max FROM ${quote(name)}`,
      )
      .one();
    return [name, n, max];
  });
  return JSON.stringify({ schema, tables, size: sql.databaseSize });
}

/** Row counts per exported table, for checking a restore against its export. */
export function rowCounts(sql: SqlStorage): Readonly<Record<string, number>> {
  return Object.fromEntries(
    tablesOf(readSchema(sql)).map((name) => [
      name,
      sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(name)}`).one().n,
    ]),
  );
}
