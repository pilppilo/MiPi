import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAG_DEFAULT_LIMIT,
  DIAG_MAX_LIMIT,
  DIAG_TABLE,
  type DiagInput,
  DiagLog,
  type DiagSql,
  diagDetail,
  sanitizeDiag,
} from "../src/agent/diag.ts";
import { createConnectors, diagOf } from "../src/agent/connectors.ts";
import { runAlarmConsumers } from "../src/agent/alarm.ts";
import { WakeSources } from "../src/agent/wake-sources.ts";
import worker from "../src/worker/index.ts";
import { withSpikeToken } from "./spike.ts";

const event = (overrides: Partial<DiagInput> = {}): DiagInput => ({
  level: "info",
  source: "do",
  kind: "test.event",
  outcome: "ok",
  summary: "A test event",
  ...overrides,
});

const tableExists = (sql: SqlStorage): boolean =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE name = ?", DIAG_TABLE).toArray().length > 0;

/** A fresh object's SQLite, with the agent's own startup events removed. */
const freshSql = (owner: string, run: (sql: SqlStorage) => void | Promise<void>) =>
  runInDurableObject(env.AGENT.getByName(owner), async (_instance, state) => {
    state.storage.sql.exec(`DROP TABLE IF EXISTS ${DIAG_TABLE}`);
    await run(state.storage.sql);
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("diagnostic log storage", () => {
  it("reads a fresh database as empty without creating the table", async () => {
    await freshSql("diag-fresh", (sql) => {
      const log = new DiagLog(sql);
      expect(log.read()).toEqual([]);
      expect(log.read({ after: 0, source: "do", levels: ["error"] })).toEqual([]);
      expect(tableExists(sql)).toBe(false);
      log.emit(event());
      expect(tableExists(sql)).toBe(true);
    });
  });

  it("caps the row count on insert and keeps ids rising", async () => {
    await freshSql("diag-cap", (sql) => {
      const log = new DiagLog(sql, { maxRows: 5 });
      for (let index = 0; index < 12; index += 1) log.emit(event({ summary: `event ${index}` }));
      const rows = log.read();
      expect(rows).toHaveLength(5);
      expect(rows.map(({ summary }) => summary)).toEqual([
        "event 7",
        "event 8",
        "event 9",
        "event 10",
        "event 11",
      ]);
      const ids = rows.map(({ id }) => id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(5);
      expect(sql.exec(`SELECT count(*) AS n FROM ${DIAG_TABLE}`).one().n).toBe(5);
      // Trimmed ids are never reused: AUTOINCREMENT.
      log.emit(event({ summary: "after trim" }));
      expect(log.read().at(-1)!.id).toBeGreaterThan(ids.at(-1)!);
    });
  });

  it("filters by cursor, source and level, and bounds the limit", async () => {
    await freshSql("diag-read", (sql) => {
      const log = new DiagLog(sql);
      for (let index = 0; index < 10; index += 1) {
        log.emit(
          event({
            source: index % 2 === 0 ? "do" : "gate",
            level: index % 3 === 0 ? "error" : "info",
            summary: `event ${index}`,
          }),
        );
      }
      const all = log.read();
      expect(all).toHaveLength(10);
      const cursor = all[3]!.id;
      expect(log.read({ after: cursor, limit: 2 }).map(({ summary }) => summary)).toEqual([
        "event 4",
        "event 5",
      ]);
      // Without a cursor: the newest `limit`, oldest first.
      expect(log.read({ limit: 3 }).map(({ summary }) => summary)).toEqual([
        "event 7",
        "event 8",
        "event 9",
      ]);
      expect(log.read({ source: "gate" }).every(({ source }) => source === "gate")).toBe(true);
      expect(log.read({ source: "gate" })).toHaveLength(5);
      expect(log.read({ levels: ["error"] }).map(({ summary }) => summary)).toEqual([
        "event 0",
        "event 3",
        "event 6",
        "event 9",
      ]);
      expect(log.read({ source: "do", levels: ["error"] })).toHaveLength(2);
      for (let index = 0; index < DIAG_MAX_LIMIT + 50; index += 1) log.emit(event());
      expect(log.read()).toHaveLength(DIAG_DEFAULT_LIMIT);
      expect(log.read({ limit: 10_000 })).toHaveLength(DIAG_MAX_LIMIT);
      expect(log.read({ limit: 0 })).toHaveLength(DIAG_DEFAULT_LIMIT);
    });
  });

  it("round-trips every field and skips rows it can't read", async () => {
    await freshSql("diag-fields", (sql) => {
      const log = new DiagLog(sql, { now: () => 1_000 });
      log.emit(
        event({
          level: "warn",
          outcome: "held",
          reqId: "tg:42",
          convId: 7,
          taskId: "task-1",
          durationMs: 12.6,
          detail: { gate: "spend-cap", count: 2, active: true },
        }),
      );
      sql.exec(
        `INSERT INTO ${DIAG_TABLE} (ts, level, source, kind, outcome, summary) VALUES (1, 'loud', 'do', 'x', 'ok', 'bad')`,
      );
      expect(log.read()).toEqual([
        {
          id: expect.any(Number),
          ts: 1_000,
          level: "warn",
          source: "do",
          kind: "test.event",
          outcome: "held",
          summary: "A test event",
          reqId: "tg:42",
          convId: 7,
          taskId: "task-1",
          durationMs: 13,
          detail: { gate: "spend-cap", count: 2, active: true },
        },
      ]);
    });
  });

  it("starts the table again after a restore wiped it (`reset`)", async () => {
    await freshSql("diag-reset", (sql) => {
      const log = new DiagLog(sql);
      log.emit(event());
      sql.exec(`DROP TABLE ${DIAG_TABLE}`);
      log.reset();
      log.emit(event({ summary: "after restore" }));
      expect(log.read().map(({ summary }) => summary)).toEqual(["after restore"]);
    });
  });

  it("stores nothing when it may not write, and logs the event instead", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await freshSql("diag-no-write", (sql) => {
      let writable = false;
      const seen: number[] = [];
      const log = new DiagLog(sql, { canWrite: () => writable, onEmit: ({ id }) => seen.push(id) });
      log.emit(event({ summary: "during maintenance" }));
      expect(tableExists(sql)).toBe(false);
      expect(seen).toEqual([]);
      expect(logged.mock.calls.flat().join(" ")).toContain("during maintenance");
      writable = true;
      log.emit(event({ summary: "after" }));
      expect(seen).toEqual([log.read()[0]!.id]);
    });
  });

  it("never throws, and reports a failing write once", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: DiagSql = {
      exec() {
        throw new Error("SQLITE_FULL");
      },
    };
    const log = new DiagLog(broken, {
      onEmit: () => {
        throw new Error("never reached");
      },
    });
    expect(() => {
      log.emit(event());
      log.emit(event());
    }).not.toThrow();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("SQLITE_FULL");

    // A listener that throws doesn't undo the write or reach the emitter.
    await freshSql("diag-listener", (sql) => {
      const listened = new DiagLog(sql, {
        onEmit: () => {
          throw new Error("listener");
        },
      });
      expect(() => listened.emit(event())).not.toThrow();
      expect(listened.read()).toHaveLength(1);
    });
  });
});

describe("diagnostic guardrail", () => {
  it("keeps summaries to one scrubbed line of at most 200 characters", () => {
    const clean = sanitizeDiag(
      event({
        summary: [
          "POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed",
          "Authorization: Bearer abc.def-ghi",
          "proxy: basic dXNlcjpwYXNzd29yZA==",
          "key sk-live_0123456789abcdef and jwt eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM",
          "GET /api/x?token=s3cr3t&ok=1",
        ].join("\n"),
      }),
      5,
    );
    expect(clean.summary).not.toMatch(/\n/);
    expect(clean.summary).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(clean.summary).not.toContain("abc.def-ghi");
    expect(clean.summary).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(clean.summary).not.toContain("0123456789abcdef");
    expect(clean.summary).not.toContain("eyJzdWIiOi");
    expect(clean.summary).not.toContain("s3cr3t");
    expect(clean.summary).toContain("ok=1");
    expect(clean.summary.length).toBeLessThanOrEqual(200);
    expect(clean.ts).toBe(5);

    const long = sanitizeDiag(event({ summary: "x".repeat(500) }), 0).summary;
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("keeps detail flat, small and free of content and secrets", () => {
    const detail = diagDetail({
      prompt: "What did I say yesterday?",
      body: "{}",
      text: "hello",
      message: "hi",
      content: "x",
      botToken: "123:abc",
      apiKey: "k",
      api_key: "k",
      authorization: "Bearer x",
      cookie: "a=b",
      jwt: "eyJ",
      password: "p",
      clientSecret: "s",
      nested: { a: 1 },
      list: [1],
      missing: undefined,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      "bad key": 1,
      provider: "opencode-go",
      reason: "line one\nline two Bearer zzz",
      count: 3,
      ok: false,
    });
    expect(detail).toEqual({
      provider: "opencode-go",
      reason: "line one line two Bearer [redacted]",
      count: 3,
      ok: false,
    });
    const many = diagDetail(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])));
    expect(Object.keys(many!)).toHaveLength(12);
    expect(diagDetail({ prompt: "only content" })).toBeUndefined();
    expect(diagDetail({ value: "y".repeat(500) })!.value).toHaveLength(120);
  });

  it("drops ids and durations that aren't sane", () => {
    const clean = sanitizeDiag(event({ convId: -1, durationMs: Number.NaN, reqId: "" }), 0);
    expect(clean).not.toHaveProperty("convId");
    expect(clean).not.toHaveProperty("durationMs");
    expect(clean).not.toHaveProperty("reqId");
  });
});

