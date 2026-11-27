/**
 * The web session core (COD-245), driven directly: a fake `Transport` and `Platform`, no React and no DOM. What the
 * hook used to do, the client does here, so these are the web client's connection behaviours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAG_CLIENT_MAX,
  diagReducer,
  initialDiagState,
  mergeDiagEvents,
} from "../src/client/session/diag-buffer.ts";
import type { Platform, TimerHandle, Visibility } from "../src/client/session/platform.ts";
import { SessionClient, USAGE_REFRESH_MS } from "../src/client/session/session-client.ts";
import type {
  Transport,
  TransportEvent,
  TransportRequest,
} from "../src/client/session/transport.ts";
import type { DiagEvent, DiagHealth } from "../src/protocol.ts";

/** One fake connection: what the client sent, and a way to play the agent's side. */
class FakeTransport implements Transport {
  readonly request: TransportRequest;
  open = false;
  readonly sent: Record<string, unknown>[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  constructor(request: TransportRequest) {
    this.request = request;
  }
  isOpen(): boolean {
    return this.open;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
  emit(event: TransportEvent): void {
    if (event.type === "open") this.open = true;
    if (event.type === "close") this.open = false;
    this.request.onEvent(event);
  }
  connected(): void {
    this.emit({ type: "open" });
  }
  receive(frame: object): void {
    this.emit({ type: "message", data: JSON.stringify(frame) });
  }
  /** A dropped connection, then the transport's own reconnect, if the client still wants one. */
  drop(code = 1006): boolean {
    this.emit({ type: "close", code, reason: "" });
    const again = this.request.shouldReconnect({ code });
    if (again) this.connected();
    return again;
  }
  types(): unknown[] {
    return this.sent.map(({ type }) => type);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

/** A platform with hand-run timers and visibility, and counting ids. */
function fakePlatform() {
  const timers = new Map<number, () => void>();
  const visibilityListeners = new Set<(visibility: Visibility) => void>();
  const errors: unknown[] = [];
  let ids = 0;
  let nextTimer = 1;
  const platform: Platform = {
    visibility: {
      current: () => "visible",
      subscribe(listener) {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
    storage: { get: () => undefined, set: () => {}, remove: () => {} },
    openLink: () => {},
    share: async () => false,
    randomId: () => `id-${++ids}`,
    setTimeout(callback) {
      const handle = nextTimer++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout(handle: TimerHandle) {
      timers.delete(handle as number);
    },
    logError: (_message, error) => errors.push(error),
  };
  return {
    platform,
    timers,
    errors,
    visibilityListeners,
    setVisibility: (visibility: Visibility) => {
      for (const listener of visibilityListeners) listener(visibility);
    },
    runTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    },
  };
}

function setup(options: { initialConversationId?: number } = {}) {
  const host = fakePlatform();
  const transports: FakeTransport[] = [];
  const client = new SessionClient({
    sessionId: "test-session",
    ...options,
    platform: host.platform,
    connect: (request) => {
      const transport = new FakeTransport(request);
      transports.push(transport);
      return transport;
    },
  });
  client.start();
  const transport = transports[0]!;
  return { client, host, transports, transport };
}

const snapshot = (
  capabilities?: readonly string[],
  conversations: object[] = [{ id: 1, kind: "main" }],
) => ({
  type: "session.snapshot",
  session: { conversations, ...(capabilities === undefined ? {} : { capabilities }) },
});

const ALL = ["activity", "diagnostics", "usage"];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the session client's connection", () => {
  it("opens the chat channel for the session's room, and reports the connection", () => {
    const { client, transport } = setup();
    expect(transport.request).toMatchObject({ channel: "chat", room: "test-session" });
    expect(client.getState().session.status).toBe("connecting");
    const seen: string[] = [];
    client.subscribe(() => seen.push(client.getState().session.status));
    transport.connected();
    expect(client.getState().session.status).toBe("connected");
    expect(seen).toContain("connected");
    // The same state object while nothing changes, so a view doesn't re-render.
    const before = client.getState();
    transport.receive({ type: "conversation.created", conversation: { id: 1 } });
    expect(client.getState()).not.toBe(before);
    const after = client.getState();
    transport.receive({ type: "conversation.head", conversationId: 99, latestEntryId: 1 });
    expect(client.getState()).toBe(after);
  });

  it("asks for options and usage when the session opens, and opens the conversation it was asked for", () => {
    const { client, transport } = setup({ initialConversationId: 6 });
    transport.connected();
    transport.receive(
      snapshot(ALL, [
        { id: 1, kind: "main" },
        { id: 6, kind: "bot", name: "Garden" },
      ]),
    );
    expect(transport.sent).toEqual([
      { type: "options.list", requestId: "id-1" },
      { type: "usage.read", requestId: "id-2" },
      { type: "conversation.open", requestId: "id-3", conversationId: 6 },
    ]);
    expect(client.getState().session.activeConversationId).toBe(6);
    // A snapshot later in the same connection (a bot made elsewhere) asks for nothing again.
    transport.clear();
    transport.receive(snapshot(ALL));
    expect(transport.sent).toEqual([]);
  });

  it("replays unacknowledged commands after a reconnect, and settles them on their results", async () => {
    const { client, transport } = setup();
    transport.connected();
    transport.receive(snapshot(ALL));
    transport.clear();
    const accepted = client.submitPrompt(1, "hello");
    expect(transport.sent).toEqual([
      { type: "prompt.submit", requestId: "id-3", conversationId: 1, content: "hello" },
    ]);
    // A second prompt while one is pending is a mistake in the view.
    expect(() => client.submitPrompt(1, "again")).toThrow("already pending");

    expect(transport.drop()).toBe(true);
    expect(client.getState().session.status).toBe("connected");
    transport.clear();
    transport.receive(snapshot(ALL));
    expect(transport.sent.filter(({ type }) => type === "prompt.submit")).toEqual([
      { type: "prompt.submit", requestId: "id-3", conversationId: 1, content: "hello" },
    ]);
    transport.receive({
      type: "command.result",
      command: "prompt.submit",
      requestId: "id-3",
      ok: true,
      conversationId: 1,
      submissionId: 4,
    });
    await expect(accepted).resolves.toBe(true);
  });

  it("refuses commands while not connected, and drops waiting ones when stopped", async () => {
    const { client, transport } = setup();
    await expect(client.createBot({ name: "x", purpose: "y", profile: "default" })).resolves.toBe(
      false,
    );
    expect(client.getState().session.error).toBe("The session is not connected");
    transport.connected();
    transport.receive(snapshot(ALL));
    const accepted = client.createCobot(1, "Side");
    client.stop();
    await expect(accepted).resolves.toBe(false);
    expect(transport.closes).toEqual([{ code: 1000, reason: "Session view closed" }]);
    // A close the transport reports after it carries no reconnect.
    transport.emit({ type: "close", code: 1000, reason: "" });
    expect(client.getState().session.status).toBe("connected");
  });

  it("fails for good on a protocol error, with the agent's reason, and never reconnects", () => {
    const { client, host, transport } = setup();
    transport.connected();
    transport.receive({ type: "conversation.head", conversationId: 0 });
    expect(host.errors).toHaveLength(1);
    expect(transport.closes).toEqual([{ code: 1002, reason: "Invalid protocol frame" }]);
    expect(transport.drop(1002)).toBe(false);
    expect(client.getState().session).toMatchObject({
      status: "failed",
      error: "Server sent an invalid protocol frame.",
    });

    const binary = setup();
    binary.transport.connected();
    binary.transport.emit({ type: "binary" });
    expect(binary.transport.closes).toEqual([{ code: 1002, reason: "Binary protocol frame" }]);

    const refused = setup();
    refused.transport.connected();
    refused.transport.receive({
      type: "error",
      error: { code: "invalid_command", message: "This build doesn't know that." },
    });
    expect(refused.transport.drop(1000)).toBe(false);
    expect(refused.client.getState().session).toMatchObject({
      status: "failed",
      error: "This build doesn't know that.",
    });
  });

  it("pages a transcript through conversation.entries, and rejects pages in flight on a close", async () => {
    const { client, transport } = setup();
    transport.connected();
    transport.receive(snapshot(ALL));
    transport.receive({
      type: "conversation.view",
      conversationId: 1,
      view: {
        conversation: { id: 1 },
        entries: [
          {
            id: 41,
            conversationId: 1,
            kind: "pi.user",
            model: [{ role: "user", content: "x", timestamp: 1 }],
          },
        ],
        docs: {},
        // Entries before 40 exist but are outside the view's window.
        before: 40,
      },
    });
    transport.clear();
    client.loadEarlier(1);
    await vi.waitFor(() => expect(transport.types()).toContain("conversation.entries"));
    const request = transport.sent.find(({ type }) => type === "conversation.entries")!;
    expect(request).toMatchObject({ conversationId: 1, order: "descending" });
    transport.drop();
    // The transcript reports the closed connection as the session's error.
    await vi.waitFor(() =>
      expect(client.getState().session.error).toBe("The session connection closed"),
    );
  });
});

describe("the usage line's reads", () => {
  it("reads on the session opening and the owner's message, at most every 30 s, with one trailing read", () => {
    const { host, transport } = setup();
    transport.connected();
    transport.receive(snapshot(["usage"]));
    expect(transport.types()).toEqual(["options.list", "usage.read"]);
    transport.clear();
    // Work runs right away: one trailing read is scheduled, not a read per event.
    transport.receive({ type: "session.activity", activity: { tasks: {} } });
    transport.receive({ type: "session.activity", activity: { tasks: {} } });
    expect(transport.sent).toEqual([]);
    expect(host.timers.size).toBe(1);
    vi.setSystemTime(1_000_000 + USAGE_REFRESH_MS);
    host.runTimers();
    expect(transport.types()).toEqual(["usage.read"]);
    // Coming back into view reads again once the 30 s have passed; going away doesn't.
    transport.clear();
    vi.setSystemTime(1_000_000 + 2 * USAGE_REFRESH_MS);
    host.setVisibility("hidden");
    expect(transport.sent).toEqual([]);
    host.setVisibility("visible");
    expect(transport.types()).toEqual(["usage.read"]);
  });

  it("forces a read only when a live update changes the run failure", () => {
    const { transport } = setup();
    transport.connected();
    transport.receive(snapshot(["usage"]));
    transport.clear();
    const failure = { taskId: 9, inputs: [3], reason: "model_error", detail: "401 Unauthorized" };
    const view = {
      type: "conversation.view",
      conversationId: 1,
      view: { conversation: { id: 1 }, entries: [], docs: { "pi.live": { runFailure: failure } } },
    };
    const patch = (operation: unknown[]) =>
      transport.receive({ type: "conversation.ops", conversationId: 1, ops: [operation] });
    const failurePath = ["docs", "pi.live", "runFailure"];
    transport.receive(view);
    patch(["s", failurePath, failure]);
    expect(transport.sent).toEqual([]);
    patch(["s", failurePath, { ...failure, taskId: 10 }]);
    patch(["s", failurePath, { ...failure, taskId: 11 }]);
    expect(transport.types()).toEqual(["usage.read", "usage.read"]);
    patch(["d", failurePath]);
    transport.receive(view);
    expect(transport.sent).toHaveLength(2);
  });

  it("stops its timer and visibility listener when stopped", () => {
    const { client, host, transport } = setup();
    transport.connected();
    transport.receive(snapshot(["usage"]));
    transport.receive({ type: "session.activity", activity: { tasks: {} } });
    expect(host.timers.size).toBe(1);
    expect(host.visibilityListeners.size).toBe(1);
    client.stop();
    expect(host.timers.size).toBe(0);
    expect(host.visibilityListeners.size).toBe(0);
  });
});

const diagEvent = (id: number, overrides: Partial<DiagEvent> = {}): DiagEvent => ({
  id,
  ts: 1_000 + id,
  level: "info",
  source: "do",
  kind: "test.event",
  outcome: "ok",
  summary: `event ${id}`,
  ...overrides,
});
const health: DiagHealth = { state: "open", overdueSchedules: 0 };

describe("the diagnostic buffer", () => {
  it("keeps one event per id, oldest first, and at most the cap", () => {
    const merged = mergeDiagEvents(
      [diagEvent(3), diagEvent(1)],
      [diagEvent(2), diagEvent(3, { summary: "newer copy" })],
    );
    expect(merged.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(merged[2]!.summary).toBe("newer copy");
    const many = Array.from({ length: DIAG_CLIENT_MAX + 20 }, (_, index) => diagEvent(index + 1));
    const capped = mergeDiagEvents([], many);
    expect(capped).toHaveLength(DIAG_CLIENT_MAX);
    expect(capped[0]!.id).toBe(21);
    expect(capped.at(-1)!.id).toBe(DIAG_CLIENT_MAX + 20);
  });

  it("adds live events only while subscribed, and keeps what it has when it stops", () => {
    let current = diagReducer(initialDiagState, { type: "event", event: diagEvent(1) });
    expect(current).toBe(initialDiagState);
    current = diagReducer(current, { type: "snapshot", events: [diagEvent(2)], health });
    expect(current).toMatchObject({ subscribed: true, health, error: undefined });
    current = diagReducer(current, { type: "event", event: diagEvent(3) });
    current = diagReducer(current, { type: "event", event: diagEvent(3) });
    expect(current.events.map(({ id }) => id)).toEqual([2, 3]);
    current = diagReducer(current, { type: "stopped" });
    expect(current.subscribed).toBe(false);
    expect(diagReducer(current, { type: "event", event: diagEvent(4) }).events).toHaveLength(2);
    expect(diagReducer(current, { type: "failed", message: "nope" })).toMatchObject({
      subscribed: false,
      error: "nope",
    });
  });
});

describe("the diagnostics live tail", () => {
  it("subscribes, takes the tail, catches up after a reconnect, and unsubscribes", () => {
    const { client, transport } = setup();
    transport.connected();
    // Before a snapshot says the agent has diagnostics (COD-246), nothing is sent: the snapshot subscribes.
    client.subscribeDiag();
    expect(transport.sent).toEqual([]);
    transport.receive(snapshot(["diagnostics"]));
    expect(transport.sent.at(-1)).toMatchObject({ type: "diag.subscribe", limit: 200 });
    const subscribeId = transport.sent.at(-1)!.requestId;

    // An event ahead of the subscription's answer is ignored, and doesn't move the catch-up point past it.
    transport.receive({ type: "diag.event", event: diagEvent(99) });
    expect(client.getState().diag.events).toEqual([]);

    const session = client.getState().session;
    transport.receive({
      type: "command.result",
      command: "diag.subscribe",
      requestId: subscribeId,
      ok: true,
      diag: { events: [diagEvent(4), diagEvent(5)], health },
    });
    transport.receive({ type: "diag.event", event: diagEvent(6) });
    expect(client.getState().diag).toMatchObject({ subscribed: true, health });
    expect(client.getState().diag.events.map(({ id }) => id)).toEqual([4, 5, 6]);
    // Diagnostic frames never touch the session state, so the transcript doesn't re-render for them.
    expect(client.getState().session).toBe(session);

    // A new socket's session: it asks again from the newest event held.
    transport.drop();
    expect(client.getState().diag.subscribed).toBe(false);
    transport.clear();
    transport.receive(snapshot(["diagnostics"]));
    const resubscribe = transport.sent.filter(({ type }) => type === "diag.subscribe");
    expect(resubscribe).toEqual([expect.objectContaining({ after: 6 })]);
    expect(resubscribe[0]).not.toHaveProperty("limit");

    // A catch-up keeps a limit when one is given, and asks for everything since when none is.
    transport.clear();
    client.subscribeDiag({ after: 6, limit: 50 });
    client.subscribeDiag({ after: 6 });
    expect(transport.sent).toEqual([
      expect.objectContaining({ type: "diag.subscribe", after: 6, limit: 50 }),
      expect.not.objectContaining({ limit: expect.anything() }),
    ]);

    transport.clear();
    client.unsubscribeDiag();
    expect(transport.types()).toEqual(["diag.unsubscribe"]);
    expect(client.getState().diag.subscribed).toBe(false);
    // A frame that crossed the unsubscribe is dropped, and the next session doesn't subscribe again.
    transport.receive({ type: "diag.event", event: diagEvent(7) });
    expect(client.getState().diag.events.map(({ id }) => id)).toEqual([4, 5, 6]);
    transport.drop();
    transport.clear();
    transport.receive(snapshot(["diagnostics"]));
    expect(transport.types()).not.toContain("diag.subscribe");
  });
});

// COD-246: version skew never breaks the session.
describe("capabilities and version skew", () => {
  it("ignores frames it doesn't know, and sends no optional request the agent didn't advertise", () => {
    const { client, host, transport } = setup();
    transport.connected();
    // An older agent: no capabilities. Chat opens; usage and diagnostics are never asked for.
    transport.receive(snapshot());
    expect(transport.types()).toEqual(["options.list"]);
    transport.receive({ type: "session.activity", activity: { tasks: {} } });
    client.subscribeDiag();
    client.unsubscribeDiag();
    host.setVisibility("visible");
    expect(transport.types()).toEqual(["options.list"]);
    expect(host.timers.size).toBe(0);

    // A newer agent's frames: an event type and a command result this client has never heard of.
    const before = client.getState();
    transport.receive({ type: "approvals.pending", items: [{ id: 1 }] });
    transport.receive({
      type: "command.result",
      command: "approval.resolve",
      requestId: "x",
      ok: true,
    });
    expect(transport.closes).toEqual([]);
    expect(host.errors).toEqual([]);
    expect(client.getState()).toBe(before);
  });

  it("forgets the agent's capabilities when the socket closes, until the next snapshot", () => {
    const { client, host, transport } = setup();
    transport.connected();
    transport.receive(snapshot(["diagnostics", "usage"]));
    expect(client.getState().session.capabilities).toEqual(new Set(["diagnostics", "usage"]));
    // A dropped connection: the next agent may be a rolled-back build.
    transport.drop();
    transport.clear();
    vi.setSystemTime(1_000_000 + USAGE_REFRESH_MS);
    client.subscribeDiag();
    host.setVisibility("visible");
    expect(transport.sent).toEqual([]);
    // The new agent's snapshot decides: it has neither.
    transport.receive(snapshot());
    expect(transport.types()).toEqual(["options.list"]);
    expect(client.getState().session.capabilities.size).toBe(0);
  });
});
