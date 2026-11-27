/**
 * What the session core needs from its host (COD-245): the browser now, a native shell later. Everything here is
 * host-dependent, or a primitive ES2024 lacks (timers, ids), so `src/client/session/` compiles with no DOM and runs in
 * Node/Vitest with a fake. The web implementation is `src/client/platform/web.ts`.
 *
 * pi-ledger L15: the no-DOM build (`tsconfig.session.json`) alone doesn't keep host globals out, because pi-ai's
 * declarations bring in `@types/node` (its `setTimeout`, `localStorage`, `WebSocket`, `navigator`, `crypto`,
 * `console`). Lint (`no-restricted-globals` on `src/client/session/**`) refuses them, so they come from here.
 */

/** A timer as the host made it: only `clearTimeout` reads it. */
export type TimerHandle = { readonly __timer: never } | number;

export type Visibility = "visible" | "hidden";

/**
 * Small values kept on this device: per-browser conveniences such as which entries were read. It can come back empty
 * and can refuse a write, so nothing in it is ever the only copy.
 *
 * Hard rule: **storage never holds secrets** (vault values, tokens, keys). Anything another script on the origin, an
 * extension or a shared device could read doesn't belong here.
 */
export interface PlatformStorage {
  /** The value, or `undefined` when it is unset or storage is unavailable. Never throws. */
  get(key: string): string | undefined;
  /** Best effort: a full or switched-off storage drops the write. Never throws. */
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface ShareData {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
}

export interface Notice {
  readonly title: string;
  readonly body?: string;
}

export interface Platform {
  /** Whether the app is in the foreground. */
  readonly visibility: {
    current(): Visibility;
    /** Calls `listener` on each change; returns the unsubscribe. */
    subscribe(listener: (visibility: Visibility) => void): () => void;
  };
  readonly storage: PlatformStorage;
  /** Opens a link outside the app. */
  openLink(url: string): void;
  /** The host's share sheet. Resolves `false` when there is none or the owner cancelled. */
  share(data: ShareData): Promise<boolean>;
  /** A system notification, where the host has them: check before relying on it. Resolves whether it was shown. */
  readonly notify?: (notice: Notice) => Promise<boolean>;
  /** A random UUID, for request ids. */
  randomId(): string;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Where the core reports what it can't show (a bad frame). Default: nothing. */
  readonly logError?: (message: string, error: unknown) => void;
}
