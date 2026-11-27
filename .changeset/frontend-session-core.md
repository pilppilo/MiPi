---
"mipi": patch
---

COD-245: frontend slice 2 (COD-243). The web session's logic is now a plain-TypeScript core with its host behind two small interfaces. Nothing changes for the owner.

**Changed**

- `src/client/session/` holds the session core. `SessionClient` owns the chat connection, protocol framing, the outbox and its replay after a reconnect, transcript paging, the usage line's 30-second throttle and visibility refresh, and the diagnostics live tail. `usePiSession` is now a thin React adapter (`useSyncExternalStore`) with the same `PiSession` contract. `session-state.ts`, `command-outbox.ts`, `diag-buffer.ts` and `bots-list.ts` moved into the same folder.
- The core takes its host as a `Transport` and a `Platform`. A `Transport` is one connection on a named channel; only `chat` exists now, and the VM viewer's media stream will be another channel. The `Platform` covers visibility, storage, links, share, notifications, ids, timers and error logging. The web gives the core a PartySocket transport and `webPlatform` (`src/client/platform/`); a native shell would give its own. `Platform.storage` never holds secrets.
- The unread dots' memory (`useUnread`) reads and writes through `Platform.storage`. `webPlatform` guards every storage call, so a full, switched-off or blocked storage is simply empty.
- `pnpm check` builds the core on its own with no DOM (`tsconfig.session.json`). `scripts/check-boundaries.ts` refuses React, ReactDOM, PartySocket and the rest of `src/client/` in its imports, and lint refuses host globals there (`no-restricted-globals`).

**Pi Durable**

- No version change (1.6.1). Ledger: L15 added (workaround). pi-ai's declarations bring in `@types/node`, so the no-DOM build alone still accepts `setTimeout`, `localStorage`, `WebSocket` and other host globals; lint refuses them on `src/client/session/**` instead.

**Migration**

- None.
