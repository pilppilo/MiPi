import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAG_TABLE, type DiagInput, DiagLog } from "../src/agent/diag.ts";
import { parseEventsQuery } from "../src/worker/admin.ts";
import worker from "../src/worker/index.ts";
import {
  type DiagEvent,
  type DiagSnapshot,
  parseDiagSnapshot,
  parseServerEventEnvelope,
  type ServerEvent,
} from "../src/protocol.ts";
import { eventLine, HEARTBEAT_EVENTS_PATH, recentFaultLines } from "../scripts/heartbeat-events.ts";
import { withSpikeToken } from "./spike.ts";

const ADMIN = "test-admin-token";
const base = "https://example.com";

const forOwner = (owner: string) => {
  const ownerEnv = { ...env, MIPI_OWNER: owner } as Env;
  /** `null`: no Authorization header at all. */
  const get = (path: string, token: string | null = ADMIN) =>
    worker.fetch(
      new Request(`${base}${path}`, {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      }),
      ownerEnv,
    );
  return { ownerEnv, get, stub: env.AGENT.getByName(owner) };
};

/** Writes events into an object's log beside its own, as its emitters would. */
const seed = (owner: string, events: readonly DiagInput[]) =>
  runInDurableObject(env.AGENT.getByName(owner), (_instance, state) => {
    const log = new DiagLog(state.storage.sql);
    for (const event of events) log.emit(event);
  });

const rowCount = (owner: string) =>
  runInDurableObject(env.AGENT.getByName(owner), (_instance, state) =>
    state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = ?", DIAG_TABLE).toArray()
      .length === 0
      ? 0
      : (state.storage.sql.exec(`SELECT count(*) AS n FROM ${DIAG_TABLE}`).one().n as number),
  );

const event = (overrides: Partial<DiagInput>): DiagInput => ({
  level: "info",
  source: "do",
  kind: "test.event",
  outcome: "ok",
  summary: "A test event",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/events", () => {
  it("needs the admin token", async () => {
    const { get } = forOwner("events-auth");
    const logged = vi.spyOn(console, "log");
    for (const token of [null, "wrong"]) {
      const response = await get("/api/admin/events", token);
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
    // Each refusal is a Worker diagnostic: route and status, never the token.
    const lines = logged.mock.calls.flat().map(String);
    const refusals = lines.filter((line) => line.includes('"kind":"auth.refused"'));
    expect(refusals).toHaveLength(2);
    expect(refusals.join("\n")).not.toContain("wrong");
    expect(refusals[0]).toContain("/api/admin/events");
  });

  it("validates every parameter", async () => {
    const { get } = forOwner("events-validate");
    for (const query of [
      "after=-1",
      "after=abc",
      "after=1.5",
      "limit=0",
      "limit=501",
      "limit=ten",
      "level=loud",
      "level=warn,",
      "level=",
      "source=",
      `source=${"x".repeat(65)}`,
      "cursor=1",
      "limit=1&limit=2",
    ]) {
      const response = await get(`/api/admin/events?${query}`);
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as { error: string }).error.length).toBeGreaterThan(0);
    }
    expect(parseEventsQuery(new URLSearchParams(""))).toEqual({ limit: 100 });
    expect(
      parseEventsQuery(new URLSearchParams("after=0&source=gate&level=warn,error,warn&limit=500")),
    ).toEqual({ after: 0, source: "gate", levels: ["warn", "error"], limit: 500 });
  });

  it("filters by cursor, source, levels and limit, and writes nothing", async () => {
    const owner = "events-filter";
    const { get } = forOwner(owner);
    await seed(owner, [
      event({ source: "gate", level: "warn", outcome: "held", summary: "held one" }),
      event({ source: "door:telegram", level: "error", outcome: "fault", summary: "send failed" }),
      event({ source: "gate", level: "info", summary: "settled" }),
      event({ source: "door:telegram", level: "debug", summary: "queued" }),
    ]);
    const read = async (query: string): Promise<DiagSnapshot> => {
      const response = await get(`/api/admin/events${query}`);
      expect(response.status).toBe(200);
      return parseDiagSnapshot(await response.json());
    };
    const before = await rowCount(owner);

    const all = await read("");
    expect(all.health).toMatchObject({ state: "open", overdueSchedules: 0 });
    expect(all.events.map(({ kind }) => kind)).toContain("startup.open");
    expect(all.events.slice(-4).map(({ summary }) => summary)).toEqual([
      "held one",
      "send failed",
      "settled",
      "queued",
    ]);

    const faults = await read("?level=warn,error");
    expect(faults.events.map(({ summary }) => summary)).toEqual(["held one", "send failed"]);
    expect((await read("?source=gate")).events.map(({ summary }) => summary)).toEqual([
      "held one",
      "settled",
    ]);
    const cursor = all.events.at(-3)!.id;
    expect((await read(`?after=${cursor}`)).events.map(({ summary }) => summary)).toEqual([
      "settled",
      "queued",
    ]);
    expect((await read(`?after=${cursor}&limit=1`)).events.map(({ summary }) => summary)).toEqual([
      "settled",
    ]);
    expect((await read("?limit=2")).events.map(({ summary }) => summary)).toEqual([
      "settled",
      "queued",
    ]);
    expect(await rowCount(owner)).toBe(before);
  });

  it("answers while the agent is refused, with why", async () => {
    const owner = "events-refused";
    const { get, stub } = forOwner(owner);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("UPDATE durable_schema SET version = version + 1 WHERE singleton = 1"),
    );
    await evictDurableObject(stub);
    const response = await get("/api/admin/events?level=error");
    expect(response.status).toBe(200);
    const { events, health } = parseDiagSnapshot(await response.json());
    expect(health.state).toBe("refused");
    expect(health.reason).toMatch(/newer than this build/);
    expect(health.overdueSchedules).toBe(0);
    expect(events.map(({ kind }) => kind)).toContain("startup.refused");
    expect(events.every(({ level }) => level === "error")).toBe(true);
  });
});

