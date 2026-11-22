/**
 * The startup guard: before Pi Durable opens the agent's storage, check that this build can read what is stored.
 * Pi Durable refuses a newer schema when it opens, but a task written by a newer Pi Durable only fails later, when
 * it next runs (`task_too_old`), and a sleep without a deadline is treated as due. So MiPi checks both itself and
 * refuses to open with a message that names both builds, instead of half-running or crash-looping on newer data.
 */
import {
  storedSchemaVersion,
  storedTaskVersions,
  SUPPORTED_SCHEMA_VERSION,
  supportedTaskVersions,
  type TaskDefinitionLike,
  tasksNewerThanSupported,
} from "./pi/storage.ts";
import { readMeta } from "./maintenance.ts";
import { MIPI_VERSION } from "../version.ts";

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly storedBy?: string };

export function checkStoredData(
  sql: SqlStorage,
  appTasks: readonly TaskDefinitionLike[],
): GuardResult {
  const meta = readMeta(sql);
  const storedBy = meta.app_version;
  const builds = `data is from MiPi ${storedBy ?? "an unknown version"}, this build is ${MIPI_VERSION}`;

  if (meta.restoring !== undefined) {
    return { ok: false, reason: "A restore is in progress", storedBy };
  }

  const schema = storedSchemaVersion(sql);
  if (schema !== undefined && schema > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Stored Pi Durable schema ${schema} is newer than this build's ${SUPPORTED_SCHEMA_VERSION} (${builds})`,
      storedBy,
    };
  }

  const tooNew = tasksNewerThanSupported(storedTaskVersions(sql), supportedTaskVersions(appTasks));
  if (tooNew.length > 0) {
    const list = tooNew
      .map(({ kind, stored, supported }) => `${kind} v${stored} (this build: v${supported})`)
      .join(", ");
    return {
      ok: false,
      reason: `Stored tasks are newer than this build can run: ${list} (${builds})`,
      storedBy,
    };
  }
  return { ok: true };
}
