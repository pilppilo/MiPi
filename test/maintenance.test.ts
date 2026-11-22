import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import type { AdminStatus } from "../src/agent/agent-do.ts";
import {
  exportPage,
  readSchema,
  restoreRows,
  restoreSchema,
  rowCounts,
  type ExportHeader,
  type ExportPage,
  type ExportRow,
} from "../src/agent/maintenance.ts";
import { SUPPORTED_SCHEMA_VERSION } from "../src/agent/pi/storage.ts";
import worker from "../src/worker/index.ts";
import { MIPI_VERSION } from "../src/version.ts";
import { withSpikeToken } from "./spike.ts";

const ADMIN = "test-admin-token";
const base = "https://example.com";

/** The Worker, pointed at its own owner object so tests don't share state. */
const forOwner = (owner: string) => {
  const ownerEnv = { ...env, MIPI_OWNER: owner } as Env;
  const call = async <T>(method: string, path: string, payload?: unknown): Promise<T> => {
    const response = await worker.fetch(
      new Request(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
      ownerEnv,
    );
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error}`);
    return result;
  };
  return { ownerEnv, call, stub: env.AGENT.getByName(owner) };
};

/** Writes conversation history through a separate harness beside the live agent, then evicts it. */
async function seed(owner: string, content: string): Promise<void> {
  const stub = env.AGENT.getByName(owner);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.blockConcurrencyWhile(async () => {});
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText(`Answer to ${content}`)])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = await openDurableObjectSqliteStorage(state.storage);
    const harness = await Harness.open(
      storage,
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: "faux", modelId: "faux-1" }, tools: [] },
      });
      await (
        await root.submit({ type: "input", content }, BACKGROUND_CONTEXT)
      ).wait(BACKGROUND_CONTEXT);
      await harness.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
  await evictDurableObject(stub);
}

async function exportAll(call: ReturnType<typeof forOwner>["call"]) {
  const header = await call<ExportHeader>("POST", "/api/admin/export/begin");
  const rows: ExportRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await call<ExportPage>(
      "GET",
      `/api/admin/export/page${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    );
    rows.push(...page.rows);
    cursor = page.next === undefined ? undefined : JSON.stringify(page.next);
  } while (cursor !== undefined);
  const { consistent } = await call<{ consistent: boolean }>("POST", "/api/admin/export/end");
  return { header, rows, consistent };
}

const countsOf = (rows: readonly ExportRow[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { table } of rows) counts[table] = (counts[table] ?? 0) + 1;
  return counts;
};

async function userTexts(owner: string): Promise<string[]> {
  return runInDurableObject(env.AGENT.getByName(owner), async (_instance, state) =>
    state.storage.sql
      .exec<{ record: string }>("SELECT record FROM entries")
      .toArray()
      .map(({ record }) => record)
      .filter((record) => record.includes('"role":"user"')),
  );
}

