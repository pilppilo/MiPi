---
"mipi": patch
---

COD-156: release 0.1.0-beta.2 with its fixture database.

**Added**

- `test/fixtures/db/0.1.0-beta.2.json`: this release's stored data (the M9 spend document, the provider limits and the run cap, beside everything 0.1.0-beta.1 stored), written by Pi Durable 1.6.1. Every later build restores it on each `pnpm test`, beside 0.1.0-beta.1's.

**Migration**

- None. The fixture is test data; nothing the agent stores changes in this release step.
