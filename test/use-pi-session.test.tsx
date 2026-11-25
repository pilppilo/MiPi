import { expect, it, vi } from "vitest";
import { usePiSession } from "../src/client/usePiSession.ts";

const state = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  message: undefined as ((event: { data: string }) => void) | undefined,
  send: vi.fn(),
}));

// Run the effect once and deliver real protocol frames without a browser or network connection.
vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => () => void) => {
    state.cleanup = effect();
  },
  useReducer: (_reducer: unknown, initial: unknown) => [initial, vi.fn()],
  useRef: <T,>(current: T) => ({ current }),
  useState: () => [undefined, vi.fn()],
}));

vi.mock("partysocket", () => ({
  default: class {
    readonly OPEN = 1;
    readonly readyState = this.OPEN;
    readonly send = state.send;
    readonly close = vi.fn();
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      if (type === "message") state.message = listener;
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
