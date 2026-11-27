---
"mipi": minor
---

COD-234: diagnostics slice 1. Core keeps a capped diagnostic event log in the Durable Object's SQLite, and core's own hops, holds and faults write to it. Nothing reads it from outside yet: the admin API and the live tail come in COD-235, and the Settings page in slice 3.

**Added**

- `src/agent/diag.ts`: the `DiagSink` connector, `NOOP_DIAG`, and `DiagLog`, which stores events in a raw `app_diag_events` table (outside Pi Durable: no document, no commit). It keeps the newest 1,000 rows, and ids keep rising across trims and restarts. `emit()` is synchronous and never throws. Reading a fresh database writes nothing.
- Shared event types in `src/protocol.ts`: `DiagEvent`, `DiagLevel`, `DiagOutcome`, `DiagDetail`.
- The guardrail lives in `diag.ts`, whatever an emitter passes. A summary is one line of at most 200 characters, with bearer tokens, Telegram bot tokens, `sk-` keys, JWTs and token query parameters scrubbed. `detail` is at most 12 flat values. A key that could hold content (`prompt`, `body`, `text`, `message` and the like) or a credential (any key containing `token`, `secret`, `password`, `cookie` and the like) is dropped.
- The sink reaches every part through the composition: `HarnessConfig.diag` → `Connectors.diag` (and `diagOf(registry)` for tasks), `BackgroundContext.diag` for extensions, `WakeSources`, `runAlarmConsumers` and `bindLimitRecorder`.
- Core emitters:
  - Startup and maintenance: `startup.open`, `startup.refused` (a composition error or the startup guard), `startup.maintenance`, `maintenance.stale_export`, `maintenance.export_begin`, `maintenance.export_end`.
  - Alarms and wake sources: `alarm.lost`, `alarm.fired` (debug), `alarm.consumer_failed`, `wake.refresh_failed`.
  - The harness: `harness.report` (every `onReport`, by kind) and `harness.failed`.
  - Gates and proactive runs: `gate.held` (a round stopped by a hold, a bot message refused by a hold), `proactive.terminated`, `proactive.tool_error` (tool names only), and `proactive.settled` (`ok`, `quiet`, `fault` or `held`).
  - Provider limits: `provider.limit` and `provider.limit_cleared`.
- `MipiAgent.diagEvents(query)` reads the log in any state, for tests and for COD-235's route.

**Changed**

- Export, restore, the fingerprint and row counts leave `app_diag_events` and its indexes out. A restore starts the log empty, and the reopen is its first event.
- Nothing is written to the log while maintenance runs, because an export's fingerprint includes the database size. An event from then (`startup.maintenance`) goes to the console in the same shape instead.
- A restore skips the diagnostic table, its indexes and its rows when an export carries them. That happens with an export taken by an older build after a rollback.

**Pi Durable**

- No version change (1.6.1). No ledger changes. `ReportInfo` is now re-exported as a type from `src/agent/pi/durable.ts`, for typing `harness.report` events.

**Migration**

- The first event creates `app_diag_events` (with `sqlite_sequence`). No Pi Durable data changes, so no fixture database is added. An older build ignores the table. After a rollback it would export the table, and this build's restore skips it.
