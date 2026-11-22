/**
 * What Pi Durable has written into the Durable Object's SQLite, for the M2b startup guard: the storage schema version
 * and the highest stored version of each task kind. Pi Durable refuses a newer schema (and newer documents) when it
 * opens, but a task written by a newer Pi Durable only fails later, when it is next run (`task_too_old`). Reading both
 * before opening lets MiPi refuse data from a newer build with a clear message instead.
 *
 * The table names and the task record's `kind` and `version` fields are Pi Durable internals (1.6: `durable_schema`, `tasks`).
 * `test/contract.test.ts` checks them against a real harness, so an upgrade that moves them fails there.
 */
import { CompactionTask, GenerationTask, ToolTask } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

/** The storage schema version this build's Pi Durable writes and can open. */
export const SUPPORTED_SCHEMA_VERSION: number = CURRENT_SQLITE_SCHEMA_VERSION;

// pi-ledger L2: Pi Durable internals (table names, record fields).
const SCHEMA_TABLE = "durable_schema";
const TASKS_TABLE = "tasks";

/** Anything made by `defineTask`, or one of Pi Durable's own task definitions. */
export type TaskDefinitionLike = {
  readonly definition: { readonly name: string; readonly version: number };
};

/** Pi Durable's own task kinds whose definitions it exports (1.6: `pi.tool` v4, `pi.generation` v3, `pi.compaction` v1). */
export const BUILT_IN_TASKS: readonly TaskDefinitionLike[] = [
  ToolTask,
  GenerationTask,
  CompactionTask,
];

function tableExists(sql: SqlStorage, name: string): boolean {
  return (
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()
      .length > 0
  );
}

/** The schema version stored in this object's SQLite, or `undefined` before Pi Durable first opened it. */
export function storedSchemaVersion(sql: SqlStorage): number | undefined {
  if (!tableExists(sql, SCHEMA_TABLE)) return undefined;
  const row = sql
    .exec<{ version: number }>(`SELECT version FROM ${SCHEMA_TABLE} WHERE singleton = 1`)
    .toArray()[0];
  return row?.version;
}

/** The highest stored version of each task kind (live and settled tasks alike). */
export function storedTaskVersions(sql: SqlStorage): Readonly<Record<string, number>> {
  if (!tableExists(sql, TASKS_TABLE)) return {};
  const rows = sql
    .exec<{ kind: string; version: number | null }>(
      // The `kind` column holds the kind JSON-encoded (1.6), so both fields are read from the record itself.
      `SELECT json_extract(record, '$.kind') AS kind,
              MAX(CAST(json_extract(record, '$.version') AS INTEGER)) AS version
       FROM ${TASKS_TABLE} GROUP BY 1`,
    )
    .toArray();
  return Object.fromEntries(
    rows.flatMap(({ kind, version }) => (version === null ? [] : [[kind, version]])),
  );
}

/** The task versions this build can run: Pi Durable's own plus MiPi's (`defineTask`). */
export function supportedTaskVersions(
  appTasks: readonly TaskDefinitionLike[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...BUILT_IN_TASKS, ...appTasks].map(({ definition }) => [definition.name, definition.version]),
  );
}

export interface TooNewTask {
  readonly kind: string;
  readonly stored: number;
  readonly supported: number;
}

/** Stored task kinds whose version is newer than this build supports. Kinds this build doesn't know are not listed. */
export function tasksNewerThanSupported(
  stored: Readonly<Record<string, number>>,
  supported: Readonly<Record<string, number>>,
): readonly TooNewTask[] {
  return Object.entries(stored).flatMap(([kind, version]) => {
    const own = supported[kind];
    return own !== undefined && version > own ? [{ kind, stored: version, supported: own }] : [];
  });
}