describe("admin routes", () => {
  it("need ADMIN_TOKEN, and health shows versions only to it", async () => {
    const { ownerEnv } = forOwner("admin-auth");
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${ADMIN}x`]) {
      const response = await worker.fetch(
        new Request(`${base}/api/admin/status`, {
          headers: authorization === undefined ? {} : { Authorization: authorization },
        }),
        ownerEnv,
      );
      expect(response.status).toBe(401);
    }
    const unconfigured = await worker.fetch(
      new Request(`${base}/api/admin/status`, { headers: { Authorization: "Bearer " } }),
      { ...ownerEnv, ADMIN_TOKEN: "" } as Env,
    );
    expect(unconfigured.status).toBe(401);

    const publicHealth = await worker.fetch(new Request(`${base}/api/health`), ownerEnv);
    expect(await publicHealth.json()).toEqual({ ok: true });
    const adminHealth = await worker.fetch(
      new Request(`${base}/api/health`, { headers: { Authorization: `Bearer ${ADMIN}` } }),
      ownerEnv,
    );
    expect(await adminHealth.json()).toEqual({
      ok: true,
      version: MIPI_VERSION,
      piDurable: "1.6.0",
      storageSchema: SUPPORTED_SCHEMA_VERSION,
      env: "production",
    });
  });
});

describe("export and restore", () => {
  it("round-trips the agent's data and reopens it", async () => {
    const owner = "round-trip";
    const { call, ownerEnv } = forOwner(owner);
    await seed(owner, "Remember the blue door");
    const before = await call<AdminStatus>("GET", "/api/admin/status");
    expect(before.state).toEqual({ kind: "open" });
    expect(before.meta.app_version).toBe(MIPI_VERSION);

    const exported = await exportAll(call);
    expect(exported.consistent).toBe(true);
    expect(exported.header.meta.app_version).toBe(MIPI_VERSION);
    expect(exported.header.schema.some(({ name }) => name.startsWith("_cf_"))).toBe(false);
    expect(countsOf(exported.rows)).toEqual(before.rows);

    // Something written after the export is gone after the restore.
    await seed(owner, "A later message");
    expect((await userTexts(owner)).length).toBe(2);

    await expect(
      call("POST", "/api/admin/restore/begin", { header: exported.header, confirm: "wrong" }),
    ).rejects.toThrow(/Confirm the restore/);
    await call("POST", "/api/admin/restore/begin", {
      header: exported.header,
      confirm: MIPI_VERSION,
    });
    // Doors are closed while it runs.
    const during = await worker.fetch(
      withSpikeToken(`${base}/api/sessions/${owner}`, { headers: { Upgrade: "websocket" } }),
      ownerEnv,
    );
    expect(during.status).toBe(503);
    await during.body?.cancel();

    for (let index = 0; index < exported.rows.length; index += 7) {
      await call("POST", "/api/admin/restore/rows", {
        rows: exported.rows.slice(index, index + 7),
      });
    }
    const after = await call<AdminStatus>("POST", "/api/admin/restore/end", {
      rows: countsOf(exported.rows),
    });
    expect(after.state).toEqual({ kind: "open" });
    expect(after.rows).toEqual(before.rows);
    expect(after.meta.restoring).toBeUndefined();

    const texts = await userTexts(owner);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Remember the blue door");

    // And it works: a WebSocket opens again.
    const socket = await worker.fetch(
      withSpikeToken(`${base}/api/sessions/${owner}`, { headers: { Upgrade: "websocket" } }),
      ownerEnv,
    );
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close(1000, "done");
  });

  it("fails an export that something wrote during", async () => {
    const owner = "export-write";
    const { call } = forOwner(owner);
    await seed(owner, "hello");
    await call("POST", "/api/admin/export/begin");
    await runInDurableObject(env.AGENT.getByName(owner), async (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE stray (x)");
    });
    const { consistent } = await call<{ consistent: boolean }>("POST", "/api/admin/export/end");
    expect(consistent).toBe(false);
    expect((await call<AdminStatus>("GET", "/api/admin/status")).state).toEqual({ kind: "open" });
  });

  it("refuses a restore whose rows don't match the export, and stays closed", async () => {
    const owner = "restore-short";
    const { call, stub } = forOwner(owner);
    await seed(owner, "hello");
    const exported = await exportAll(call);
    await call("POST", "/api/admin/restore/begin", {
      header: exported.header,
      confirm: MIPI_VERSION,
    });
    await call("POST", "/api/admin/restore/rows", { rows: exported.rows.slice(0, 3) });
    await expect(
      call("POST", "/api/admin/restore/end", { rows: countsOf(exported.rows) }),
    ).rejects.toThrow(/don't match the export/);

    // A restart mid-restore stays in maintenance: neither an alarm nor a socket opens partial data.
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    const status = await call<AdminStatus>("GET", "/api/admin/status");
    expect(status.state).toEqual({ kind: "maintenance", mode: "restore" });
    expect(status.meta.restoring).toBe("1");
  });
});

describe("startup guard", () => {
  const refusedAfter = async (owner: string, tamper: (sql: SqlStorage) => void) => {
    const { call, ownerEnv, stub } = forOwner(owner);
    await seed(owner, "hello");
    await runInDurableObject(stub, async (_instance, state) => tamper(state.storage.sql));
    await evictDurableObject(stub);

    const socket = await worker.fetch(
      withSpikeToken(`${base}/api/sessions/${owner}`, { headers: { Upgrade: "websocket" } }),
      ownerEnv,
    );
    expect(socket.status).toBe(503);
    const body = (await socket.json()) as { reason: string };
    // An alarm doesn't open it either.
    await runDurableObjectAlarm(stub);
    const status = await call<AdminStatus>("GET", "/api/admin/status");
    expect(status.state.kind).toBe("refused");
    return { body, call };
  };

  it("refuses a newer storage schema", async () => {
    const { body } = await refusedAfter("guard-schema", (sql) =>
      sql.exec("UPDATE durable_schema SET version = version + 1 WHERE singleton = 1"),
    );
    expect(body.reason).toMatch(
      new RegExp(
        `schema ${SUPPORTED_SCHEMA_VERSION + 1} is newer than this build's ${SUPPORTED_SCHEMA_VERSION}`,
      ),
    );
    expect(body.reason).toContain(`this build is ${MIPI_VERSION}`);
  });

  it("refuses tasks written by a newer Pi Durable, and still allows an export", async () => {
    const { body, call } = await refusedAfter("guard-task", (sql) =>
      sql.exec(
        "UPDATE tasks SET record = json_set(record, '$.version', 99) WHERE json_extract(record, '$.kind') = 'pi.generation'",
      ),
    );
    expect(body.reason).toContain("pi.generation v99 (this build: v3)");

    // The data this build can't open can still be exported, to restore elsewhere.
    const exported = await exportAll(call);
    expect(exported.rows.length).toBeGreaterThan(0);
    expect((await call<AdminStatus>("GET", "/api/admin/status")).state.kind).toBe("refused");
  });
});

