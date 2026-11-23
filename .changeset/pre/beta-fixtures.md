---
"mipi": minor
---

COD-185: `0.1.0-beta.1`, the feature-complete release, with the first fixture database. From this release on, stored data must survive upgrades.

**Added**

- `test/fixtures/db/0.1.0-beta.1.json`: an export of an agent holding every kind of data this build writes:
  - conversations on web, Telegram and relay
  - a remembered lesson and a background lesson
  - a repeating reminder, captured on a clock fixed in the past, so on every replay it is skipped as late and sleeps until its next time without firing
  - a sent Telegram reply
  - a relay exchange
  - the memory pass's marks
  - the agent's settings
- `test/fixtures.test.ts` restores every fixture in `test/fixtures/db/` into a fresh agent through the admin API, on every `pnpm test`. It checks that the agent opens, the relay still answers, a web session opens, and the lessons, Telegram binding and reminder read back.
- `pnpm fixture:capture` (`scripts/fixture-capture.ts`) writes the current version's fixture through `test/fixture-capture.test.ts`. It never overwrites an existing one. The tests reach the fixture folder through a Miniflare disk binding, which is writable only while capturing.

**Fixed**

- An export or restore that began while work was still running (as on a cold start: the memory pass's first look, or a reminder that came due while the object slept) never began, so a deploy's backup could stop the deploy. Maintenance closed the agent inside `blockConcurrencyWhile`, and `harness.close()` waited for that work, which waited on the input gate `blockConcurrencyWhile` held, until the object was reset. Maintenance now stops the agent taking work, closes it outside `blockConcurrencyWhile`, then takes the object. Two maintenance calls at once share one close.
- The memory pass's first look runs while the agent opens, awaited, so its wake is in the first alarm write. Its wake reads only entries and session documents, and a pass commits nothing after the agent closes.
- Tests begin an export as the first request to a cold agent: one with only conversations, and one with a reminder coming due.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. Versions move from the alpha series to beta: alpha.6 to alpha.10 were never cut, so everything since `0.1.0-alpha.5` is in this release.
