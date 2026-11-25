---
"mipi": patch
---

COD-217: upgrade Pi Durable to 1.6.1.

**Changed**

- Internal, no behaviour change for the owner. The proactive `onYield` hook returns the tagged `{ kind: "tasks", tasks }`, and the Telegram, relay and reminder admissions call `admit(tx, draft)` instead of `submit(tx, draft)`.
- The admin health test reads the stamped Pi Durable version instead of a literal.

**Pi Durable**

- 1.6.0 → 1.6.1. Of its seven breaking changes, two touch MiPi: tagged `onYield` results and `submit(tx, …)` renamed to `admit(tx, …)`. Parks, `Wrap`, `beforeCompact`, `SignalState` and `CommitResult` are tagged too; MiPi uses none of them. Ledger: no entries added or closed.

**Migration**

- None. No stored data changed, and Pi Durable's tables are unchanged, so rolling back to the previous build is safe.