describe("export pages", () => {
  it("pages by rows and size, keeps blobs, and restores tables with integer primary keys", async () => {
    await runInDurableObject(env.AGENT.getByName("pages"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE a_items (id INTEGER PRIMARY KEY, name TEXT, data BLOB)");
      sql.exec("CREATE TABLE b_notes (body TEXT)");
      sql.exec("CREATE INDEX b_notes_body ON b_notes (body)");
      for (let index = 1; index <= 5; index += 1) {
        sql.exec(
          "INSERT INTO a_items (id, name, data) VALUES (?, ?, ?)",
          index * 10,
          `item ${index}`,
          new Uint8Array([index, 0, 255]).buffer,
        );
      }
      sql.exec("INSERT INTO b_notes (body) VALUES ('x'), ('y')");

      const schema = readSchema(sql).filter(
        ({ table }) => table === "a_items" || table === "b_notes",
      );
      const pages: ExportPage[] = [];
      let page: ExportPage | undefined;
      do {
        page = exportPage(sql, schema, page?.next, { maxRows: 2, maxChars: 10_000 });
        pages.push(page);
      } while (page.next !== undefined);
      const rows = pages.flatMap(({ rows: pageRows }) => pageRows);
      expect(pages.map(({ rows: pageRows }) => pageRows.length)).toEqual([2, 2, 2, 1]);
      expect(rows.map(({ table }) => table)).toEqual([
        ...Array(5).fill("a_items"),
        "b_notes",
        "b_notes",
      ]);
      expect(rows[0]!.values.data).toEqual({ $b64: btoa(String.fromCharCode(1, 0, 255)) });

      // A size limit cuts a page early.
      expect(exportPage(sql, schema, undefined, { maxRows: 100, maxChars: 1 }).rows).toHaveLength(
        1,
      );

      // Restore into fresh tables: drop and recreate from the exported DDL.
      sql.exec("DROP TABLE a_items");
      sql.exec("DROP TABLE b_notes");
      restoreSchema(sql, {
        format: "mipi-export",
        formatVersion: 1,
        exportedAt: "",
        meta: {},
        schema,
      });
      restoreRows(sql, schema, rows);
      const restored = sql
        .exec<{ id: number; data: ArrayBuffer }>("SELECT id, data FROM a_items ORDER BY id")
        .toArray();
      expect(restored.map(({ id }) => id)).toEqual([10, 20, 30, 40, 50]);
      expect([...new Uint8Array(restored[2]!.data)]).toEqual([3, 0, 255]);
      expect(rowCounts(sql)).toMatchObject({ a_items: 5, b_notes: 2 });
      expect(() => restoreRows(sql, schema, [{ table: "_cf_KV", rowid: 1, values: {} }])).toThrow(
        /unknown table/,
      );
    });
  });
});
