/**
 * The web client's diagnostic events (COD-236): what Settings → Diagnostics shows, kept apart from the session state
 * (`session-state.ts`) so a live frame never re-renders the transcript. At most `DIAG_CLIENT_MAX` events, one per id,
 * oldest first.
 */
import type { DiagEvent, DiagHealth } from "../protocol.ts";

export const DIAG_CLIENT_MAX = 500;

export interface DiagState {
  readonly events: readonly DiagEvent[];
  /** As of the last `diag.subscribe` answer; undefined until the first. */
  readonly health: DiagHealth | undefined;
  /** The agent sends this socket `diag.event` frames. */
  readonly subscribed: boolean;
  /** Why the last subscription failed, if it did. */
  readonly error: string | undefined;
}

export const initialDiagState: DiagState = {
  events: [],
  health: undefined,
  subscribed: false,
  error: undefined,
};

export type DiagAction =
  /** `diag.subscribe` answered: its events join the buffer, its health replaces the last. */
  | {
      readonly type: "snapshot";
      readonly events: readonly DiagEvent[];
      readonly health: DiagHealth;
    }
  | { readonly type: "event"; readonly event: DiagEvent }
  | { readonly type: "failed"; readonly message: string }
  /** Unsubscribed, or the socket closed: frames still in flight are dropped. */
  | { readonly type: "stopped" };

/** `current` and `incoming` as one list: one event per id (the incoming one wins), oldest first, the newest kept. */
export function mergeDiagEvents(
  current: readonly DiagEvent[],
  incoming: readonly DiagEvent[],
  max: number = DIAG_CLIENT_MAX,
): readonly DiagEvent[] {
  if (incoming.length === 0) return current;
  const byId = new Map<number, DiagEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.length <= max ? merged : merged.slice(merged.length - max);
}

/** The newest id held, for catching up with `after`. */
export const lastDiagId = (events: readonly DiagEvent[]): number | undefined => events.at(-1)?.id;

export function diagReducer(state: DiagState, action: DiagAction): DiagState {
  switch (action.type) {
    case "snapshot":
      return {
        events: mergeDiagEvents(state.events, action.events),
        health: action.health,
        subscribed: true,
        error: undefined,
      };
    case "event":
      // A frame that crossed an unsubscribe on the wire.
      if (!state.subscribed) return state;
      return { ...state, events: mergeDiagEvents(state.events, [action.event]) };
    case "failed":
      return { ...state, subscribed: false, error: action.message };
    case "stopped":
      return state.subscribed ? { ...state, subscribed: false } : state;
    default: {
      const _: never = action;
      return state;
    }
  }
}
