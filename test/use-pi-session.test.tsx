import { describe, expect, it, vi } from "vitest";
import { usePiSession } from "../src/client/usePiSession.ts";
import {
  DIAG_CLIENT_MAX,
  diagReducer,
  initialDiagState,
  mergeDiagEvents,
} from "../src/client/diag-buffer.ts";
import type { DiagEvent, DiagHealth } from "../src/protocol.ts";

const state = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  message: undefined as ((event: { data: string }) => void) | undefined,
  open: undefined as (() => void) | undefined,
  send: vi.fn(),
  close: vi.fn(),
  /** Each `useReducer`'s dispatch, by its reducer. */
  dispatches: new Map<unknown, ReturnType<typeof vi.fn>>(),
}));

// Run the effect once and deliver real protocol frames without a browser or network connection.
vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => () => void) => {
    state.cleanup = effect();
  },
  useReducer: (reducer: unknown, initial: unknown) => {
    const dispatch = vi.fn();
    state.dispatches.set(reducer, dispatch);
    return [initial, dispatch];
  },
  useRef: <T,>(current: T) => ({ current }),
  useState: () => [undefined, vi.fn()],
}));

vi.mock("partysocket", () => ({
  default: class {
    readonly OPEN = 1;
    readonly readyState = this.OPEN;
    readonly send = state.send;
    readonly close = state.close;
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      if (type === "message") state.message = listener;
      if (type === "open") state.open = listener as () => void;
    }
  },
}));

