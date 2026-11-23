---
"mipi": minor
---

COD-185: `0.1.0-beta.1`, the feature-complete release, with the first fixture database. From this release on, stored data must survive upgrades.

**Added**

- `test/fixtures/db/0.1.0-beta.1.json`: an export of an agent holding every kind of data this build writes:
  - conversations on web, Telegram and relay
  - a remembered lesson and a background lesson
  - a sleeping reminder
  - a sent Telegram reply
  - a relay exchange
  - the memory pass's marks
  - the agent's settings
- `test/fixtures.test.ts` restores every fixture in `test/fixtures/db/` into a fresh agent through the admin API, on every `pnpm test`. It checks that the agent opens, the relay still answers, a web session opens, and the lessons, Telegram binding and reminder read back.
- `pnpm fixture:capture` (`scripts/fixture-capture.ts`) writes the current version's fixture through `test/fixture-capture.test.ts`. It never overwrites an existing one. The tests reach the fixture folder through a Miniflare disk binding, which is writable only while capturing.

**Fixed**

- An export that began on a cold start never finished, so a deploy's backup could stop the deploy. The memory pass's first look read a conversation document while the agent opened. That read waited on the input gate the beginning export held, while the export waited in `harness.close()` for that read, until the object was reset. The pass's wake now reads only entries and session documents. A test begins an export as the first request to a cold agent.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. Versions move from the alpha series to beta: alpha.6 to alpha.10 were never cut, so everything since `0.1.0-alpha.5` is in this release.
