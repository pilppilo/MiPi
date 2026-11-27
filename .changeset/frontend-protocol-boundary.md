---
"mipi": minor
---

COD-246: frontend slice 0 (COD-243). The web client depends on the wire contract alone, the agent says what it can do, and a frame the client doesn't know no longer breaks the session.

**Added**

- Capabilities. Every `session.snapshot` now carries `capabilities`: door-agnostic feature ids, deduplicated and sorted. Core advertises `activity`, `diagnostics` and `usage` (`CORE_CAPABILITIES` in `src/protocol.ts`). An extension can add its own with `MipiExtension.capabilities`; only an active extension's count, so a replaced one advertises nothing, and a malformed id refuses to compose. No built-in extension adds one yet.
- The web client shows an optional panel only when its capability is advertised: the usage line (and its `usage.read` requests), the Activity toggle and panel (and the bot dots that come from it), and Settings → Diagnostics (and `diag.subscribe` / `diag.unsubscribe`). An absent capability means the panel simply isn't there. Chat itself (sending, the transcript, the bots list, reconnecting) is never gated.

**Changed**

- The client ignores frames it doesn't know. `parseServerEventEnvelope` reads an unknown event type, or a `command.result` for a command the client never sends, as `{ type: "unknown", rawType }` instead of throwing, so a newer or rolled-back agent no longer closes the socket with a 1002 protocol error. A malformed frame of a known type still does.
- A snapshot without `capabilities` (an older agent) turns every optional panel off, and the client sends that agent no usage or diagnostics request.
- `src/client/` imports only `src/protocol.ts`, `src/lib/`, npm packages and itself. The Pi types and helpers it needs (`ConversationTranscript`, `applyImmutable`, `BACKGROUND_CONTEXT`, the transcript entry kinds, the task graph and view types) are re-exported from `src/protocol.ts`. Lint enforces it, and core (`src/agent/`) may no longer import the client, nor (outside the composition root) the Worker.

**Pi Durable**

- No version change (1.6.1) and no ledger change. `src/agent/pi/shared.ts` is unchanged; `src/protocol.ts` re-exports from it.

**Migration**

- None. No stored data changes. The agent and the client deploy together; the new fields are optional, so a rollback to an older build is safe.