describe("diagnostic connector", () => {
  it("defaults to a sink that drops everything", () => {
    const connectors = createConnectors([], []);
    expect(() => connectors.diag.emit(event())).not.toThrow();
    expect(diagOf({ extension: () => undefined })).toBeDefined();
  });

  it("records each alarm run and each consumer that failed", async () => {
    const emitted: DiagInput[] = [];
    const diag = { emit: (input: DiagInput) => emitted.push(input) };
    await runAlarmConsumers(
      [
        ["first", () => undefined],
        [
          "broken",
          () => {
            throw new Error("boom");
          },
        ],
      ],
      () => {},
      async () => {},
      diag,
    );
    expect(emitted.map(({ kind, outcome }) => `${kind}:${outcome}`)).toEqual([
      "alarm.consumer_failed:fault",
      "alarm.fired:fault",
    ]);
    expect(emitted[1]).toMatchObject({ level: "debug", detail: { consumers: 2, failed: 1 } });

    const sources = new WakeSources(() => {}, diag);
    sources.register({
      name: "flaky",
      wake: () => ({ active: false }),
      run: () => undefined,
      observes: () => {
        throw new Error("observe");
      },
    });
    sources.observe({ changes: [] });
    expect(emitted.at(-1)).toMatchObject({
      kind: "wake.refresh_failed",
      level: "error",
      detail: { wakeSource: "flaky" },
    });
  });
});

