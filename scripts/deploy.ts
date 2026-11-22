/**
 * Backup, restore, and rollback checks for a deployed MiPi, used by the GitHub workflows (deploy, rollback, restore).
 * Talks to the Worker's admin API with `ADMIN_TOKEN` from the environment.
 *
 *   node scripts/deploy.ts status          --url https://mipi.example.workers.dev
 *   node scripts/deploy.ts backup          --url … --out backup.json
 *   node scripts/deploy.ts restore         --url … --file backup.json --confirm <export's MiPi version>
 *   node scripts/deploy.ts restore-bookmark --url … --bookmark <bookmark>
 *   node scripts/deploy.ts check-rollback  --from <deployed version> --to <target version> [--force]
 *
 * A backup pauses the agent for as long as the export takes (its harness is closed and doors answer 503), then
 * reopens it. A restore wipes the agent first; the startup guard then decides whether the running build may open it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { oneWayReleasesCrossed, parseChangelog } from "./release-notes.ts";

interface ExportRow {
  readonly table: string;
  readonly rowid: number;
  readonly values: Record<string, unknown>;
}

interface Backup {
  readonly header: {
    readonly meta: { readonly app_version?: string };
    readonly exportedAt: string;
  };
  readonly rows: readonly ExportRow[];
  readonly counts: Readonly<Record<string, number>>;
  readonly status: { readonly bookmark?: string; readonly meta: Record<string, string> };
}

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    out: { type: "string" },
    file: { type: "string" },
    confirm: { type: "string" },
    bookmark: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    force: { type: "boolean", default: false },
  },
});

function required(name: keyof typeof flags): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function adminClient(url: string) {
  const token = process.env.ADMIN_TOKEN;
  if (token === undefined || token.length === 0) throw new Error("ADMIN_TOKEN is not set");
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, url), {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: HTTP ${response.status} ${(parsed as { error?: string }).error ?? ""}`,
      );
    }
    return parsed as T;
  };
}

const countsOf = (rows: readonly ExportRow[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { table } of rows) counts[table] = (counts[table] ?? 0) + 1;
  return counts;
};

async function exportOnce(call: ReturnType<typeof adminClient>): Promise<Backup | undefined> {
  const status = await call<Backup["status"]>("GET", "/api/admin/status");
  const header = await call<Backup["header"]>("POST", "/api/admin/export/begin");
  const rows: ExportRow[] = [];
  let failure: unknown;
  try {
    let cursor: string | undefined;
    do {
      const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page = await call<{ rows: ExportRow[]; next?: unknown }>(
        "GET",
        `/api/admin/export/page${query}`,
      );
      rows.push(...page.rows);
      cursor = page.next === undefined ? undefined : JSON.stringify(page.next);
    } while (cursor !== undefined);
  } catch (error) {
    failure = error;
  }
  // Always end the export (which reopens the agent), even if a page failed; then report the failure.
  const { consistent } = await call<{ consistent: boolean }>("POST", "/api/admin/export/end");
  if (failure !== undefined) throw failure;
  if (!consistent) return undefined;
  return { header, rows, counts: countsOf(rows), status };
}

async function backup(): Promise<void> {
  const url = required("url");
  const out = required("out");
  const call = adminClient(url);
  try {
    await call("GET", "/api/admin/status");
  } catch (error) {
    // A first deploy has nothing to back up.
    console.log(`No backup: ${url} has no admin API yet (${(error as Error).message})`);
    return;
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await exportOnce(call);
    if (result !== undefined) {
      writeFileSync(out, JSON.stringify(result));
      console.log(
        `Backup of MiPi ${result.header.meta.app_version ?? "?"}: ${result.rows.length} rows ` +
          `${JSON.stringify(result.counts)} → ${out}` +
          (result.status.bookmark === undefined ? "" : `; bookmark ${result.status.bookmark}`),
      );
      return;
    }
    console.log(`Export attempt ${attempt} saw a write while exporting; retrying.`);
  }
  throw new Error("Could not take a consistent backup");
}

async function restore(): Promise<void> {
  const url = required("url");
  const data = JSON.parse(readFileSync(required("file"), "utf8")) as Backup;
  const confirm = required("confirm");
  const call = adminClient(url);
  console.log(
    `Restoring ${data.rows.length} rows from MiPi ${data.header.meta.app_version} (${data.header.exportedAt})`,
  );
  await call("POST", "/api/admin/restore/begin", { header: data.header, confirm });
  const batch = 200;
  for (let index = 0; index < data.rows.length; index += batch) {
    await call("POST", "/api/admin/restore/rows", { rows: data.rows.slice(index, index + batch) });
  }
  const status = await call<{ state: unknown; rows: unknown }>("POST", "/api/admin/restore/end", {
    rows: data.counts,
  });
  console.log(
    `Restored. Agent state: ${JSON.stringify(status.state)}; rows ${JSON.stringify(status.rows)}`,
  );
}

async function restoreBookmark(): Promise<void> {
  const bookmark = required("bookmark");
  const result = await adminClient(required("url"))("POST", "/api/admin/restore-bookmark", {
    bookmark,
    confirm: bookmark.slice(0, 8),
  });
  console.log(`Bookmark restore requested: ${JSON.stringify(result)}`);
}

async function status(): Promise<void> {
  console.log(
    JSON.stringify(await adminClient(required("url"))("GET", "/api/admin/status"), null, 2),
  );
}

function checkRollback(): void {
  const from = required("from");
  const to = required("to");
  const crossed = oneWayReleasesCrossed(
    parseChangelog(readFileSync("CHANGELOG.md", "utf8")),
    from,
    to,
  );
  if (crossed.length === 0) {
    console.log(`Rollback ${from} → ${to} crosses no one-way release.`);
    return;
  }
  const list = crossed.map(({ version }) => version).join(", ");
  if (!flags.force) {
    throw new Error(
      `Rollback ${from} → ${to} crosses one-way release(s) ${list}: ${to} can't read data written since. ` +
        "Restore a backup taken before them first, then roll back with --force.",
    );
  }
  console.log(
    `Rolling back across one-way release(s) ${list} (--force): restore a pre-upgrade backup next.`,
  );
}

const commands: Record<string, () => void | Promise<void>> = {
  status,
  backup,
  restore,
  "restore-bookmark": restoreBookmark,
  "check-rollback": checkRollback,
};

const command = commands[positionals[0] ?? ""];
if (command === undefined) {
  console.error(`Usage: node scripts/deploy.ts <${Object.keys(commands).join("|")}> [options]`);
  process.exit(2);
}
try {
  await command();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