describe("Worker-only refusals", () => {
  it("log a bad webhook secret, relay token and unlock token without touching the agent's log", async () => {
    const owner = "events-worker-only";
    const ownerEnv = {
      ...env,
      MIPI_OWNER: owner,
      TELEGRAM_WEBHOOK_SECRET: "right-secret",
      RELAY_TOKEN: "right-relay-token",
    } as unknown as Env;
    // The object exists, with its own startup events.
    const before = await rowCount(owner);
    expect(before).toBeGreaterThan(0);
    const logged = vi.spyOn(console, "log");

    const webhook = await worker.fetch(
      new Request(`${base}/api/telegram`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
        body: "{}",
      }),
      ownerEnv,
    );
    expect(webhook.status).toBe(401);
    await webhook.body?.cancel();
    const relay = await worker.fetch(
      new Request(`${base}/api/relay`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-relay-token", "Idempotency-Key": "k1" },
        body: JSON.stringify({ text: "hi" }),
      }),
      ownerEnv,
    );
    expect(relay.status).toBe(401);
    await relay.body?.cancel();
    const crossSite = await worker.fetch(
      withSpikeToken(`${base}/api/sessions/${owner}`, {
        headers: { Upgrade: "websocket", Origin: "https://evil.example" },
      }),
      ownerEnv,
    );
    expect(crossSite.status).toBe(403);
    await crossSite.body?.cancel();

    const unlock = await worker.fetch(
      new Request(`${base}/api/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "a-wrong-guess" }),
      }),
      ownerEnv,
    );
    expect(unlock.status).toBe(401);
    await unlock.body?.cancel();

    const lines = logged.mock.calls.flat().map(String).join("\n");
    expect(lines).toContain("wrong unlock token");
    expect(lines).not.toContain("a-wrong-guess");
    expect(lines).toContain('"kind":"telegram.webhook_refused"');
    expect(lines).toContain('"kind":"relay.auth_refused"');
    expect(lines).toContain('"kind":"ws.cross_origin"');
    expect(lines).toContain('"source":"worker"');
    expect(lines).not.toContain("wrong-secret");
    expect(lines).not.toContain("wrong-relay-token");
    expect(await rowCount(owner)).toBe(before);
  });
});

/** A socket's frames, parsed and checked as a client would. */
const frames = (socket: WebSocket) => {
  const seen: ServerEvent[] = [];
  const waiting: Array<() => void> = [];
  socket.addEventListener("message", (message) => {
    seen.push(parseServerEventEnvelope(String(message.data)));
    for (const wake of waiting.splice(0)) wake();
  });
  const until = async <T extends ServerEvent>(match: (frame: ServerEvent) => boolean) => {
    for (;;) {
      const found = seen.find(match);
      if (found !== undefined) return found as T;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
  const result = (requestId: string) =>
    until<Extract<ServerEvent, { type: "command.result" }>>(
      (frame) => frame.type === "command.result" && frame.requestId === requestId,
    );
  const diagEvents = () =>
    seen.flatMap((frame) => (frame.type === "diag.event" ? [frame.event] : []));
  return { seen, until, result, diagEvents };
};

const connect = async (owner: string) => {
  const response = await env.AGENT.getByName(owner).fetch(
    new Request(`${base}/api/sessions/${owner}`, { headers: { Upgrade: "websocket" } }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const received = frames(socket);
  const view = await received.until<Extract<ServerEvent, { type: "conversation.view" }>>(
    (frame) => frame.type === "conversation.view",
  );
  const send = (command: Record<string, unknown>) => socket.send(JSON.stringify(command));
  return { socket, send, opened: view.conversationId, ...received };
};

describe("diagnostic live tail", () => {
  it("streams events only to subscribed sockets, from `after`, until unsubscribed", async () => {
    const owner = "diag-tail";
    const watcher = await connect(owner);
    const chatter = await connect(owner);

    watcher.send({ type: "diag.subscribe", requestId: "sub", limit: 5 });
    const subscribed = await watcher.result("sub");
    expect(subscribed.ok).toBe(true);
    const first = subscribed.ok ? subscribed.diag! : undefined;
    expect(first!.health.state).toBe("open");
    expect(first!.events.length).toBeLessThanOrEqual(5);
    expect(first!.events.map(({ kind }) => kind)).toContain("ws.connect");
    const lastSeen = first!.events.at(-1)!.id;

    // The subscription is in the socket's attachment, and a conversation switch keeps it.
    watcher.send({ type: "conversation.open", requestId: "open", conversationId: watcher.opened });
    await watcher.result("open");
    const attachments = await runInDurableObject(env.AGENT.getByName(owner), (_instance, state) =>
      state.getWebSockets().map((socket) => socket.deserializeAttachment() as { diag?: true }),
    );
    expect(attachments.filter(({ diag }) => diag === true)).toHaveLength(1);

    // A failed command on the other socket is an event: the watcher gets it, the chatter doesn't.
    chatter.send({ type: "conversation.open", requestId: "missing", conversationId: 9_999 });
    expect((await chatter.result("missing")).ok).toBe(false);
    const live = await watcher.until<Extract<ServerEvent, { type: "diag.event" }>>(
      (frame) => frame.type === "diag.event" && frame.event.kind === "ws.command_failed",
    );
    expect(live.event).toMatchObject({
      source: "door:web",
      level: "warn",
      reqId: "missing",
      detail: { command: "conversation.open" },
    });
    expect(chatter.diagEvents()).toEqual([]);

    // `after` gives only what came since.
    watcher.send({ type: "diag.subscribe", requestId: "again", after: lastSeen });
    const again = await watcher.result("again");
    const since: readonly DiagEvent[] = again.ok ? again.diag!.events : [];
    expect(since.length).toBeGreaterThan(0);
    expect(since.every(({ id }) => id > lastSeen)).toBe(true);
    expect(since.map(({ kind }) => kind)).toContain("ws.command_failed");

    watcher.send({ type: "diag.unsubscribe", requestId: "unsub" });
    expect((await watcher.result("unsub")).ok).toBe(true);
    const streamed = watcher.diagEvents().length;
    chatter.send({ type: "conversation.open", requestId: "missing-2", conversationId: 9_998 });
    expect((await chatter.result("missing-2")).ok).toBe(false);
    // A round trip on the watcher: anything sent to it before now has arrived.
    watcher.send({ type: "diag.unsubscribe", requestId: "ping" });
    await watcher.result("ping");
    expect(watcher.diagEvents()).toHaveLength(streamed);
    expect(chatter.diagEvents()).toEqual([]);

    watcher.socket.close(1000, "done");
    chatter.socket.close(1000, "done");
  });

  // The order the client relies on (`usePiSession` takes live events only after the answer). The race the agent's
  // ordering closes needs an event from background work during the health read; another socket's command waits behind
  // the object's input gate here, so this checks the order and that nothing is lost, not the race itself.
  it("answers a subscription before any live event, and loses none around it", async () => {
    const owner = "diag-tail-race";
    const chatter = await connect(owner);
    for (let round = 0; round < 5; round += 1) {
      const watcher = await connect(owner);
      // Back to back: the chatter's failure is emitted while the subscription reads the health.
      watcher.send({ type: "diag.subscribe", requestId: `sub-${round}`, limit: 500 });
      chatter.send({
        type: "conversation.open",
        requestId: `race-${round}`,
        conversationId: 9_000 + round,
      });
      await chatter.result(`race-${round}`);
      const result = await watcher.result(`sub-${round}`);
      // A round trip on the watcher, so any live frame for it has arrived.
      watcher.send({ type: "diag.unsubscribe", requestId: `ping-${round}` });
      await watcher.result(`ping-${round}`);

      const order = watcher.seen.flatMap((frame) =>
        frame.type === "diag.event"
          ? ["event"]
          : frame.type === "command.result" && frame.requestId === `sub-${round}`
            ? ["result"]
            : [],
      );
      expect(order[0], `round ${round}`).toBe("result");
      const snapshot = result.ok ? result.diag!.events : [];
      const held = [...snapshot, ...watcher.diagEvents()];
      expect(
        held.filter(({ kind, reqId }) => kind === "ws.command_failed" && reqId === `race-${round}`),
        `round ${round}`,
      ).toHaveLength(1);
      watcher.socket.close(1000, "done");
    }
    chatter.socket.close(1000, "done");
  });

  it("refuses a subscription outside its bounds", async () => {
    const owner = "diag-tail-bounds";
    for (const command of [
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { after: -1 },
      { after: "1" },
    ]) {
      const client = await connect(owner);
      client.send({ type: "diag.subscribe", requestId: "bad", ...command });
      const error = await client.until((frame) => frame.type === "error");
      expect(error).toMatchObject({ type: "error", error: { code: "invalid_command" } });
    }
  });
});

describe("heartbeat's recent events", () => {
  const snapshot = (events: readonly DiagEvent[]): DiagSnapshot => ({
    events,
    health: { state: "open", overdueSchedules: 0 },
  });
  const fault: DiagEvent = {
    id: 7,
    ts: Date.UTC(2026, 10, 26, 12, 0, 0),
    level: "error",
    source: "door:telegram",
    kind: "telegram.send_failed",
    outcome: "fault",
    summary: "A Telegram send failed:\nchat not found",
  };

  it("asks for the latest warnings and errors and formats them as lines", async () => {
    const calls: string[] = [];
    const lines = await recentFaultLines(async <T>(_method: string, path: string) => {
      calls.push(path);
      return snapshot([fault]) as T;
    });
    expect(calls).toEqual([HEARTBEAT_EVENTS_PATH]);
    expect(HEARTBEAT_EVENTS_PATH).toBe("/api/admin/events?level=warn,error&limit=10");
    expect(lines).toEqual([
      "2026-11-26T12:00:00.000Z error door:telegram telegram.send_failed: A Telegram send failed: chat not found",
    ]);
    expect(eventLine(fault)).toBe(lines[0]);
    expect(await recentFaultLines(async <T>() => snapshot([]) as T)).toEqual([
      "No recent warnings or errors.",
    ]);
  });

  it("never fails the report when the events can't be read", async () => {
    expect(
      await recentFaultLines(async () => {
        throw new Error("GET /api/admin/events: 404\nNot found");
      }),
    ).toEqual(["Recent events unavailable: GET /api/admin/events: 404 Not found"]);
    expect(await recentFaultLines(async <T>() => ({ events: "nope" }) as T)).toEqual([
      "Recent events unavailable: The events answer has no event list",
    ]);
    expect(
      await recentFaultLines(async <T>() => ({ events: [{ ...fault, ts: "noon" }] }) as T),
    ).toEqual(["Recent events unavailable: An event in the answer is invalid"]);
  });
});