describe("the agent's diagnostic log", () => {
  it("records each start and keeps its events across a restart", async () => {
    const stub = env.AGENT.getByName("diag-restart");
    const first = await runInDurableObject(stub, (instance) => instance.diagEvents());
    expect(first.filter(({ kind }) => kind === "startup.open")).toHaveLength(1);
    expect(first.find(({ kind }) => kind === "startup.open")).toMatchObject({
      source: "do",
      level: "info",
      outcome: "ok",
    });
    await evictDurableObject(stub);
    const second = await runInDurableObject(stub, (instance) => instance.diagEvents());
    const opens = second.filter(({ kind }) => kind === "startup.open");
    expect(opens).toHaveLength(2);
    expect(opens[1]!.id).toBeGreaterThan(opens[0]!.id);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it("records the startup guard's refusal while refused", async () => {
    const owner: string = "diag-refused";
    const stub = env.AGENT.getByName(owner);
    // Opens once, so Pi Durable's tables exist, then the stored schema is made newer than this build.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("UPDATE durable_schema SET version = version + 1 WHERE singleton = 1"),
    );
    await evictDurableObject(stub);
    const socket = await worker.fetch(
      withSpikeToken(`https://example.com/api/sessions/${owner}`, {
        headers: { Upgrade: "websocket" },
      }),
      { ...env, MIPI_OWNER: owner } as Env,
    );
    expect(socket.status).toBe(503);
    await socket.body?.cancel();
    const events = await runInDurableObject(stub, (instance) => instance.diagEvents());
    const refused = events.find(({ kind }) => kind === "startup.refused");
    expect(refused).toMatchObject({
      source: "do",
      level: "error",
      outcome: "refused",
      detail: { cause: "startup-guard" },
    });
    expect(refused!.summary).toMatch(/newer than this build/);
    // Reading while refused writes nothing new.
    const again = await runInDurableObject(stub, (instance) => instance.diagEvents());
    expect(again).toEqual(events);
  });
});
