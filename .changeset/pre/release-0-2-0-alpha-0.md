---
"mipi": patch
---

COD-175: release 0.2.0-alpha.0, the bots and settings stack (COD-197 to COD-201), with its fixture database.

**Added**

- `test/fixtures/db/0.2.0-alpha.0.json`: this release's stored data (bot records, the bots index, archive holds, bot hops and cobots, beside everything 0.1.0 stored). Every later build restores it on each `pnpm test`, beside the 0.1.0 betas'.

**Migration**

- None in this step. The fixture is test data. The data changes themselves (pre-bot conversations folded into Archived, doors moved to MiPi, pre-bot reminders moved to MiPi) are in the COD-197 and COD-198 notes.
