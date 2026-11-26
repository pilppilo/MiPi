# mipi

## 0.1.0

### Minor Changes

- 9c535f1: COD-185: `0.1.0-beta.1`, the feature-complete release, with the first fixture database. From this release on, stored data must survive upgrades.

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

- f56d5d8: COD-151 (M4, work in progress): Cloudflare Access.

  **Added**

  - The Worker verifies Cloudflare Access JWTs (`Cf-Access-Jwt-Assertion`: RS256, issuer, audience, time; team keys cached, refetched on an unknown key at most once a minute or hourly). A person's token opens web routes and the socket; the deploy service token (`common_name` = `ACCESS_SERVICE_CLIENT_ID`) opens admin routes only.
  - WebSocket upgrades from another site are refused.
  - `MIPI_ACCESS_SKIP=1` skips auth on localhost only; on any other host it refuses every request.
  - Deploy scripts send the Access service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`); `deploy.ts version` reads the deployed version through the admin API.

  **Changed**

  - Access is on once a lane's GitHub Environment has the variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (passed as Worker vars at deploy). Until then the spike lock and `ADMIN_TOKEN` apply as before, so deploying this changes nothing.
  - The deploy and rollback workflows read the deployed version through the admin API, since the public health check shows none.

  **Pi Durable**

  - No change (1.6.0). No ledger changes.

  **Migration**

  - None until Access is set up for a lane.

- 56e8856: COD-174: a burst of messages gets one reply, from every door.

  **Changed**

  - `followUpMode: "all"`: every input queued behind a running turn joins the next turn together, whichever door it came from (web, Telegram, relay, scheduled). Before, each queued input took a turn of its own. An idle web or relay message still starts its turn at once.
  - Telegram: a message to an idle conversation opens a 2-second window, and the messages of that window go to the model as one input with one stamp. Later messages join the window without moving its deadline. A window is sent early at 50 messages or 32,000 characters. A message that arrives after its window's deadline is admitted after that window is sent. When the conversation is already busy, a message goes straight to the queue as before.
  - A web or scheduled turn that starts during the wait makes the Telegram batch its follow-up.
  - `/new` sends a waiting window to the old conversation before it starts the new one.
  - `/model <id>` and `/profile <name>` answer "I'm still working on your last message; try again in a moment." while a message waits or a turn runs. `/model` checks again when the change is applied. `/model` and `/profile` without an argument still answer.
  - Messages that fail together get one notice instead of one each.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. The seam re-exports `ConversationIdle`, `LiveDoc` and `InboxDoc`. The contract test checks that `whenIdle: "reject"` refuses an idle conversation before writing anything, and that the same commit can still write documents.

  **Migration**

  - None. The window lives in a new optional field (`staged`) of the `app.telegram` document, so the document keeps its version. A rollback to the previous build ignores the field; messages waiting in a window at that moment would not be sent.

- 8358254: COD-166: cache-stable prompts, at the agent level for every door.

  **Changed**

  - The system prompt is static: the per-minute "Current time" section is gone. It appended a new system entry every turn (the System lines in the transcript) and kept the prompt prefix from staying identical, which is what provider prompt caches key on.
  - Every message is stamped with who sent it and when, in the owner's time zone (`MIPI_TIMEZONE`, default `America/Chicago`): `[Jerome · Sun, Nov 22, 2026, 12:40 CST]`. Scheduled deliveries carry their local time too (`Scheduled instruction due now (…): …`); the client still recognizes both the new and the old form.
  - One cache policy for all conversations: `cacheRetention: "long"` in the harness's stream settings. It takes effect on models that support explicit retention (Anthropic-format: 1h; OpenAI-format: 24h) and is ignored elsewhere. `deepseek-v4.1-flash` on Go has no explicit cache controls: DeepSeek caches identical prefixes on its own, and OpenCode's session header keeps each conversation on the same backend, so the identical prefix is what matters.

  **Added**

  - Test: three turns hours apart, each request an exact prefix of the next, no new system messages between turns, and the cache policy on every request.
  - The web header shows cached prompt tokens and the share of the prompt served from cache.

  **Pi Durable**

  - No change (1.6.0).

  **Migration**

  - None. Existing conversations keep their old clock entries; new turns stop adding them.

- c21538e: M0 scaffold: MiPi seeded once from `earendil-works/pi-durable-cloudflare` @ `b68bf92` (MIT).

  **Added**

  - `src/agent/pi/`: the seam for all Pi Durable, pi-ai, pi-schema, and chord imports on the server (M2a narrows it and adds the lint rule).
  - OpenCode Go as the model provider (pi-ai's built-in `opencode-go`); default model `deepseek-v4.1-flash` at thinking level `low`, set by the `MIPI_MODEL` var.
  - Per-model compaction reserve (`summaryReserve`, adapted from Pi Pocket @ `2f060f2`, MIT) so long conversations keep room for their summary; `deepseek-v4.1-flash` gets 32,768 tokens.
  - Changesets in `alpha` pre mode, exact dependency pins, `.node-version`, and a CI workflow running `pnpm check` and `pnpm test`.

  **Changed**

  - Layout: `src/worker/`, `src/agent/`, `src/tools/`, `src/lib/`. The Durable Object is `MipiAgent` on binding `AGENT`; the Worker is `mipi`.
  - Client: tool calls that park (`waiting`, `sleeping`) show as running, and a sleep without a deadline shows as "until woken".

  **Removed**

  - The sample's mock `get_weather` tool.

  **Pi Durable**

  - `pi-durable`, `pi-ai`, `pi-schema`, `chord` 1.6.0 (from the sample's 1.5.2). Storage: Pi Durable 1.6 (`pi.tool` tasks v4, `pi.generation` v3).

  **Migration**

  - None: first release, no data.

- 2267bc1: M1 free-plan spike: MiPi deploys to Cloudflare from GitHub Actions, behind a temporary lock.

  **Added**

  - Deploy workflow: after `check` passes on `main` (or by hand), `wrangler deploy` ships the Worker `mipi` with `OPENCODE_API_KEY` and `MIPI_SPIKE_TOKEN` uploaded in the same version, then checks `/api/health`.
  - Release workflow: a new version on `main` gets its tag and a GitHub release from its `CHANGELOG.md` section (pre-releases for `-alpha`/`-beta`).
  - Spike lock (until Cloudflare Access in M4): every `/api` route and the WebSocket upgrade need `MIPI_SPIKE_TOKEN`, as an HttpOnly cookie set once by `POST /api/unlock` or as a Bearer header. Constant-time compare; refuses everything when the secret is unset. The web app asks for the token once.
  - `/api/health` (public, says only `{ ok: true }`) and `/api/spike/probe` (locked; reports whether Durable Object point-in-time recovery bookmarks work).
  - `spike-probe` workflow: which OpenCode Go usage URL answers and its shape, the PITR probe, and Worker CPU/error/subrequest analytics.

  **Changed**

  - pi-ai gets `OPENCODE_API_KEY` from the Worker's bindings through its `authContext`, not from `process.env` (which a Worker only has with Node compatibility). Tested in workerd.

  **Pi Durable**

  - No change (1.6.0).

  **Migration**

  - New repository secret `MIPI_SPIKE_TOKEN` (24+ random characters) before the first deploy.

- 38abf0a: M2a: Pi Durable sits behind one folder, enforced by lint and a contract test.

  **Added**

  - Lint (`oxlint`, in `pnpm check`): nothing outside `src/agent/pi/` and `test/` may import `@earendil-works/*`, subpaths included (`@earendil-works/chord/context` is the import that touched 25 files in Pi Pocket).
  - `test/contract.test.ts`: every name the seam exports, used once against the real packages on Durable Object SQLite (a full tool-using turn, docs, doc families, schemas, chord deltas).
  - `src/agent/pi/storage.ts`: reads the stored Pi Durable schema version and the highest stored version of each task kind, and compares them with what this build supports (for M2b's startup guard).

  **Changed**

  - `src/agent/pi/` exports only the names MiPi uses instead of whole packages. The browser code (`src/client/`, `src/protocol.ts`) now goes through `src/agent/pi/shared.ts`.
  - One session per owner (pulled forward from M3): the web app always opens the same session (`MIPI_OWNER`, default `jerome`), and a returning visitor goes straight back to it instead of starting a new one.

  **Pi Durable**

  - No change (1.6.0). Found while writing the readers: the `tasks.kind` column holds the kind JSON-encoded, so the readers use the task record's own `kind` and `version`.

  **Migration**

  - Conversations from the M1 spike were in separate, randomly named sessions and don't appear in the owner's session. Nothing to do (alpha).

- 2e820f5: M2b: staging lane, startup guard, backup and restore, upgrade and rollback tooling.

  **Added**

  - Startup guard: before Pi Durable opens the stored data, the agent checks its schema version and the version of every stored task kind. Data from a newer build is refused with a 503 naming both versions, instead of half-running (a newer task would only fail when next run) or crash-looping. Refused data can still be exported.
  - Maintenance mode: export and restore close the harness and pause every door and alarm. Pi Durable's work resumes when it reopens.
  - Export: paged by rowid with the schema (`_cf_*`/`sqlite_*` skipped), sized for the free plan's CPU. A fingerprint taken at the start and end fails an export that something wrote during.
  - Restore: a `restoring` flag written first and cleared last (an object that restarts halfway stays closed), wipe, schema, paged rows, a row-count check against the export, then the guard. Point-in-time bookmark restore too.
  - Admin API behind `ADMIN_TOKEN`; `/api/health` shows versions only to it.
  - Staging lane `mipi-staging` (own storage): every push to `main` deploys there; production deploys by hand. Every deploy backs up its target first (30-day artifact).
  - Workflows `rollback` (refuses to cross a one-way release unless forced) and `restore` (a backup or a bookmark).
  - Scripts: `deploy.ts` (backup, restore, status, rollback check), `upgrade-pi.ts` (`pnpm upgrade:pi <version>`), `stamp-version.ts` (`src/version.ts`, checked in `pnpm check`). One-way releases are marked with `**One-way:**` in their changeset.

  **Changed**

  - `pnpm check` also verifies `src/version.ts` and type-checks `scripts/`; `pnpm version` re-stamps after `changeset version`.

  **Pi Durable**

  - No change (1.6.0). Found: Durable Object SQL forbids `total_changes()` and `PRAGMA schema_version`, and local bookmarks advance on every call, so the export's write check is a data fingerprint.

  **Migration**

  - New repository secret `ADMIN_TOKEN` (24+ random characters) before the next deploy. Production no longer deploys on every push: run the deploy workflow with target `production`.

- 74f2a6d: COD-182 (M8 slice 1, part of COD-154): memory. MiPi keeps short lessons across conversations and doors.

  **Added**

  - `remember(text)` and `forget(id)` tools, on the `default` and `pidu` profiles. `empty` still has no tools.
  - The `app.memory` session document. It holds up to 20 lessons of at most 300 characters each.
    - Lesson ids are `m1`, `m2`, …, and they're never reused.
    - Each lesson records where it came from: web, Telegram, relay or a reminder, plus the conversation.
    - Whitespace becomes one line and invisible characters are removed.
    - Empty text, text that's too long, or a 21st lesson is refused with the reason. Nothing is trimmed.
    - An exact duplicate changes nothing.
  - A `memory` system section lists the lessons by id, and the lesson text can't close the tag. It comes after the static preamble, so a new lesson changes only the end of the prompt. It's left out when there are no lessons, and wherever `remember` isn't offered.
  - `remember` refuses in a run that called `web_fetch` (slice 2), so a fetched page can't write itself into memory. The check reads the run's stored entries, so it still holds after a restart. The owner's next turn works again. Relay runs aren't blocked.

  **Changed**

  - The `default` and `pidu` profiles gain `remember` and `forget`. Existing conversations get them on the next start, through the existing profile-tools sync.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. `app.memory` is a new document.

- 9b0060b: COD-184 (M8 slice 3, part of COD-154): the background memory pass. It replaces "save before compaction".

  **Added**

  - Once a conversation has been idle for 30 minutes, the alarm runs one pass on it. The pass reads what was said since the conversation's mark, plus the lessons already saved, and asks the conversation's own model for at most 3 new lessons. They're saved by `remember`'s rules, with source `background`. It's silent.
  - The pass reads raw entries, newest first, up to 40,000 characters. Compaction never changes raw entries. Scheduled deliveries, `NO_SEND` answers, tool calls and tool results are left out.
  - A pass never calls the model in these cases:
    - The profile has no `remember`.
    - Memory is full.
    - There's no new message from a person.
    - Scheduled runs are paused (`MIPI_DAILY_RUN_CAP` 0).
    - Today's 20 passes are used.
  - While memory is full or the runs are paused, the pass sets no alarm at all. Forgetting a lesson or resuming the runs brings it back.
  - One pass runs at a time, and one per conversation, so a second alarm during a request can't ask about the same range twice.
  - A conversation with no timed message yet sets no wake.
  - A busy conversation is put off 30 minutes.
  - A range with a `web_fetch` call or result anywhere is passed over without a request, and its mark moves past it.
  - A failed or unreadable reply keeps the mark and waits 5, then 30 minutes. After 2 retries the range is given up, so an outage can't use up the day.
  - The pass's spend counts in the conversation's `pi.usage`.
  - The new `app.memory-pass` document holds each conversation's mark and today's count.
  - The pass's wake is never active, so the 60-second heartbeat doesn't run while it waits.

  **Changed**

  - Once a turn settles, the alarm now stays set for the next memory pass instead of being deleted.
  - `titles.ts` exports `recordUsage` and `providerSession`, which the pass uses too.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. Pi Durable's `beforeCompact` hook can't write, so the pass works from idle conversations instead of before compaction, the way Codex writes its memories.

  **Migration**

  - None. `app.memory-pass` is a new document. A conversation's first pass reads its whole history, up to the 40,000-character budget.

- f9f49a3: COD-153 (M6, part 3): proactive runs. A scheduled check can stay quiet, knows what it sent lately, and has a daily cap.

  **Added**

  - `NO_SEND`: a reminder's run that finds nothing worth saying answers `NO_SEND`, and Telegram sends nothing. It counts only as the whole visible answer (after any `<think>` block). A failed tool still sends a notice, and a run that also answered a message is never quiet: the message gets a fallback instead of `NO_SEND`.
  - Provenance (`app.proactive`): an `onYield` hook task records which inputs each answer covers, and Telegram inputs and reminders are reconciled together, one judgement per answer.
  - Recent sends: the last 10 confirmed reminder messages, shown to the next reminder in its notes so it doesn't repeat itself. They live in the session, so they survive `/new`.
  - Daily cap on model rounds for scheduled runs: `MIPI_DAILY_RUN_CAP` (new var, default `50`, `0` pauses them; an invalid value is reported and the default used), per Chicago day. Interactive chat never counts. At the cap a run stops with one notice a day (it waits for a blocked run with a chat to tell, if none is known yet); a one-time Telegram reminder is still sent as plain text without the model; a one-time web reminder waits until just after Chicago midnight; a repeat skips that time.
  - A run is stopped after 8 tool rounds, with a notice naming the reminder.
  - A reminder whose answer is empty (thinking only) sends a notice instead of nothing.
  - Web: a reminder's `NO_SEND` answer shows as a muted "Nothing to report".

  **Changed**

  - Reminder messages carry a "[Notes for this run]" block for the model (the `NO_SEND` rule and recent sends); the web shows only the instruction.
  - Reminders of every destination are tracked in `app.proactive` instead of the Telegram door's inputs.
  - The Telegram door remembers the last chat that wrote (`lastChat`), for cap notices from web reminders.

  **Pi Durable**

  - No version change (1.6.0). The seam adds `GenerationTask`, `hook` and `hookTask`; the contract test pins that an `onYield` task sees the committed answer and that `afterTools` `{ terminate: true }` settles the input `done`.
  - New ledger entry L7 (workaround): the cap counts model rounds at admission and after each tool round, because `beforeRequest` can't write.

  **Migration**

  - None. Older builds ignore `app.proactive`; rolling back loses only the delivery of reminders that are running at that moment.

- d4b10a2: COD-150 (M3): one agent for its owner, with tool profiles, titles and a model picker.

  **Added**

  - Tool profiles (`src/agent/profiles.ts`): `default` (schedule, search_history), `empty` (no tools) and `pidu` (the default tools for now), as plain data. `toolsFor(profile)` is the only place a profile becomes tools. Each conversation stores its profile; new ones start on `MIPI_PROFILE` (new var, default `default`), and the relay will start on `pidu`. `test/profiles.test.ts` checks the exact tools each profile is offered and that no codemode or tool-search section appears.
  - Channel bindings (`app.channel-binding`): a channel key maps to the conversation it talks to and sets its starting profile. The web is bound to the main conversation; Telegram and the relay bind theirs in M5 and M7.
  - Conversation titles: a conversation is named from its first message at once; a long one is renamed by its own model (3 to 6 words, adapted from Pi Pocket `titles.ts` @ `2f060f2`, MIT). The cost counts in the conversation's usage.
  - Web: a model picker (only models in both OpenCode Go's live list and pi-ai's catalog; other ids are refused) and a profile picker, both per conversation. Conversations are listed by title.

  **Changed**

  - Every session request goes to the owner's Durable Object (`MIPI_OWNER`); any other session id is 404 and never creates an object. The spike probe uses the owner's object too.
  - The speaker in message stamps is `MIPI_OWNER`, not a name the browser sends. The web no longer asks for a display name.
  - Web input uses request ids `web:<client key>` and is checked with `submissionByRequest` before admitting, so a retry admits nothing.
  - Web: the "pi-durable / Session" header is now "MiPi"; system entries are hidden behind a "Show system entries" toggle.
  - The alarm function is `scheduleNextAlarm()`, the one place the alarm is set.

  **Pi Durable**

  - No version change (1.6.0). The seam adds `ProviderDoc` and `UsageDoc` (used by titles). No ledger changes. New MiPi documents (`app.conversation`, `app.channel-binding`) need no definition to be stored, so older builds open the data unchanged; not one-way.

  **Migration**

  - None. The main conversation gets its profile recorded (`default`) on the first web visit; its tools don't change.

- 18c014d: COD-180 (M7 slice 1, part of COD-155): the agent side of the PiDu relay. There is no HTTP route yet; slice 2 (COD-181) adds `POST /api/relay` and `GET /api/relay/:key`.

  **Added**

  - `src/lib/fence.ts`, copied from Pi Pocket (`defang`, `attribute`, `quoted`, `clip`). Relay text goes between `<relay from="pidu">` tags it can't close. This includes closing tags with spaces, invisible characters or line breaks before the `/`.
  - `relayRequest(key)`: request id `relay:<key>`. A key must be 1 to 64 letters, digits, `-` or `_`. Any other key is rejected, never cleaned, so two keys can't become one.
  - The Durable Object's `relayAdmit(key, text)` and `relayResult(key)`. A message goes to the `relay:pidu` conversation, which runs on the `pidu` profile. It is stamped `[PiDu · time]`, and `relayAdmit` waits up to 25 seconds for the answer.
  - Results: `done` with the answer, `pending`, `unanswered` with a reason, `conflict` (the same key with another text, checked by SHA-256), `limited` with seconds to wait, `invalid`, `too-large` (over 16,384 UTF-8 bytes), `not-found`, or `unavailable`.
  - A cap of 60 messages per sliding hour. A duplicate key or a conflict uses no slot.
  - The `app.relay` document keeps the key receipts and the hour's admission times. Up to 2,000 receipts are kept, and a receipt whose input is still open is never dropped. If a key's receipt was dropped but its input is still stored, the key gets that input's result, never a conflict.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. `app.relay` is a new document.

- 9782635: COD-181 (M7 slice 2, closes COD-155): the PiDu relay's HTTP door.

  **Added**

  - `POST /api/relay` needs `Authorization: Bearer <RELAY_TOKEN>`, an `Idempotency-Key` header (1 to 64 letters, digits, `-` or `_`) and `{ "text": "…" }`. It waits up to 25 seconds for the answer:
    - `200 {id, status: "done", answer}` when the answer is ready.
    - `202 {id, status: "pending"}` when it isn't, with `Location: /api/relay/<key>`.
    - `200 {id, status: "unanswered", reason}` when the turn ends without an answer.
  - `GET /api/relay/<key>` reads a key's result with the same token. A key that isn't valid gets 404 without the agent being asked.
  - Errors:
    - `400`: a bad key, a body that isn't JSON, or empty text.
    - `401`: a wrong or missing token, or the relay is off.
    - `404`: an unknown key.
    - `405`: the wrong method.
    - `409`: the same key with another text.
    - `413`: a body or text over the limit.
    - `429`: over 60 an hour, with `Retry-After`.
    - `503`: maintenance or the agent can't be reached, with `Retry-After`.
  - The new secret `RELAY_TOKEN` is set per lane (24+ characters). Without it the relay is off. `RELAY_TOKEN_PREVIOUS` is also accepted while the token is rotated. The deploy workflow passes both, and writes `off` for an unset one. Wrangler's `--secrets-file` keeps secrets that are left out, so this is how removing a token takes effect.
  - README: a PiDu relay section with the GitHub and Cloudflare Access steps.

  **Changed**

  - The Telegram webhook's bounded body reader moved to `src/worker/body.ts`, which the relay uses too.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. To turn the relay on for a lane: add `RELAY_TOKEN` to its GitHub Environment, add the Access Bypass application for path `api/relay`, then deploy.

- 45ff3d2: COD-153 (M6, part 1 of 3): reminders that reach the chat they came from.

  **Added**

  - Reminders. `schedule` now makes one durable task per reminder. The task sleeps until each time, delivers that time to the conversation the reminder was made in, and for a repeat sleeps again, so the model no longer schedules each next time itself.
  - A new `when` argument takes times as people say them, in the owner's time zone: `in 2m`, `tomorrow 9am`, `every weekday 8:00`, `every 30m between 9:00 and 17:00 on weekdays`. The parser is Pi Pocket's `when.ts` (`src/lib/when.ts`). Clock times stay on the wall clock across daylight saving. In Chicago, a time skipped in spring (02:30) moves forward by the gap, and a time that happens twice in autumn (01:30) runs once, at the earlier instant. `delaySeconds` and `at` still work for one-time reminders.
  - Where the answer goes is stored with the reminder. A reminder made from Telegram answers in that private chat, also with no browser open and after `/new` rebinds the chat. A reminder made on the web stays in its conversation.
  - Each delivery has its own request id (`sched:<reminder>:<n>`), so a retried delivery is admitted once.
  - Limits:
    - Repeats are at least 10 minutes apart.
    - At most 25 schedules wait at once, counting schedules from earlier builds.
    - A repeat skips a time while its previous delivery is still queued or running, and counts the skip.
    - A repeat skips a time that comes more than 15 minutes late, and moves to its next time.
    - A one-time reminder always goes out, however late.
    - A reminder's own turn can't make another reminder (a repeat already schedules itself). A turn that also answers a message can.

  **Changed**

  - The `schedule` tool's `recurrence` argument is gone: repeats use `when`. A schedule made by an earlier build keeps running as before, including its `sourceScheduleId` successor.
  - The Telegram door's state document moved to `src/agent/telegram-state.ts`. Its pending inputs may now have no `update_id` (a reminder's delivery). The door picks up inputs other parts of the agent record, through a commit observer.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. New task kind `app.reminder` (version 1). The legacy `app.deliver-scheduled-instruction` stays registered.

  **Migration**

  - None needed: stored schedules keep running.
  - After a rollback to an earlier build, reminders made by this build don't run: that build doesn't know the `app.reminder` task. Pi Durable marks such a task blocked (`missing_task`) and reports it, without crashing, and the rest of the agent keeps working. The reminders run again once you roll forward.

- b2ddcbd: COD-169: hardening before M4.

  **Fixed**

  - An export whose script died no longer keeps the agent closed: an export flag older than 10 minutes (`maintenance_started_at`) is cleared on start or on the next request. A restore never expires, so partial data never opens.
  - A deploy backup that can't be taken now stops the deploy. Only a 404 (no agent yet) skips it; a wrong `ADMIN_TOKEN`, a 403, a 5xx or no answer fails with the reason.
  - An export refuses a table without a rowid before closing the agent, instead of failing halfway.

  **Changed**

  - The deploy, rollback and restore workflows use the GitHub Environment of their lane (`staging` or `production`; auto-deploys from `main` use `staging`). Repository secrets stay the fallback.
  - New optional secret `ADMIN_TOKEN_PREVIOUS`: while a lane's token is rotated, the backup and the rollback's version check try it after `ADMIN_TOKEN`.
  - `pnpm check` builds and dry-runs both lanes (`scripts/dry-run.ts`).
  - `AGENTS.md`: a Code style section for every coding agent, adapted from Pi's own rules, and the Layout now lists `src/lib/` and `src/protocol.ts`.
  - The owner's time zone is no longer module state: stamps take it explicitly, and scheduled deliveries read it from the agent's session (`app.settings`), written from `MIPI_TIMEZONE` when the agent opens.

  **Pi Durable**

  - No change (1.6.0). No ledger changes. The contract test now round-trips an export of a real harness's tables and checks none is `WITHOUT ROWID`.

  **Migration**

  - None needed. To separate the lanes' secrets, create the GitHub Environments `staging` and `production` and add their secrets (see the README); until then the repository secrets are used.

- 2de1b88: COD-152 (M5): Telegram inbound.

  **Added**

  - `POST /api/telegram`, Telegram's webhook. It is routed before the owner's web authentication. Its own secret (`X-Telegram-Bot-Api-Secret-Token`, compared in constant time) authenticates it, and the route refuses everything while `TELEGRAM_WEBHOOK_SECRET` is unset or invalid. Bodies are capped at 128 KiB while they are read. The route answers 401 for bad auth, 405 for a wrong method, 413 for an oversized body, 503 when the agent can't store the update (Telegram retries), and 200 otherwise.
  - Only text in a private chat from an allowlisted sender (`TELEGRAM_ALLOWED_USER_IDS`) reaches the agent. A photo or other non-text message gets a short hint. Groups, edits, callbacks and strangers are acknowledged and dropped.
  - Each chat has its own conversation (binding `tg:<chat_id>`), and its messages are stamped like every other door's. The webhook answers 200 only after the agent durably stored the update. A receipt per `update_id` (kept 48 hours, at most 2,000) makes a replay do nothing, also after `/new` or a restart. Inputs use request id `tg:<update_id>`, and the submit runs in the same commit as the receipt.
  - Commands: `/start`, `/new`, `/version`, `/profile [name]`, `/model [id]`, also suffixed with this bot's username (`TELEGRAM_BOT_USERNAME`); commands addressed to other bots are ignored. None of them calls the model. `/model <id>` is recorded first and checked against the live model list after the webhook has answered.
  - A durable outbox for everything sent to Telegram. Each chat sends first in, first out, one message per second. Long replies are split into messages of at most 4,096 UTF-16 units, never inside a grapheme. A 429's `retry_after` is honoured and 5xx errors back off (5 attempts). A permanent refusal (revoked token, blocked bot) ends that reply without waking again. A send cut off mid-request is recorded as `delivery-unknown`, never sent twice. After a failed or unknown chunk, the rest of that reply is skipped and the chat moves on.
  - Each reply goes to the chat its message came from, even after `/new` rebinds the chat. An input that ends without an answer gets a short notice instead of silence. After a restart, answers not yet turned into replies and replies not yet sent are picked up again.
  - The deploy workflow passes the Telegram secrets and variables to the Worker and registers the webhook after a healthy deploy (`scripts/telegram-webhook.ts`: `allowed_updates: ["message"]`, one connection).

  **Changed**

  - The one alarm also covers the Telegram outbox's next send, and keeps the recovery heartbeat while a Telegram input or command is waiting.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. Newly relied on, and covered in `test/contract.test.ts`: `Conversation.submit(tx, …)` after document reads and before document writes, `tx.submission`, `tx.submissionByRequest`, `tx.entry`, and `Harness.submission(id).wait`. The seam also re-exports the `SubmissionId` and `SubmissionRecord` types.

  **Migration**

  - None. Telegram stays off until a lane has `TELEGRAM_BOT_TOKEN`. To turn it on, see the README's Telegram section. The new session documents (`app.telegram`, `app.telegram-outbox`) need no migration.

- 9eef5e8: COD-153 (M6, part 2 of 3): Telegram messages look right and get through.

  **Added**

  - Telegram replies are formatted. The model's markdown is rendered into Telegram's HTML: bold, italic, strikethrough, inline code, code blocks with their language, http(s) links, headings (shown bold) and quotes. Anything else is escaped text, as written.
    - Underscores inside words stay as they are (`MIPI_DAILY_RUN_CAP`).
    - Markers inside code stay as they are.
    - A marker without its partner stays literal.
    - Tags never cross.
    - A code span or link inside emphasis stays whole, also right at its start.
    - CRLF line endings are read like LF.
  - A reply is split before it is rendered, so no tag spans two messages. A code block cut by a split is closed and reopened, and the splitter keeps room for those fences.
  - If Telegram can't read a chunk's HTML ("can't parse entities"), that chunk is sent once more as plain text (the markdown source). The switch is saved first, so a restart can't send the broken HTML again.
  - If Telegram finds a chunk too long, only that chunk is split in two, in place. A chunk is split at most three times.
  - A send with an unclear outcome is tried once more: a timeout, a lost answer, an answer without a message id, or a chunk left `sending` by a restart. The retry is counted before it runs. If the retry is unclear too, the chunk is `delivery-unknown` and the rest of that reply is skipped. Telegram can't look a message up in a chat, so a rare duplicate is the lesser harm than a lost reminder.
  - On start, every conversation gets the tools its profile names where they differ. Conversations older than profiles kept the tools they were created with, so one could show `default` and still offer no `schedule`.
    - The pass leaves models alone.
    - It runs once, then again only when a profile's tools change (a digest in the agent's settings), so a normal start costs one read.
    - The web door's binding now gives a conversation older than profiles its profile's tools as well as the name.

  **Changed**

  - The alarm code moved to `src/agent/alarm.ts`. The alarm is still the earliest of Pi Durable's next wake, the Telegram door's next need, and the heartbeat, and it is deleted when nothing needs it. Each of the alarm's consumers now runs in its own `try`, so a failing Telegram door can't stop Pi Durable from resuming, and the alarm is always rescheduled unless maintenance runs.
  - Error descriptions from Telegram are matched without regard to case, and a 429's `retry_after` is capped at an hour.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. All new outbox fields are optional, so the document keeps its version.
  - Chunks stored by an earlier build have no id, HTML or retry policy. They keep sending as plain text, and an unclear outcome stays final for them.
  - An earlier build reading chunks made by this one sends their plain text and ignores the new fields.

- ba67eb5: COD-183 (M8 slice 2, part of COD-154): `web_fetch` reads one web page.

  **Added**

  - The `web_fetch(url)` tool, on the `default` and `pidu` profiles.
    - It sends a GET with `User-Agent: mipi/<version>`.
    - It follows at most 3 redirects, by hand, checking each one.
    - One 10-second deadline covers every hop and the body.
  - Refused hosts, checked again on every redirect:
    - IP literals in any form: dotted, hex, octal, one number, or IPv6.
    - `localhost`, including with a trailing dot.
    - `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.lan` and `*.intranet`.
    - Single-label names.
    - URLs with a username or password.
    - Any scheme other than http and https.
    - MiPi's own hostnames. Each door records the hostname it was reached on (the web socket upgrade, Telegram's webhook, the relay) in `app.settings` as `ownHosts`, and `web_fetch` reads them. So a page can't make MiPi fetch its own Access login or its open routes, on `workers.dev` or on a custom domain.
  - Content: only text types are read (`text/*`, JSON, XML, `+json` and `+xml`). For anything else the body is cancelled and the tool says what it was.
    - The raw body is read up to 1 MB and the rest is cancelled.
    - The text is cut at 50,000 characters, and a cut page says so.
  - HTML becomes text through HTMLRewriter (`src/lib/html-text.ts`).
    - Scripts, styles, `noscript`, `svg`, `template`, `iframe` and `object` are removed whole in a first pass, so a self-closing `<svg />` can't swallow the rest of the page.
    - Block elements become line breaks, and entities are decoded.
  - The page reaches the model inside `<fetched url="…">` tags it can't close, with a line saying it is data, not instructions. `remember` already refuses in a run that fetched (slice 1).

  **Changed**

  - The `default` and `pidu` profiles gain `web_fetch`. Existing conversations get it on the next start.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. `ownHosts` is a new optional field of `app.settings`.

### Patch Changes

- COD-156: release 0.1.0, the first version outside pre-release.

  **Changed**

  - MiPi leaves `beta` pre-mode. 0.1.0 is the same code as 0.1.0-beta.2; its changelog gathers every alpha and beta change.
  - The 0.1.0 gate is a 12-hour soak on staging with no manual fix (shortened from a week on prod on 2026-11-26). It passed on 0.1.0-beta.2, 2026-11-25 to 26, with a manual heartbeat run passing on staging and production.

  **Migration**

  - None. Nothing the agent stores changes, so there is no new fixture database; 0.1.0-beta.2's covers it.

- fd43b61: **Added**

  - Admin heartbeat status reports schedules, overdue work, gate holds, lost alarms, and the last proactive outcome. A daily check monitors staging and production.
  - Weekly proactive prompt evals use OpenCode Go and mocked page contents. Run them locally with `pnpm eval:proactive --env-file .dev.vars`.

  **Migration**

  - The last proactive outcome and local alarm-loss marker are additive. Exports omit the alarm-loss marker.

- 3365cad: COD-156: release 0.1.0-beta.2 with its fixture database.

  **Added**

  - `test/fixtures/db/0.1.0-beta.2.json`: this release's stored data (the M9 spend document, the provider limits and the run cap, beside everything 0.1.0-beta.1 stored), written by Pi Durable 1.6.1. Every later build restores it on each `pnpm test`, beside 0.1.0-beta.1's.

  **Migration**

  - None. The fixture is test data; nothing the agent stores changes in this release step.

- 51896bb: COD-211: conversation visibility, and history search as a built-in in fact.

  **Changed**

  - Internal, no behaviour change for the owner. Core decides which conversations are the owner's (`src/agent/visibility.ts`: `listVisible`, `visiblePage`): today, every ownerless one. History search and the memory pass use it at all three scan sites instead of scanning and filtering themselves. The memory pass plans its wake in the records-only mode, which reads no conversation's documents, so the archive (COD-198) can't make every plan read every conversation.
  - `search_history` and its subagent's `search_conversations` moved to `src/extensions/builtin/history-search/`. `src/tools/` is gone: all four built-ins live in `src/extensions/builtin/`, and the boundary check covers them.
  - The memory pass still recognises reminders' deliveries by their text: Pi Durable has no way from an entry to the input that placed it (ledger L8).

  **Pi Durable**

  - No version change (1.6.0). Ledger: L8 added (watch): Pi Durable links a submission to its entry one way only, with no request id on the entry and no submission scan.

  **Migration**

  - None. No stored data changed.

- 58ce999: COD-210: the doors as their own tier, delivery, the answer policy, the run cap and reminders as a built-in.

  **Changed**

  - Internal, no behaviour change for the owner. Telegram and the relay moved to `src/doors/` (`telegram/`, `relay/`), with the web door's registration in `src/doors/web/` (its socket handler stays in `agent-do.ts`). The three Telegram helpers left `src/lib/`. Core imports no door: each door registers its request-id prefix, its delivery adapter and its inputs waiting for an answer (`src/agent/connectors.ts`), and the composition root wires the runtimes.
  - Delivery (`src/agent/delivery.ts`): `send`, `tellOwner` and `onDelivered`, through the doors' adapters. Both enqueue in the caller's commit, so a state change and its notice are stored together. An adapter says whether its destination can take a message nobody is waiting for (Telegram yes, the web no); that replaces every `kind === "telegram"` branch. Message ids are built as before, so nothing already queued is sent twice.
  - Core owns proactive runs: `app.proactive` (same kind and fields), `RecordRun`, `RoundBudget` and the answer policy. One settlement (`src/agent/answers.ts`) watches every door's pending inputs and every reminder and judges each answer once, as before; it moved out of the Telegram door. "Is this a reminder's own run" comes from origin, not from a `sched:` check.
  - Origin: the fixed table of request-id prefixes left core. Each door and the reminders register their own prefix, and the reply destination comes from the door (Telegram: the chat recorded with the input). Request-id builders moved to their doors and to the reminders.
  - The gates (`src/agent/gates.ts`): the run cap, the spend cap and the pause, read-only for doors and extensions. Telegram, the relay, the usage readout and the memory pass stop reading `app.spend` and `app.proactive` themselves.
  - Reminders became a built-in in fact: `schedule`, `app.reminder`, `app.deliver-scheduled-instruction` and their tasks moved to `src/extensions/builtin/reminders/`, onto delivery, origin and the gates.
  - The Bot API sender moved from the outbox to `src/doors/telegram/bot-api.ts`.
  - Lint: core imports no door, extension or tool except in the composition root; a door imports no extension; and only `src/doors/telegram/` imports Telegram's documents.

  **Pi Durable**

  - No version change (1.6.0). Ledger: L7's wording names `expectProactive` and the reminders' folder; no entry added or closed.

  **Migration**

  - None. Document kinds, stored fields and task names are unchanged, so rolling back reads the same data. The 0.1.0-beta.1 fixture opens and runs, and its sleeping reminder now wakes and runs from the `reminders` extension (tested).

- 311d1f1: COD-209: the extension shape, the built-in list, memory and `web_fetch` as built-in extensions.

  **Changed**

  - Internal, no behaviour change for the owner. A MiPi extension is now a Pi Durable extension plus MiPi registrations (`src/agent/extensions.ts`): tier, replaceable, prompt slot, untrusted tools, wake sources. Core resolves them once (`composeAgent`), and the composition root adds the built-ins (`src/agent/composition.ts`).
  - The one `chat` extension that held every tool is split. `chat` keeps only the preamble, and `memory`, `reminders`, `history-search` and `web-fetch` are built-ins, listed in `src/extensions/builtins.ts`. Memory (its tools, section and background pass) and `web_fetch` moved to `src/extensions/builtin/`. Reminders and history search keep their code in `src/tools/` until COD-210 and COD-211 move it.
  - Every built-in is always installed. The default selection is core's own extensions first, then the built-ins by slot and name, so the prompt sections and tools come out exactly as before. A conversation can switch a built-in off (`AgentComposition.switchOff`), and its tools and section leave that conversation only. Profile changes, the startup profile sync and the memory pass all respect that.
  - Pi's replacement rule: an extension that registers a built-in's tool name replaces that built-in whole, whatever the load order. The replaced one stays installed, so its stored tasks still resolve. Any other clash refuses to start, with the reason in the admin status. The admin status lists the extensions in use and any replacements.
  - New core connectors: side model calls (`side-calls.ts`, used by titles and the memory pass), untrusted content (`untrusted.ts`: `web_fetch` is declared untrusted by its extension, checked against the tools it registers and bound per agent, and memory no longer names it), input origin (`origin.ts`: memory no longer parses request ids or lists the doors), and the delivery destination type (`delivery.ts`).
  - The startup guard's task list is collected from the installed extensions instead of a hand-kept `APP_TASKS`.
  - The profile table moved to `src/extensions/profiles.ts`; `src/agent/profiles.ts` is the mechanism and names no tool.
  - Lint: core imports no extension or tool except in the composition root, and an extension imports no door. `scripts/check-boundaries.ts` (in `pnpm check`) fails on an import from one extension into another.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. Document kinds and task names are unchanged, and the 0.1.0-beta.1 fixture opens and runs as before.

- 1e722ec: COD-217: upgrade Pi Durable to 1.6.1.

  **Changed**

  - Internal, no behaviour change for the owner. The proactive `onYield` hook returns the tagged `{ kind: "tasks", tasks }`, and the Telegram, relay and reminder admissions call `admit(tx, draft)` instead of `submit(tx, draft)`.
  - The admin health test reads the stamped Pi Durable version instead of a literal.

  **Pi Durable**

  - 1.6.0 → 1.6.1. Of its seven breaking changes, two touch MiPi: tagged `onYield` results and `submit(tx, …)` renamed to `admit(tx, …)`. Parks, `Wrap`, `beforeCompact`, `SignalState` and `CommitResult` are tagged too; MiPi uses none of them. Ledger: no entries added or closed.

  **Migration**

  - None. No stored data changed, and Pi Durable's tables are unchanged, so rolling back to the previous build is safe.

- 95c3731: COD-212: OpenCode Go's provider pieces as an optional extension, and the boundary written down.

  **Changed**

  - Internal, no behaviour change for the owner. OpenCode Go's usage reader and live model list moved out of core into `src/extensions/optional/opencode-go/`, an optional extension listed in `src/extensions/optional.ts`. The usage readout (admin status, `/usage`, the web line), the web model picker and Telegram's `/model` read and set the same as before.
  - Core's providers connector (`src/agent/providers.ts`, which replaces `usage-sources.ts`): an extension registers a provider's usage reader and model list, each under a static provider id. One provider's piece registered twice refuses to compose, with or without a key set. A replaced extension's providers aren't registered.
  - `ModelList` takes the registered model lists and returns each model's provider from its source. With none (bare core) it lists nothing and refuses a model clearly.
  - An extension may have no Pi Durable part (`MipiExtension.pi` is optional). OpenCode Go's has none, so it is never in a conversation's selection and can't be switched off; the admin status lists `opencode-go` among the extensions in use.
  - The model list key is read through the agent's settings, so an empty `OPENCODE_API_KEY` now sends no `Authorization` header rather than an empty one.
  - Docs: "Core, doors and extensions" in `docs/development.md` (tiers, imports, the extension contract, the connectors). `AGENTS.md` adds the rule that provider-specific code lives in the provider's optional extension or the model seam. A test keeps OpenCode URLs, settings and response shapes out of `src/agent/` outside `pi/`.

  **Pi Durable**

  - No version change (1.6.0). No ledger change: the model seam (`src/agent/pi/models.ts`, L1) stays as it is.

  **Migration**

  - None. No stored data changed.

- 4a69fd3: **Added**

  - OpenCode Go plan-limit notices on web, Telegram, and relay. Background work waits for the latest active hold deadline. The web keeps the original error in the conversation, and owner messages are still tried.

  **Changed**

  - Recurring reminders wait through a short cooldown after transient provider failures. Memory keeps its existing transient retry delay.

  **Fixed**

  - Recurring legacy schedules keep their cadence through a hold. Repeating reminders still report plan failures when a recorded limit has expired or is unavailable. The web refreshes usage when a new failure arrives in a live update.

  **Pi Durable**

  - Ledger L9 records provider limits from the awaited `afterResponse` observer before a failed input settles.

  **Migration**

  - The provider-limit document is additive. Existing conversations inherit the core extension through the default selection.

- 28a481e: COD-215: a check reports a source it couldn't read instead of staying quiet.

  **Fixed**

  - A reminder's notes now tell the model to say so when it couldn't read or verify a source (a fetch error, a login wall, or a blank or JavaScript-only page) instead of answering `NO_SEND`. A page that loads but shows nothing (HTTP 200) leaves no tool error for MiPi to catch, so such a check used to look healthy while it had read nothing. Found by the first live run of the proactive evals (`javascript-shell` and `fetch-503`).

  **Pi Durable**

  - No change.

  **Migration**

  - None. The note is on each reminder's message, so the system prompt prefix stays the same.

- 9600e41: COD-193 (M9 slice 1): a daily spend cap, a pause switch, and a usage readout.

  **Added**

  - **Spend today.** `src/agent/spend.ts` measures what MiPi spent from every conversation's `pi.usage`, subagents' and tools' included, at pi-ai's list prices. Titles and the memory pass already record theirs there. A measure adds what grew since the last one to today's count (Pi Pocket `spend.ts` pattern). The count never drops, and it starts afresh at Chicago midnight. The agent measures once when it first opens with this build, so spend from before that counts for no day.
  - **`MIPI_DAILY_SPEND_CAP`** (dollars; `1` on both lanes; `off` means no cap). At the cap, work nobody asked for at that moment waits until Chicago midnight:
    - reminders: a one-time Telegram one goes out as plain text, "(sent without MiPi: daily spend cap reached)"; a web one waits; a repeat skips its occurrence
    - a reminder run already going, stopped after the tool round that crossed it
    - the memory pass, measured before each conversation's pass
    - model-written titles

    One notice a day says so. Your own messages still go through; on Telegram, the first new one over the cap each day gets one line saying so (a message Telegram sends again doesn't).

  - **`MIPI_PAUSED`** (`0` on both lanes). `1` holds every model call:
    - the web refuses new messages with "MiPi is paused, so it can't answer right now."
    - Telegram answers the same before any burst window opens, and refuses a window staged before the pause, when it comes due or on `/new`; commands still answer
    - the relay answers 503 `{ "error": "Paused" }` with `Retry-After: 3600`; a key admitted before still gets its answer
    - reminders are held as at the cap, without a notice
    - the memory pass sets no wake

    A value that is neither on nor off is reported and pauses.

  - **Usage readout**, the same on every door: Telegram `/usage`, a line in the web header, and `usage` in the admin status. The web line is read again only while the agent is awake anyway (the session opening, your message, work running, the tab coming back into view), at most every 30 seconds, so it never wakes a hibernated agent. Details show on hover. It shows today's estimate, the spend cap, the run cap's rounds, and each provider's own figures where MiPi can read them. `src/agent/usage-sources.ts` holds one reader per provider. OpenCode Go is the first: its rolling, weekly and monthly windows from `GET https://opencode.ai/zen/go/v1/usage` (the shape OpenCode's own client reads). Reads are cached in memory for five minutes, failures too, and callers at the same moment share one read. The admin status measures nothing and asks no provider: it shows the spend as last measured and what is cached, so a GET writes nothing.
  - Optional settings: `OPENCODE_USAGE_KEY`, a key with usage permission when the model key has none, and `OPENCODE_ORG_ID`, the workspace id if Go asks for one. The deploy workflow passes them, and `MIPI_DAILY_SPEND_CAP` and `MIPI_PAUSED` from a lane's Environment variables, over `wrangler.jsonc`'s values. An unset `OPENCODE_USAGE_KEY` is written as `off`, as the relay tokens are, so removing it takes effect.
  - `docs/deployment.md`: a "Spend cap, pause and usage" section, with how to pause a lane.

  **Changed**

  - Older scheduled deliveries (`app.deliver-scheduled-instruction`) follow the same rule. Paused or at the cap, the occurrence isn't delivered, and a successor carries the schedule to its next time (a repeat) or past Chicago midnight (a one-time one). At the cap, the day's notice goes to the chat that wrote last. An occurrence already submitted before a restart is never held.
  - `chicagoDay`, `afterNextChicagoMidnight` and `CAP_ZONE` moved to `src/lib/cap-day.ts`; `proactive.ts` re-exports them.
  - `RoundBudget` can stop a run for `spend-cap` or `paused`, besides `daily-cap` and `run-limit`.

  **Pi Durable**

  - No version change (1.6.0). Ledger: L7 now covers the spend cap and the pause, checked at the same two places as the run cap. It is renamed "Daily caps are checked at admission and after each tool round".

  **Migration**

  - New session document `app.spend`. An older build ignores it, so this isn't one-way. After a rollback:
    - a run stopped for `spend-cap` or `paused` would be reported as a run-limit stop
    - a reminder's `skippedPaused` count is dropped the next time it runs
  - Fixture capture now seeds `app.spend`. The release that carries this captures its fixture DB with `pnpm fixture:capture`.

- a3747a5: COD-207: the agent's one alarm takes wake-ups from a list of wake sources that names no door.

  **Changed**

  - Internal only, no behaviour change. Each part that needs the alarm (today the Telegram door and the memory pass) registers once as a wake source (`src/agent/wake-sources.ts`): its wake, what the alarm runs, which commits make it look again, and how it closes.
  - `alarm.ts` no longer imports the Telegram door. The alarm, the commit observer and shutdown loop over the sources instead of naming them, and the alarm runs them in registration order after Pi Durable, as before.
  - Sources are registered when the harness opens and cleared when it closes, so a reopen after an export or restore registers each once. A second source with the same name throws.
  - A source closed while the alarm runs (maintenance taking the object) is skipped. A source that throws while observing a commit or closing is reported, and the others still run.
  - Lint: `alarm.ts` and `wake-sources.ts` may not import a door, tool or extension (an oxlint override beside the Pi seam rule).

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. No stored data changes.

- 845d857: COD-190: the web transcript formats replies, and collapses long tool results.

  **Changed**

  - The web door shows assistant replies and context summaries as formatted markdown. That covers paragraphs, headings, bold, italic, strikethrough, inline and fenced code, bullet and numbered lists, block quotes, rules and links. Before, it printed the `**`, `- ` and backticks as written. A reply still streaming is formatted as it arrives.
  - Links open only for `http(s)`, in a new tab with no referrer. Anything else, including HTML or a `javascript:` link in a reply, shows as text.
  - User, scheduled and queued messages still show exactly as typed.
  - A tool result longer than 600 characters or 12 lines starts collapsed. Its one-line summary gives the fetched page's URL (or the result's first line) and its length. Short results and failures stay open.
  - The inline markdown parse moved from `telegram-html.ts` to `src/lib/markdown.ts`. Both doors use it, and Telegram's output is unchanged.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. Only the web page changes.

## 0.1.0-beta.2

### Patch Changes

- fd43b61: **Added**

  - Admin heartbeat status reports schedules, overdue work, gate holds, lost alarms, and the last proactive outcome. A daily check monitors staging and production.
  - Weekly proactive prompt evals use OpenCode Go and mocked page contents. Run them locally with `pnpm eval:proactive --env-file .dev.vars`.

  **Migration**

  - The last proactive outcome and local alarm-loss marker are additive. Exports omit the alarm-loss marker.

- COD-156: release 0.1.0-beta.2 with its fixture database.

  **Added**

  - `test/fixtures/db/0.1.0-beta.2.json`: this release's stored data (the M9 spend document, the provider limits and the run cap, beside everything 0.1.0-beta.1 stored), written by Pi Durable 1.6.1. Every later build restores it on each `pnpm test`, beside 0.1.0-beta.1's.

  **Migration**

  - None. The fixture is test data; nothing the agent stores changes in this release step.

- 51896bb: COD-211: conversation visibility, and history search as a built-in in fact.

  **Changed**

  - Internal, no behaviour change for the owner. Core decides which conversations are the owner's (`src/agent/visibility.ts`: `listVisible`, `visiblePage`): today, every ownerless one. History search and the memory pass use it at all three scan sites instead of scanning and filtering themselves. The memory pass plans its wake in the records-only mode, which reads no conversation's documents, so the archive (COD-198) can't make every plan read every conversation.
  - `search_history` and its subagent's `search_conversations` moved to `src/extensions/builtin/history-search/`. `src/tools/` is gone: all four built-ins live in `src/extensions/builtin/`, and the boundary check covers them.
  - The memory pass still recognises reminders' deliveries by their text: Pi Durable has no way from an entry to the input that placed it (ledger L8).

  **Pi Durable**

  - No version change (1.6.0). Ledger: L8 added (watch): Pi Durable links a submission to its entry one way only, with no request id on the entry and no submission scan.

  **Migration**

  - None. No stored data changed.

- 58ce999: COD-210: the doors as their own tier, delivery, the answer policy, the run cap and reminders as a built-in.

  **Changed**

  - Internal, no behaviour change for the owner. Telegram and the relay moved to `src/doors/` (`telegram/`, `relay/`), with the web door's registration in `src/doors/web/` (its socket handler stays in `agent-do.ts`). The three Telegram helpers left `src/lib/`. Core imports no door: each door registers its request-id prefix, its delivery adapter and its inputs waiting for an answer (`src/agent/connectors.ts`), and the composition root wires the runtimes.
  - Delivery (`src/agent/delivery.ts`): `send`, `tellOwner` and `onDelivered`, through the doors' adapters. Both enqueue in the caller's commit, so a state change and its notice are stored together. An adapter says whether its destination can take a message nobody is waiting for (Telegram yes, the web no); that replaces every `kind === "telegram"` branch. Message ids are built as before, so nothing already queued is sent twice.
  - Core owns proactive runs: `app.proactive` (same kind and fields), `RecordRun`, `RoundBudget` and the answer policy. One settlement (`src/agent/answers.ts`) watches every door's pending inputs and every reminder and judges each answer once, as before; it moved out of the Telegram door. "Is this a reminder's own run" comes from origin, not from a `sched:` check.
  - Origin: the fixed table of request-id prefixes left core. Each door and the reminders register their own prefix, and the reply destination comes from the door (Telegram: the chat recorded with the input). Request-id builders moved to their doors and to the reminders.
  - The gates (`src/agent/gates.ts`): the run cap, the spend cap and the pause, read-only for doors and extensions. Telegram, the relay, the usage readout and the memory pass stop reading `app.spend` and `app.proactive` themselves.
  - Reminders became a built-in in fact: `schedule`, `app.reminder`, `app.deliver-scheduled-instruction` and their tasks moved to `src/extensions/builtin/reminders/`, onto delivery, origin and the gates.
  - The Bot API sender moved from the outbox to `src/doors/telegram/bot-api.ts`.
  - Lint: core imports no door, extension or tool except in the composition root; a door imports no extension; and only `src/doors/telegram/` imports Telegram's documents.

  **Pi Durable**

  - No version change (1.6.0). Ledger: L7's wording names `expectProactive` and the reminders' folder; no entry added or closed.

  **Migration**

  - None. Document kinds, stored fields and task names are unchanged, so rolling back reads the same data. The 0.1.0-beta.1 fixture opens and runs, and its sleeping reminder now wakes and runs from the `reminders` extension (tested).

- 311d1f1: COD-209: the extension shape, the built-in list, memory and `web_fetch` as built-in extensions.

  **Changed**

  - Internal, no behaviour change for the owner. A MiPi extension is now a Pi Durable extension plus MiPi registrations (`src/agent/extensions.ts`): tier, replaceable, prompt slot, untrusted tools, wake sources. Core resolves them once (`composeAgent`), and the composition root adds the built-ins (`src/agent/composition.ts`).
  - The one `chat` extension that held every tool is split. `chat` keeps only the preamble, and `memory`, `reminders`, `history-search` and `web-fetch` are built-ins, listed in `src/extensions/builtins.ts`. Memory (its tools, section and background pass) and `web_fetch` moved to `src/extensions/builtin/`. Reminders and history search keep their code in `src/tools/` until COD-210 and COD-211 move it.
  - Every built-in is always installed. The default selection is core's own extensions first, then the built-ins by slot and name, so the prompt sections and tools come out exactly as before. A conversation can switch a built-in off (`AgentComposition.switchOff`), and its tools and section leave that conversation only. Profile changes, the startup profile sync and the memory pass all respect that.
  - Pi's replacement rule: an extension that registers a built-in's tool name replaces that built-in whole, whatever the load order. The replaced one stays installed, so its stored tasks still resolve. Any other clash refuses to start, with the reason in the admin status. The admin status lists the extensions in use and any replacements.
  - New core connectors: side model calls (`side-calls.ts`, used by titles and the memory pass), untrusted content (`untrusted.ts`: `web_fetch` is declared untrusted by its extension, checked against the tools it registers and bound per agent, and memory no longer names it), input origin (`origin.ts`: memory no longer parses request ids or lists the doors), and the delivery destination type (`delivery.ts`).
  - The startup guard's task list is collected from the installed extensions instead of a hand-kept `APP_TASKS`.
  - The profile table moved to `src/extensions/profiles.ts`; `src/agent/profiles.ts` is the mechanism and names no tool.
  - Lint: core imports no extension or tool except in the composition root, and an extension imports no door. `scripts/check-boundaries.ts` (in `pnpm check`) fails on an import from one extension into another.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. Document kinds and task names are unchanged, and the 0.1.0-beta.1 fixture opens and runs as before.

- 1e722ec: COD-217: upgrade Pi Durable to 1.6.1.

  **Changed**

  - Internal, no behaviour change for the owner. The proactive `onYield` hook returns the tagged `{ kind: "tasks", tasks }`, and the Telegram, relay and reminder admissions call `admit(tx, draft)` instead of `submit(tx, draft)`.
  - The admin health test reads the stamped Pi Durable version instead of a literal.

  **Pi Durable**

  - 1.6.0 → 1.6.1. Of its seven breaking changes, two touch MiPi: tagged `onYield` results and `submit(tx, …)` renamed to `admit(tx, …)`. Parks, `Wrap`, `beforeCompact`, `SignalState` and `CommitResult` are tagged too; MiPi uses none of them. Ledger: no entries added or closed.

  **Migration**

  - None. No stored data changed, and Pi Durable's tables are unchanged, so rolling back to the previous build is safe.

- 95c3731: COD-212: OpenCode Go's provider pieces as an optional extension, and the boundary written down.

  **Changed**

  - Internal, no behaviour change for the owner. OpenCode Go's usage reader and live model list moved out of core into `src/extensions/optional/opencode-go/`, an optional extension listed in `src/extensions/optional.ts`. The usage readout (admin status, `/usage`, the web line), the web model picker and Telegram's `/model` read and set the same as before.
  - Core's providers connector (`src/agent/providers.ts`, which replaces `usage-sources.ts`): an extension registers a provider's usage reader and model list, each under a static provider id. One provider's piece registered twice refuses to compose, with or without a key set. A replaced extension's providers aren't registered.
  - `ModelList` takes the registered model lists and returns each model's provider from its source. With none (bare core) it lists nothing and refuses a model clearly.
  - An extension may have no Pi Durable part (`MipiExtension.pi` is optional). OpenCode Go's has none, so it is never in a conversation's selection and can't be switched off; the admin status lists `opencode-go` among the extensions in use.
  - The model list key is read through the agent's settings, so an empty `OPENCODE_API_KEY` now sends no `Authorization` header rather than an empty one.
  - Docs: "Core, doors and extensions" in `docs/development.md` (tiers, imports, the extension contract, the connectors). `AGENTS.md` adds the rule that provider-specific code lives in the provider's optional extension or the model seam. A test keeps OpenCode URLs, settings and response shapes out of `src/agent/` outside `pi/`.

  **Pi Durable**

  - No version change (1.6.0). No ledger change: the model seam (`src/agent/pi/models.ts`, L1) stays as it is.

  **Migration**

  - None. No stored data changed.

- 4a69fd3: **Added**

  - OpenCode Go plan-limit notices on web, Telegram, and relay. Background work waits for the latest active hold deadline. The web keeps the original error in the conversation, and owner messages are still tried.

  **Changed**

  - Recurring reminders wait through a short cooldown after transient provider failures. Memory keeps its existing transient retry delay.

  **Fixed**

  - Recurring legacy schedules keep their cadence through a hold. Repeating reminders still report plan failures when a recorded limit has expired or is unavailable. The web refreshes usage when a new failure arrives in a live update.

  **Pi Durable**

  - Ledger L9 records provider limits from the awaited `afterResponse` observer before a failed input settles.

  **Migration**

  - The provider-limit document is additive. Existing conversations inherit the core extension through the default selection.

- 28a481e: COD-215: a check reports a source it couldn't read instead of staying quiet.

  **Fixed**

  - A reminder's notes now tell the model to say so when it couldn't read or verify a source (a fetch error, a login wall, or a blank or JavaScript-only page) instead of answering `NO_SEND`. A page that loads but shows nothing (HTTP 200) leaves no tool error for MiPi to catch, so such a check used to look healthy while it had read nothing. Found by the first live run of the proactive evals (`javascript-shell` and `fetch-503`).

  **Pi Durable**

  - No change.

  **Migration**

  - None. The note is on each reminder's message, so the system prompt prefix stays the same.

- 9600e41: COD-193 (M9 slice 1): a daily spend cap, a pause switch, and a usage readout.

  **Added**

  - **Spend today.** `src/agent/spend.ts` measures what MiPi spent from every conversation's `pi.usage`, subagents' and tools' included, at pi-ai's list prices. Titles and the memory pass already record theirs there. A measure adds what grew since the last one to today's count (Pi Pocket `spend.ts` pattern). The count never drops, and it starts afresh at Chicago midnight. The agent measures once when it first opens with this build, so spend from before that counts for no day.
  - **`MIPI_DAILY_SPEND_CAP`** (dollars; `1` on both lanes; `off` means no cap). At the cap, work nobody asked for at that moment waits until Chicago midnight:
    - reminders: a one-time Telegram one goes out as plain text, "(sent without MiPi: daily spend cap reached)"; a web one waits; a repeat skips its occurrence
    - a reminder run already going, stopped after the tool round that crossed it
    - the memory pass, measured before each conversation's pass
    - model-written titles

    One notice a day says so. Your own messages still go through; on Telegram, the first new one over the cap each day gets one line saying so (a message Telegram sends again doesn't).

  - **`MIPI_PAUSED`** (`0` on both lanes). `1` holds every model call:
    - the web refuses new messages with "MiPi is paused, so it can't answer right now."
    - Telegram answers the same before any burst window opens, and refuses a window staged before the pause, when it comes due or on `/new`; commands still answer
    - the relay answers 503 `{ "error": "Paused" }` with `Retry-After: 3600`; a key admitted before still gets its answer
    - reminders are held as at the cap, without a notice
    - the memory pass sets no wake

    A value that is neither on nor off is reported and pauses.

  - **Usage readout**, the same on every door: Telegram `/usage`, a line in the web header, and `usage` in the admin status. The web line is read again only while the agent is awake anyway (the session opening, your message, work running, the tab coming back into view), at most every 30 seconds, so it never wakes a hibernated agent. Details show on hover. It shows today's estimate, the spend cap, the run cap's rounds, and each provider's own figures where MiPi can read them. `src/agent/usage-sources.ts` holds one reader per provider. OpenCode Go is the first: its rolling, weekly and monthly windows from `GET https://opencode.ai/zen/go/v1/usage` (the shape OpenCode's own client reads). Reads are cached in memory for five minutes, failures too, and callers at the same moment share one read. The admin status measures nothing and asks no provider: it shows the spend as last measured and what is cached, so a GET writes nothing.
  - Optional settings: `OPENCODE_USAGE_KEY`, a key with usage permission when the model key has none, and `OPENCODE_ORG_ID`, the workspace id if Go asks for one. The deploy workflow passes them, and `MIPI_DAILY_SPEND_CAP` and `MIPI_PAUSED` from a lane's Environment variables, over `wrangler.jsonc`'s values. An unset `OPENCODE_USAGE_KEY` is written as `off`, as the relay tokens are, so removing it takes effect.
  - `docs/deployment.md`: a "Spend cap, pause and usage" section, with how to pause a lane.

  **Changed**

  - Older scheduled deliveries (`app.deliver-scheduled-instruction`) follow the same rule. Paused or at the cap, the occurrence isn't delivered, and a successor carries the schedule to its next time (a repeat) or past Chicago midnight (a one-time one). At the cap, the day's notice goes to the chat that wrote last. An occurrence already submitted before a restart is never held.
  - `chicagoDay`, `afterNextChicagoMidnight` and `CAP_ZONE` moved to `src/lib/cap-day.ts`; `proactive.ts` re-exports them.
  - `RoundBudget` can stop a run for `spend-cap` or `paused`, besides `daily-cap` and `run-limit`.

  **Pi Durable**

  - No version change (1.6.0). Ledger: L7 now covers the spend cap and the pause, checked at the same two places as the run cap. It is renamed "Daily caps are checked at admission and after each tool round".

  **Migration**

  - New session document `app.spend`. An older build ignores it, so this isn't one-way. After a rollback:
    - a run stopped for `spend-cap` or `paused` would be reported as a run-limit stop
    - a reminder's `skippedPaused` count is dropped the next time it runs
  - Fixture capture now seeds `app.spend`. The release that carries this captures its fixture DB with `pnpm fixture:capture`.

- a3747a5: COD-207: the agent's one alarm takes wake-ups from a list of wake sources that names no door.

  **Changed**

  - Internal only, no behaviour change. Each part that needs the alarm (today the Telegram door and the memory pass) registers once as a wake source (`src/agent/wake-sources.ts`): its wake, what the alarm runs, which commits make it look again, and how it closes.
  - `alarm.ts` no longer imports the Telegram door. The alarm, the commit observer and shutdown loop over the sources instead of naming them, and the alarm runs them in registration order after Pi Durable, as before.
  - Sources are registered when the harness opens and cleared when it closes, so a reopen after an export or restore registers each once. A second source with the same name throws.
  - A source closed while the alarm runs (maintenance taking the object) is skipped. A source that throws while observing a commit or closing is reported, and the others still run.
  - Lint: `alarm.ts` and `wake-sources.ts` may not import a door, tool or extension (an oxlint override beside the Pi seam rule).

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. No stored data changes.

- 845d857: COD-190: the web transcript formats replies, and collapses long tool results.

  **Changed**

  - The web door shows assistant replies and context summaries as formatted markdown. That covers paragraphs, headings, bold, italic, strikethrough, inline and fenced code, bullet and numbered lists, block quotes, rules and links. Before, it printed the `**`, `- ` and backticks as written. A reply still streaming is formatted as it arrives.
  - Links open only for `http(s)`, in a new tab with no referrer. Anything else, including HTML or a `javascript:` link in a reply, shows as text.
  - User, scheduled and queued messages still show exactly as typed.
  - A tool result longer than 600 characters or 12 lines starts collapsed. Its one-line summary gives the fetched page's URL (or the result's first line) and its length. Short results and failures stay open.
  - The inline markdown parse moved from `telegram-html.ts` to `src/lib/markdown.ts`. Both doors use it, and Telegram's output is unchanged.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. Only the web page changes.

## 0.1.0-beta.1

### Minor Changes

- COD-185: `0.1.0-beta.1`, the feature-complete release, with the first fixture database. From this release on, stored data must survive upgrades.

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

- f56d5d8: COD-151 (M4, work in progress): Cloudflare Access.

  **Added**

  - The Worker verifies Cloudflare Access JWTs (`Cf-Access-Jwt-Assertion`: RS256, issuer, audience, time; team keys cached, refetched on an unknown key at most once a minute or hourly). A person's token opens web routes and the socket; the deploy service token (`common_name` = `ACCESS_SERVICE_CLIENT_ID`) opens admin routes only.
  - WebSocket upgrades from another site are refused.
  - `MIPI_ACCESS_SKIP=1` skips auth on localhost only; on any other host it refuses every request.
  - Deploy scripts send the Access service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`); `deploy.ts version` reads the deployed version through the admin API.

  **Changed**

  - Access is on once a lane's GitHub Environment has the variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (passed as Worker vars at deploy). Until then the spike lock and `ADMIN_TOKEN` apply as before, so deploying this changes nothing.
  - The deploy and rollback workflows read the deployed version through the admin API, since the public health check shows none.

  **Pi Durable**

  - No change (1.6.0). No ledger changes.

  **Migration**

  - None until Access is set up for a lane.

- 56e8856: COD-174: a burst of messages gets one reply, from every door.

  **Changed**

  - `followUpMode: "all"`: every input queued behind a running turn joins the next turn together, whichever door it came from (web, Telegram, relay, scheduled). Before, each queued input took a turn of its own. An idle web or relay message still starts its turn at once.
  - Telegram: a message to an idle conversation opens a 2-second window, and the messages of that window go to the model as one input with one stamp. Later messages join the window without moving its deadline. A window is sent early at 50 messages or 32,000 characters. A message that arrives after its window's deadline is admitted after that window is sent. When the conversation is already busy, a message goes straight to the queue as before.
  - A web or scheduled turn that starts during the wait makes the Telegram batch its follow-up.
  - `/new` sends a waiting window to the old conversation before it starts the new one.
  - `/model <id>` and `/profile <name>` answer "I'm still working on your last message; try again in a moment." while a message waits or a turn runs. `/model` checks again when the change is applied. `/model` and `/profile` without an argument still answer.
  - Messages that fail together get one notice instead of one each.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. The seam re-exports `ConversationIdle`, `LiveDoc` and `InboxDoc`. The contract test checks that `whenIdle: "reject"` refuses an idle conversation before writing anything, and that the same commit can still write documents.

  **Migration**

  - None. The window lives in a new optional field (`staged`) of the `app.telegram` document, so the document keeps its version. A rollback to the previous build ignores the field; messages waiting in a window at that moment would not be sent.

- 74f2a6d: COD-182 (M8 slice 1, part of COD-154): memory. MiPi keeps short lessons across conversations and doors.

  **Added**

  - `remember(text)` and `forget(id)` tools, on the `default` and `pidu` profiles. `empty` still has no tools.
  - The `app.memory` session document. It holds up to 20 lessons of at most 300 characters each.
    - Lesson ids are `m1`, `m2`, …, and they're never reused.
    - Each lesson records where it came from: web, Telegram, relay or a reminder, plus the conversation.
    - Whitespace becomes one line and invisible characters are removed.
    - Empty text, text that's too long, or a 21st lesson is refused with the reason. Nothing is trimmed.
    - An exact duplicate changes nothing.
  - A `memory` system section lists the lessons by id, and the lesson text can't close the tag. It comes after the static preamble, so a new lesson changes only the end of the prompt. It's left out when there are no lessons, and wherever `remember` isn't offered.
  - `remember` refuses in a run that called `web_fetch` (slice 2), so a fetched page can't write itself into memory. The check reads the run's stored entries, so it still holds after a restart. The owner's next turn works again. Relay runs aren't blocked.

  **Changed**

  - The `default` and `pidu` profiles gain `remember` and `forget`. Existing conversations get them on the next start, through the existing profile-tools sync.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. `app.memory` is a new document.

- 9b0060b: COD-184 (M8 slice 3, part of COD-154): the background memory pass. It replaces "save before compaction".

  **Added**

  - Once a conversation has been idle for 30 minutes, the alarm runs one pass on it. The pass reads what was said since the conversation's mark, plus the lessons already saved, and asks the conversation's own model for at most 3 new lessons. They're saved by `remember`'s rules, with source `background`. It's silent.
  - The pass reads raw entries, newest first, up to 40,000 characters. Compaction never changes raw entries. Scheduled deliveries, `NO_SEND` answers, tool calls and tool results are left out.
  - A pass never calls the model in these cases:
    - The profile has no `remember`.
    - Memory is full.
    - There's no new message from a person.
    - Scheduled runs are paused (`MIPI_DAILY_RUN_CAP` 0).
    - Today's 20 passes are used.
  - While memory is full or the runs are paused, the pass sets no alarm at all. Forgetting a lesson or resuming the runs brings it back.
  - One pass runs at a time, and one per conversation, so a second alarm during a request can't ask about the same range twice.
  - A conversation with no timed message yet sets no wake.
  - A busy conversation is put off 30 minutes.
  - A range with a `web_fetch` call or result anywhere is passed over without a request, and its mark moves past it.
  - A failed or unreadable reply keeps the mark and waits 5, then 30 minutes. After 2 retries the range is given up, so an outage can't use up the day.
  - The pass's spend counts in the conversation's `pi.usage`.
  - The new `app.memory-pass` document holds each conversation's mark and today's count.
  - The pass's wake is never active, so the 60-second heartbeat doesn't run while it waits.

  **Changed**

  - Once a turn settles, the alarm now stays set for the next memory pass instead of being deleted.
  - `titles.ts` exports `recordUsage` and `providerSession`, which the pass uses too.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. Pi Durable's `beforeCompact` hook can't write, so the pass works from idle conversations instead of before compaction, the way Codex writes its memories.

  **Migration**

  - None. `app.memory-pass` is a new document. A conversation's first pass reads its whole history, up to the 40,000-character budget.

- f9f49a3: COD-153 (M6, part 3): proactive runs. A scheduled check can stay quiet, knows what it sent lately, and has a daily cap.

  **Added**

  - `NO_SEND`: a reminder's run that finds nothing worth saying answers `NO_SEND`, and Telegram sends nothing. It counts only as the whole visible answer (after any `<think>` block). A failed tool still sends a notice, and a run that also answered a message is never quiet: the message gets a fallback instead of `NO_SEND`.
  - Provenance (`app.proactive`): an `onYield` hook task records which inputs each answer covers, and Telegram inputs and reminders are reconciled together, one judgement per answer.
  - Recent sends: the last 10 confirmed reminder messages, shown to the next reminder in its notes so it doesn't repeat itself. They live in the session, so they survive `/new`.
  - Daily cap on model rounds for scheduled runs: `MIPI_DAILY_RUN_CAP` (new var, default `50`, `0` pauses them; an invalid value is reported and the default used), per Chicago day. Interactive chat never counts. At the cap a run stops with one notice a day (it waits for a blocked run with a chat to tell, if none is known yet); a one-time Telegram reminder is still sent as plain text without the model; a one-time web reminder waits until just after Chicago midnight; a repeat skips that time.
  - A run is stopped after 8 tool rounds, with a notice naming the reminder.
  - A reminder whose answer is empty (thinking only) sends a notice instead of nothing.
  - Web: a reminder's `NO_SEND` answer shows as a muted "Nothing to report".

  **Changed**

  - Reminder messages carry a "[Notes for this run]" block for the model (the `NO_SEND` rule and recent sends); the web shows only the instruction.
  - Reminders of every destination are tracked in `app.proactive` instead of the Telegram door's inputs.
  - The Telegram door remembers the last chat that wrote (`lastChat`), for cap notices from web reminders.

  **Pi Durable**

  - No version change (1.6.0). The seam adds `GenerationTask`, `hook` and `hookTask`; the contract test pins that an `onYield` task sees the committed answer and that `afterTools` `{ terminate: true }` settles the input `done`.
  - New ledger entry L7 (workaround): the cap counts model rounds at admission and after each tool round, because `beforeRequest` can't write.

  **Migration**

  - None. Older builds ignore `app.proactive`; rolling back loses only the delivery of reminders that are running at that moment.

- d4b10a2: COD-150 (M3): one agent for its owner, with tool profiles, titles and a model picker.

  **Added**

  - Tool profiles (`src/agent/profiles.ts`): `default` (schedule, search_history), `empty` (no tools) and `pidu` (the default tools for now), as plain data. `toolsFor(profile)` is the only place a profile becomes tools. Each conversation stores its profile; new ones start on `MIPI_PROFILE` (new var, default `default`), and the relay will start on `pidu`. `test/profiles.test.ts` checks the exact tools each profile is offered and that no codemode or tool-search section appears.
  - Channel bindings (`app.channel-binding`): a channel key maps to the conversation it talks to and sets its starting profile. The web is bound to the main conversation; Telegram and the relay bind theirs in M5 and M7.
  - Conversation titles: a conversation is named from its first message at once; a long one is renamed by its own model (3 to 6 words, adapted from Pi Pocket `titles.ts` @ `2f060f2`, MIT). The cost counts in the conversation's usage.
  - Web: a model picker (only models in both OpenCode Go's live list and pi-ai's catalog; other ids are refused) and a profile picker, both per conversation. Conversations are listed by title.

  **Changed**

  - Every session request goes to the owner's Durable Object (`MIPI_OWNER`); any other session id is 404 and never creates an object. The spike probe uses the owner's object too.
  - The speaker in message stamps is `MIPI_OWNER`, not a name the browser sends. The web no longer asks for a display name.
  - Web input uses request ids `web:<client key>` and is checked with `submissionByRequest` before admitting, so a retry admits nothing.
  - Web: the "pi-durable / Session" header is now "MiPi"; system entries are hidden behind a "Show system entries" toggle.
  - The alarm function is `scheduleNextAlarm()`, the one place the alarm is set.

  **Pi Durable**

  - No version change (1.6.0). The seam adds `ProviderDoc` and `UsageDoc` (used by titles). No ledger changes. New MiPi documents (`app.conversation`, `app.channel-binding`) need no definition to be stored, so older builds open the data unchanged; not one-way.

  **Migration**

  - None. The main conversation gets its profile recorded (`default`) on the first web visit; its tools don't change.

- 18c014d: COD-180 (M7 slice 1, part of COD-155): the agent side of the PiDu relay. There is no HTTP route yet; slice 2 (COD-181) adds `POST /api/relay` and `GET /api/relay/:key`.

  **Added**

  - `src/lib/fence.ts`, copied from Pi Pocket (`defang`, `attribute`, `quoted`, `clip`). Relay text goes between `<relay from="pidu">` tags it can't close. This includes closing tags with spaces, invisible characters or line breaks before the `/`.
  - `relayRequest(key)`: request id `relay:<key>`. A key must be 1 to 64 letters, digits, `-` or `_`. Any other key is rejected, never cleaned, so two keys can't become one.
  - The Durable Object's `relayAdmit(key, text)` and `relayResult(key)`. A message goes to the `relay:pidu` conversation, which runs on the `pidu` profile. It is stamped `[PiDu · time]`, and `relayAdmit` waits up to 25 seconds for the answer.
  - Results: `done` with the answer, `pending`, `unanswered` with a reason, `conflict` (the same key with another text, checked by SHA-256), `limited` with seconds to wait, `invalid`, `too-large` (over 16,384 UTF-8 bytes), `not-found`, or `unavailable`.
  - A cap of 60 messages per sliding hour. A duplicate key or a conflict uses no slot.
  - The `app.relay` document keeps the key receipts and the hour's admission times. Up to 2,000 receipts are kept, and a receipt whose input is still open is never dropped. If a key's receipt was dropped but its input is still stored, the key gets that input's result, never a conflict.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. `app.relay` is a new document.

- 9782635: COD-181 (M7 slice 2, closes COD-155): the PiDu relay's HTTP door.

  **Added**

  - `POST /api/relay` needs `Authorization: Bearer <RELAY_TOKEN>`, an `Idempotency-Key` header (1 to 64 letters, digits, `-` or `_`) and `{ "text": "…" }`. It waits up to 25 seconds for the answer:
    - `200 {id, status: "done", answer}` when the answer is ready.
    - `202 {id, status: "pending"}` when it isn't, with `Location: /api/relay/<key>`.
    - `200 {id, status: "unanswered", reason}` when the turn ends without an answer.
  - `GET /api/relay/<key>` reads a key's result with the same token. A key that isn't valid gets 404 without the agent being asked.
  - Errors:
    - `400`: a bad key, a body that isn't JSON, or empty text.
    - `401`: a wrong or missing token, or the relay is off.
    - `404`: an unknown key.
    - `405`: the wrong method.
    - `409`: the same key with another text.
    - `413`: a body or text over the limit.
    - `429`: over 60 an hour, with `Retry-After`.
    - `503`: maintenance or the agent can't be reached, with `Retry-After`.
  - The new secret `RELAY_TOKEN` is set per lane (24+ characters). Without it the relay is off. `RELAY_TOKEN_PREVIOUS` is also accepted while the token is rotated. The deploy workflow passes both, and writes `off` for an unset one. Wrangler's `--secrets-file` keeps secrets that are left out, so this is how removing a token takes effect.
  - README: a PiDu relay section with the GitHub and Cloudflare Access steps.

  **Changed**

  - The Telegram webhook's bounded body reader moved to `src/worker/body.ts`, which the relay uses too.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. To turn the relay on for a lane: add `RELAY_TOKEN` to its GitHub Environment, add the Access Bypass application for path `api/relay`, then deploy.

- 45ff3d2: COD-153 (M6, part 1 of 3): reminders that reach the chat they came from.

  **Added**

  - Reminders. `schedule` now makes one durable task per reminder. The task sleeps until each time, delivers that time to the conversation the reminder was made in, and for a repeat sleeps again, so the model no longer schedules each next time itself.
  - A new `when` argument takes times as people say them, in the owner's time zone: `in 2m`, `tomorrow 9am`, `every weekday 8:00`, `every 30m between 9:00 and 17:00 on weekdays`. The parser is Pi Pocket's `when.ts` (`src/lib/when.ts`). Clock times stay on the wall clock across daylight saving. In Chicago, a time skipped in spring (02:30) moves forward by the gap, and a time that happens twice in autumn (01:30) runs once, at the earlier instant. `delaySeconds` and `at` still work for one-time reminders.
  - Where the answer goes is stored with the reminder. A reminder made from Telegram answers in that private chat, also with no browser open and after `/new` rebinds the chat. A reminder made on the web stays in its conversation.
  - Each delivery has its own request id (`sched:<reminder>:<n>`), so a retried delivery is admitted once.
  - Limits:
    - Repeats are at least 10 minutes apart.
    - At most 25 schedules wait at once, counting schedules from earlier builds.
    - A repeat skips a time while its previous delivery is still queued or running, and counts the skip.
    - A repeat skips a time that comes more than 15 minutes late, and moves to its next time.
    - A one-time reminder always goes out, however late.
    - A reminder's own turn can't make another reminder (a repeat already schedules itself). A turn that also answers a message can.

  **Changed**

  - The `schedule` tool's `recurrence` argument is gone: repeats use `when`. A schedule made by an earlier build keeps running as before, including its `sourceScheduleId` successor.
  - The Telegram door's state document moved to `src/agent/telegram-state.ts`. Its pending inputs may now have no `update_id` (a reminder's delivery). The door picks up inputs other parts of the agent record, through a commit observer.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. New task kind `app.reminder` (version 1). The legacy `app.deliver-scheduled-instruction` stays registered.

  **Migration**

  - None needed: stored schedules keep running.
  - After a rollback to an earlier build, reminders made by this build don't run: that build doesn't know the `app.reminder` task. Pi Durable marks such a task blocked (`missing_task`) and reports it, without crashing, and the rest of the agent keeps working. The reminders run again once you roll forward.

- b2ddcbd: COD-169: hardening before M4.

  **Fixed**

  - An export whose script died no longer keeps the agent closed: an export flag older than 10 minutes (`maintenance_started_at`) is cleared on start or on the next request. A restore never expires, so partial data never opens.
  - A deploy backup that can't be taken now stops the deploy. Only a 404 (no agent yet) skips it; a wrong `ADMIN_TOKEN`, a 403, a 5xx or no answer fails with the reason.
  - An export refuses a table without a rowid before closing the agent, instead of failing halfway.

  **Changed**

  - The deploy, rollback and restore workflows use the GitHub Environment of their lane (`staging` or `production`; auto-deploys from `main` use `staging`). Repository secrets stay the fallback.
  - New optional secret `ADMIN_TOKEN_PREVIOUS`: while a lane's token is rotated, the backup and the rollback's version check try it after `ADMIN_TOKEN`.
  - `pnpm check` builds and dry-runs both lanes (`scripts/dry-run.ts`).
  - `AGENTS.md`: a Code style section for every coding agent, adapted from Pi's own rules, and the Layout now lists `src/lib/` and `src/protocol.ts`.
  - The owner's time zone is no longer module state: stamps take it explicitly, and scheduled deliveries read it from the agent's session (`app.settings`), written from `MIPI_TIMEZONE` when the agent opens.

  **Pi Durable**

  - No change (1.6.0). No ledger changes. The contract test now round-trips an export of a real harness's tables and checks none is `WITHOUT ROWID`.

  **Migration**

  - None needed. To separate the lanes' secrets, create the GitHub Environments `staging` and `production` and add their secrets (see the README); until then the repository secrets are used.

- 2de1b88: COD-152 (M5): Telegram inbound.

  **Added**

  - `POST /api/telegram`, Telegram's webhook. It is routed before the owner's web authentication. Its own secret (`X-Telegram-Bot-Api-Secret-Token`, compared in constant time) authenticates it, and the route refuses everything while `TELEGRAM_WEBHOOK_SECRET` is unset or invalid. Bodies are capped at 128 KiB while they are read. The route answers 401 for bad auth, 405 for a wrong method, 413 for an oversized body, 503 when the agent can't store the update (Telegram retries), and 200 otherwise.
  - Only text in a private chat from an allowlisted sender (`TELEGRAM_ALLOWED_USER_IDS`) reaches the agent. A photo or other non-text message gets a short hint. Groups, edits, callbacks and strangers are acknowledged and dropped.
  - Each chat has its own conversation (binding `tg:<chat_id>`), and its messages are stamped like every other door's. The webhook answers 200 only after the agent durably stored the update. A receipt per `update_id` (kept 48 hours, at most 2,000) makes a replay do nothing, also after `/new` or a restart. Inputs use request id `tg:<update_id>`, and the submit runs in the same commit as the receipt.
  - Commands: `/start`, `/new`, `/version`, `/profile [name]`, `/model [id]`, also suffixed with this bot's username (`TELEGRAM_BOT_USERNAME`); commands addressed to other bots are ignored. None of them calls the model. `/model <id>` is recorded first and checked against the live model list after the webhook has answered.
  - A durable outbox for everything sent to Telegram. Each chat sends first in, first out, one message per second. Long replies are split into messages of at most 4,096 UTF-16 units, never inside a grapheme. A 429's `retry_after` is honoured and 5xx errors back off (5 attempts). A permanent refusal (revoked token, blocked bot) ends that reply without waking again. A send cut off mid-request is recorded as `delivery-unknown`, never sent twice. After a failed or unknown chunk, the rest of that reply is skipped and the chat moves on.
  - Each reply goes to the chat its message came from, even after `/new` rebinds the chat. An input that ends without an answer gets a short notice instead of silence. After a restart, answers not yet turned into replies and replies not yet sent are picked up again.
  - The deploy workflow passes the Telegram secrets and variables to the Worker and registers the webhook after a healthy deploy (`scripts/telegram-webhook.ts`: `allowed_updates: ["message"]`, one connection).

  **Changed**

  - The one alarm also covers the Telegram outbox's next send, and keeps the recovery heartbeat while a Telegram input or command is waiting.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes. Newly relied on, and covered in `test/contract.test.ts`: `Conversation.submit(tx, …)` after document reads and before document writes, `tx.submission`, `tx.submissionByRequest`, `tx.entry`, and `Harness.submission(id).wait`. The seam also re-exports the `SubmissionId` and `SubmissionRecord` types.

  **Migration**

  - None. Telegram stays off until a lane has `TELEGRAM_BOT_TOKEN`. To turn it on, see the README's Telegram section. The new session documents (`app.telegram`, `app.telegram-outbox`) need no migration.

- 9eef5e8: COD-153 (M6, part 2 of 3): Telegram messages look right and get through.

  **Added**

  - Telegram replies are formatted. The model's markdown is rendered into Telegram's HTML: bold, italic, strikethrough, inline code, code blocks with their language, http(s) links, headings (shown bold) and quotes. Anything else is escaped text, as written.
    - Underscores inside words stay as they are (`MIPI_DAILY_RUN_CAP`).
    - Markers inside code stay as they are.
    - A marker without its partner stays literal.
    - Tags never cross.
    - A code span or link inside emphasis stays whole, also right at its start.
    - CRLF line endings are read like LF.
  - A reply is split before it is rendered, so no tag spans two messages. A code block cut by a split is closed and reopened, and the splitter keeps room for those fences.
  - If Telegram can't read a chunk's HTML ("can't parse entities"), that chunk is sent once more as plain text (the markdown source). The switch is saved first, so a restart can't send the broken HTML again.
  - If Telegram finds a chunk too long, only that chunk is split in two, in place. A chunk is split at most three times.
  - A send with an unclear outcome is tried once more: a timeout, a lost answer, an answer without a message id, or a chunk left `sending` by a restart. The retry is counted before it runs. If the retry is unclear too, the chunk is `delivery-unknown` and the rest of that reply is skipped. Telegram can't look a message up in a chat, so a rare duplicate is the lesser harm than a lost reminder.
  - On start, every conversation gets the tools its profile names where they differ. Conversations older than profiles kept the tools they were created with, so one could show `default` and still offer no `schedule`.
    - The pass leaves models alone.
    - It runs once, then again only when a profile's tools change (a digest in the agent's settings), so a normal start costs one read.
    - The web door's binding now gives a conversation older than profiles its profile's tools as well as the name.

  **Changed**

  - The alarm code moved to `src/agent/alarm.ts`. The alarm is still the earliest of Pi Durable's next wake, the Telegram door's next need, and the heartbeat, and it is deleted when nothing needs it. Each of the alarm's consumers now runs in its own `try`, so a failing Telegram door can't stop Pi Durable from resuming, and the alarm is always rescheduled unless maintenance runs.
  - Error descriptions from Telegram are matched without regard to case, and a 429's `retry_after` is capped at an hour.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. All new outbox fields are optional, so the document keeps its version.
  - Chunks stored by an earlier build have no id, HTML or retry policy. They keep sending as plain text, and an unclear outcome stays final for them.
  - An earlier build reading chunks made by this one sends their plain text and ignores the new fields.

- ba67eb5: COD-183 (M8 slice 2, part of COD-154): `web_fetch` reads one web page.

  **Added**

  - The `web_fetch(url)` tool, on the `default` and `pidu` profiles.
    - It sends a GET with `User-Agent: mipi/<version>`.
    - It follows at most 3 redirects, by hand, checking each one.
    - One 10-second deadline covers every hop and the body.
  - Refused hosts, checked again on every redirect:
    - IP literals in any form: dotted, hex, octal, one number, or IPv6.
    - `localhost`, including with a trailing dot.
    - `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.lan` and `*.intranet`.
    - Single-label names.
    - URLs with a username or password.
    - Any scheme other than http and https.
    - MiPi's own hostnames. Each door records the hostname it was reached on (the web socket upgrade, Telegram's webhook, the relay) in `app.settings` as `ownHosts`, and `web_fetch` reads them. So a page can't make MiPi fetch its own Access login or its open routes, on `workers.dev` or on a custom domain.
  - Content: only text types are read (`text/*`, JSON, XML, `+json` and `+xml`). For anything else the body is cancelled and the tool says what it was.
    - The raw body is read up to 1 MB and the rest is cancelled.
    - The text is cut at 50,000 characters, and a cut page says so.
  - HTML becomes text through HTMLRewriter (`src/lib/html-text.ts`).
    - Scripts, styles, `noscript`, `svg`, `template`, `iframe` and `object` are removed whole in a first pass, so a self-closing `<svg />` can't swallow the rest of the page.
    - Block elements become line breaks, and entities are decoded.
  - The page reaches the model inside `<fetched url="…">` tags it can't close, with a line saying it is data, not instructions. `remember` already refuses in a run that fetched (slice 1).

  **Changed**

  - The `default` and `pidu` profiles gain `web_fetch`. Existing conversations get it on the next start.

  **Pi Durable**

  - No version change (1.6.0). No ledger changes.

  **Migration**

  - None. `ownHosts` is a new optional field of `app.settings`.

## 0.1.0-alpha.5

### Minor Changes

- COD-166: cache-stable prompts, at the agent level for every door.

  **Changed**

  - The system prompt is static: the per-minute "Current time" section is gone. It appended a new system entry every turn (the System lines in the transcript) and kept the prompt prefix from staying identical, which is what provider prompt caches key on.
  - Every message is stamped with who sent it and when, in the owner's time zone (`MIPI_TIMEZONE`, default `America/Chicago`): `[Jerome · Sun, Nov 22, 2026, 12:40 CST]`. Scheduled deliveries carry their local time too (`Scheduled instruction due now (…): …`); the client still recognizes both the new and the old form.
  - One cache policy for all conversations: `cacheRetention: "long"` in the harness's stream settings. It takes effect on models that support explicit retention (Anthropic-format: 1h; OpenAI-format: 24h) and is ignored elsewhere. `deepseek-v4.1-flash` on Go has no explicit cache controls: DeepSeek caches identical prefixes on its own, and OpenCode's session header keeps each conversation on the same backend, so the identical prefix is what matters.

  **Added**

  - Test: three turns hours apart, each request an exact prefix of the next, no new system messages between turns, and the cache policy on every request.
  - The web header shows cached prompt tokens and the share of the prompt served from cache.

  **Pi Durable**

  - No change (1.6.0).

  **Migration**

  - None. Existing conversations keep their old clock entries; new turns stop adding them.

## 0.1.0-alpha.4

### Minor Changes

- M2b: staging lane, startup guard, backup and restore, upgrade and rollback tooling.

  **Added**
  - Startup guard: before Pi Durable opens the stored data, the agent checks its schema version and the version of every stored task kind. Data from a newer build is refused with a 503 naming both versions, instead of half-running (a newer task would only fail when next run) or crash-looping. Refused data can still be exported.
  - Maintenance mode: export and restore close the harness and pause every door and alarm. Pi Durable's work resumes when it reopens.
  - Export: paged by rowid with the schema (`_cf_*`/`sqlite_*` skipped), sized for the free plan's CPU. A fingerprint taken at the start and end fails an export that something wrote during.
  - Restore: a `restoring` flag written first and cleared last (an object that restarts halfway stays closed), wipe, schema, paged rows, a row-count check against the export, then the guard. Point-in-time bookmark restore too.
  - Admin API behind `ADMIN_TOKEN`; `/api/health` shows versions only to it.
  - Staging lane `mipi-staging` (own storage): every push to `main` deploys there; production deploys by hand. Every deploy backs up its target first (30-day artifact).
  - Workflows `rollback` (refuses to cross a one-way release unless forced) and `restore` (a backup or a bookmark).
  - Scripts: `deploy.ts` (backup, restore, status, rollback check), `upgrade-pi.ts` (`pnpm upgrade:pi <version>`), `stamp-version.ts` (`src/version.ts`, checked in `pnpm check`). One-way releases are marked with `**One-way:**` in their changeset.

  **Changed**
  - `pnpm check` also verifies `src/version.ts` and type-checks `scripts/`; `pnpm version` re-stamps after `changeset version`.

  **Pi Durable**
  - No change (1.6.0). Found: Durable Object SQL forbids `total_changes()` and `PRAGMA schema_version`, and local bookmarks advance on every call, so the export's write check is a data fingerprint.

  **Migration**
  - New repository secret `ADMIN_TOKEN` (24+ random characters) before the next deploy. Production no longer deploys on every push: run the deploy workflow with target `production`.

## 0.1.0-alpha.3

### Minor Changes

- M2a: Pi Durable sits behind one folder, enforced by lint and a contract test.

  **Added**
  - Lint (`oxlint`, in `pnpm check`): nothing outside `src/agent/pi/` and `test/` may import `@earendil-works/*`, subpaths included (`@earendil-works/chord/context` is the import that touched 25 files in Pi Pocket).
  - `test/contract.test.ts`: every name the seam exports, used once against the real packages on Durable Object SQLite (a full tool-using turn, docs, doc families, schemas, chord deltas).
  - `src/agent/pi/storage.ts`: reads the stored Pi Durable schema version and the highest stored version of each task kind, and compares them with what this build supports (for M2b's startup guard).

  **Changed**
  - `src/agent/pi/` exports only the names MiPi uses instead of whole packages. The browser code (`src/client/`, `src/protocol.ts`) now goes through `src/agent/pi/shared.ts`.
  - One session per owner (pulled forward from M3): the web app always opens the same session (`MIPI_OWNER`, default `jerome`), and a returning visitor goes straight back to it instead of starting a new one.

  **Pi Durable**
  - No change (1.6.0). Found while writing the readers: the `tasks.kind` column holds the kind JSON-encoded, so the readers use the task record's own `kind` and `version`.

  **Migration**
  - Conversations from the M1 spike were in separate, randomly named sessions and don't appear in the owner's session. Nothing to do (alpha).

## 0.1.0-alpha.2

### Minor Changes

- M1 free-plan spike: MiPi deploys to Cloudflare from GitHub Actions, behind a temporary lock.

  **Added**
  - Deploy workflow: after `check` passes on `main` (or by hand), `wrangler deploy` ships the Worker `mipi` with `OPENCODE_API_KEY` and `MIPI_SPIKE_TOKEN` uploaded in the same version, then checks `/api/health`.
  - Release workflow: a new version on `main` gets its tag and a GitHub release from its `CHANGELOG.md` section (pre-releases for `-alpha`/`-beta`).
  - Spike lock (until Cloudflare Access in M4): every `/api` route and the WebSocket upgrade need `MIPI_SPIKE_TOKEN`, as an HttpOnly cookie set once by `POST /api/unlock` or as a Bearer header. Constant-time compare; refuses everything when the secret is unset. The web app asks for the token once.
  - `/api/health` (public, says only `{ ok: true }`) and `/api/spike/probe` (locked; reports whether Durable Object point-in-time recovery bookmarks work).
  - `spike-probe` workflow: which OpenCode Go usage URL answers and its shape, the PITR probe, and Worker CPU/error/subrequest analytics.

  **Changed**
  - pi-ai gets `OPENCODE_API_KEY` from the Worker's bindings through its `authContext`, not from `process.env` (which a Worker only has with Node compatibility). Tested in workerd.

  **Pi Durable**
  - No change (1.6.0).

  **Migration**
  - New repository secret `MIPI_SPIKE_TOKEN` (24+ random characters) before the first deploy.

## 0.1.0-alpha.1

### Minor Changes

- M0 scaffold: MiPi seeded once from `earendil-works/pi-durable-cloudflare` @ `b68bf92` (MIT).

  **Added**
  - `src/agent/pi/`: the seam for all Pi Durable, pi-ai, pi-schema, and chord imports on the server (M2a narrows it and adds the lint rule).
  - OpenCode Go as the model provider (pi-ai's built-in `opencode-go`); default model `deepseek-v4.1-flash` at thinking level `low`, set by the `MIPI_MODEL` var.
  - Per-model compaction reserve (`summaryReserve`, adapted from Pi Pocket @ `2f060f2`, MIT) so long conversations keep room for their summary; `deepseek-v4.1-flash` gets 32,768 tokens.
  - Changesets in `alpha` pre mode, exact dependency pins, `.node-version`, and a CI workflow running `pnpm check` and `pnpm test`.

  **Changed**
  - Layout: `src/worker/`, `src/agent/`, `src/tools/`, `src/lib/`. The Durable Object is `MipiAgent` on binding `AGENT`; the Worker is `mipi`.
  - Client: tool calls that park (`waiting`, `sleeping`) show as running, and a sleep without a deadline shows as "until woken".

  **Removed**
  - The sample's mock `get_weather` tool.

  **Pi Durable**
  - `pi-durable`, `pi-ai`, `pi-schema`, `chord` 1.6.0 (from the sample's 1.5.2). Storage: Pi Durable 1.6 (`pi.tool` tasks v4, `pi.generation` v3).

  **Migration**
  - None: first release, no data.