it("forces usage.read only when a live update changes the run failure", () => {
  const setTimeout = vi.fn();
  vi.stubGlobal("window", { location: { host: "localhost" }, setTimeout });
  vi.stubGlobal("document", new EventTarget());
  try {
    usePiSession("test");
    expect(state.message).toBeDefined();
    const receive = (frame: object) => state.message!({ data: JSON.stringify(frame) });
    // The agent advertises usage (COD-246); the snapshot's own reads are not what this test counts.
    receive({
      type: "session.snapshot",
      session: { conversations: [{ id: 1, kind: "main" }], capabilities: ["usage"] },
    });
    state.send.mockClear();
    const failure = { taskId: 9, inputs: [3], reason: "model_error", detail: "401 Unauthorized" };
    const view = {
      type: "conversation.view",
      conversationId: 1,
      view: { conversation: { id: 1 }, entries: [], docs: { "pi.live": { runFailure: failure } } },
    };
    const patch = (operation: unknown[]) =>
      receive({ type: "conversation.ops", conversationId: 1, ops: [operation] });
    const failurePath = ["docs", "pi.live", "runFailure"];

    receive(view);
    patch(["s", failurePath, failure]);
    expect(state.send).not.toHaveBeenCalled();

    patch(["s", failurePath, { ...failure, taskId: 10 }]);
    patch(["s", failurePath, { ...failure, taskId: 11 }]);
    expect(state.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      expect.objectContaining({ type: "usage.read" }),
      expect.objectContaining({ type: "usage.read" }),
    ]);
    expect(setTimeout).not.toHaveBeenCalled();

    patch(["d", failurePath]);
    receive(view);
    expect(state.send).toHaveBeenCalledTimes(2);
  } finally {
    state.cleanup?.();
    vi.unstubAllGlobals();
  }
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

it("subscribes, takes the tail, catches up after a reconnect, and unsubscribes", () => {
  state.send.mockClear();
  state.dispatches.clear();
  vi.stubGlobal("window", { location: { host: "localhost" }, setTimeout: vi.fn() });
  vi.stubGlobal("document", new EventTarget());
  try {
    const session = usePiSession("test");
    const receive = (frame: object) => state.message!({ data: JSON.stringify(frame) });
    const sent = () => state.send.mock.calls.map(([message]) => JSON.parse(message as string));
    const dispatchDiag = state.dispatches.get(diagReducer)!;
    const dispatchSession = [...state.dispatches.entries()].find(
      ([reducer]) => reducer !== diagReducer,
    )![1];

    // Before a snapshot says the agent has diagnostics (COD-246), nothing is sent: the snapshot subscribes.
    session.subscribeDiag();
    expect(sent().filter(({ type }) => type === "diag.subscribe")).toEqual([]);
    receive({
      type: "session.snapshot",
      session: { conversations: [{ id: 1, kind: "main" }], capabilities: ["diagnostics"] },
    });
    dispatchSession.mockClear();
    expect(sent().at(-1)).toMatchObject({ type: "diag.subscribe", limit: 200 });
    const subscribeId = sent().at(-1).requestId as string;

    // An event ahead of the subscription's answer is ignored, and doesn't move the catch-up point past it.
    receive({ type: "diag.event", event: diagEvent(99) });
    expect(dispatchDiag).not.toHaveBeenCalled();

    receive({
      type: "command.result",
      command: "diag.subscribe",
      requestId: subscribeId,
      ok: true,
      diag: { events: [diagEvent(4), diagEvent(5)], health },
    });
    expect(dispatchDiag).toHaveBeenLastCalledWith({
      type: "snapshot",
      events: [diagEvent(4), diagEvent(5)],
      health,
    });
    receive({ type: "diag.event", event: diagEvent(6) });
    expect(dispatchDiag).toHaveBeenLastCalledWith({ type: "event", event: diagEvent(6) });
    // Diagnostic frames never reach the session reducer, so the transcript doesn't re-render for them.
    expect(dispatchSession).not.toHaveBeenCalled();

    // A new socket's session: it asks again from the newest event held.
    state.send.mockClear();
    state.open!();
    receive({
      type: "session.snapshot",
      session: { conversations: [{ id: 1, kind: "main" }], capabilities: ["diagnostics"] },
    });
    expect(sent().filter(({ type }) => type === "diag.subscribe")).toEqual([
      expect.objectContaining({ type: "diag.subscribe", after: 6 }),
    ]);
    expect(sent().find(({ type }) => type === "diag.subscribe")).not.toHaveProperty("limit");

    // A catch-up keeps a limit when one is given, and asks for everything since when none is.
    state.send.mockClear();
    session.subscribeDiag({ after: 6, limit: 50 });
    session.subscribeDiag({ after: 6 });
    expect(sent()).toEqual([
      expect.objectContaining({ type: "diag.subscribe", after: 6, limit: 50 }),
      expect.not.objectContaining({ limit: expect.anything() }),
    ]);

    state.send.mockClear();
    session.unsubscribeDiag();
    expect(sent()).toEqual([expect.objectContaining({ type: "diag.unsubscribe" })]);
    expect(dispatchDiag).toHaveBeenLastCalledWith({ type: "stopped" });
    // A frame that crossed the unsubscribe is dropped, and the next session doesn't subscribe again.
    dispatchDiag.mockClear();
    receive({ type: "diag.event", event: diagEvent(7) });
    expect(dispatchDiag).not.toHaveBeenCalled();
  } finally {
    state.cleanup?.();
    vi.unstubAllGlobals();
  }
});

// COD-246: version skew never breaks the session.
it("ignores frames it doesn't know, and sends no optional request the agent didn't advertise", () => {
  state.send.mockClear();
  state.close.mockClear();
  state.dispatches.clear();
  const setTimeout = vi.fn();
  vi.stubGlobal("window", { location: { host: "localhost" }, setTimeout });
  vi.stubGlobal("document", new EventTarget());
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const session = usePiSession("test");
    const receive = (frame: object) => state.message!({ data: JSON.stringify(frame) });
    const sent = () => state.send.mock.calls.map(([message]) => JSON.parse(message as string));
    const dispatchSession = [...state.dispatches.entries()].find(
      ([reducer]) => reducer !== diagReducer,
    )![1];

    // An older agent: no capabilities. Chat opens; usage and diagnostics are never asked for.
    receive({ type: "session.snapshot", session: { conversations: [{ id: 1, kind: "main" }] } });
    expect(sent().map(({ type }) => type)).toEqual(["options.list"]);
    receive({ type: "session.activity", activity: { tasks: {} } });
    session.subscribeDiag();
    session.unsubscribeDiag();
    expect(sent().map(({ type }) => type)).toEqual(["options.list"]);
    expect(setTimeout).not.toHaveBeenCalled();

    // A newer agent's frames: an event type and a command result this client has never heard of.
    dispatchSession.mockClear();
    receive({ type: "approvals.pending", items: [{ id: 1 }] });
    receive({ type: "command.result", command: "approval.resolve", requestId: "x", ok: true });
    expect(state.close).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();

    // A malformed known frame still closes it, as before.
    receive({ type: "conversation.head", conversationId: 0 });
    expect(state.close).toHaveBeenCalledWith(1002, "Invalid protocol frame");
  } finally {
    consoleError.mockRestore();
    state.cleanup?.();
    vi.unstubAllGlobals();
  }
});
