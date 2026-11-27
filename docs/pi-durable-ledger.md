# Pi Durable ledger

Every place MiPi departs from, works around, or depends on the inside of Pi Durable (and pi-ai), and what upstream is doing about it. Read this on every `pnpm upgrade:pi`: the script prints the open entries after Pi Durable's changelog.

**Kinds**

- **workaround**: Pi Durable or pi-ai lacks something or gets it wrong for MiPi, and MiPi patches around it. Remove the code once upstream fixes it.
- **internals**: MiPi reads something Pi Durable does not export as API (a table, a record field). Recheck on every upgrade.
- **choice**: MiPi deliberately does something differently from Pi Durable's default or sample. It stays unless upstream makes it pointless.
- **watch**: upstream work MiPi is waiting on. There may be no MiPi code yet.

**Fields**: Kind, Since, Upstream, MiPi, and Remove when (or Revisit when). Optional: **Upstream link**, one or more https links to the Pi Durable or pi-ai issue, PR, commit or release the entry waits on, separated by spaces. Add one as soon as it exists: a link is what a watcher can follow, and `pnpm ledger` shows "none yet" until then.

**Rules**

- Code that belongs to an entry carries a `pi-ledger L<n>` comment, so `grep -rn "pi-ledger L3"` finds all of it. `pnpm check` fails if a comment names a missing entry, or if a workaround, internals or choice entry has no comment.
- A changeset that adds, changes or removes an entry says so in its **Pi Durable** note, for example "Ledger: L1 removed, pi-ai 1.7 reads Worker bindings".
- Removed entries move to **Closed** at the end with the version that closed them. Ids are never reused.

## Open

### L1 · Model keys come from Worker bindings

- **Kind:** workaround
- **Since:** 0.1.0-alpha.2
- **Upstream:** pi-ai 1.6.0 reads API keys through `globalThis.process.env`, which a Worker has only with `nodejs_compat`.
- **MiPi:** `createGoModels` passes `createModels` an `authContext` that reads the Worker's own bindings, and says no files exist.
- **Remove when:** pi-ai resolves keys in a Worker without `nodejs_compat`, or takes an env object by default.

### L2 · Startup guard reads Pi Durable's tables

- **Kind:** internals
- **Since:** 0.1.0-alpha.3
- **Upstream:** Pi Durable refuses a newer storage schema when it opens, but a task written by a newer version only fails when it next runs. There is no API to read stored versions before opening.
- **MiPi:** reads `durable_schema.version` and each task's `kind` and `version` from `tasks.record` with `json_extract` (the `kind` column is JSON-encoded in 1.6). `test/contract.test.ts` checks the names against a real harness.
- **Remove when:** Pi Durable exports a way to read stored schema and task versions before opening, or refuses newer tasks on open.

### L3 · No clock section; each message carries its time

- **Kind:** choice
- **Since:** 0.1.0-alpha.5
- **Upstream:** the sample this repo was seeded from re-renders a "Current time" section every minute. Each change becomes a new system entry, and Pi Durable's README warns that this defeats prompt caching.
- **MiPi:** the system prompt is static. `stampInput` puts `[speaker · local time]` on every incoming message, including scheduled deliveries. Measured on staging: 1,920 of 4,683 tokens cached (44%) on the second turn.
- **Revisit when:** Pi Durable adds a cache-safe way to give the model the time.

### L4 · Bigger compaction summary reserve

- **Kind:** workaround
- **Since:** 0.1.0-alpha.1
- **Upstream:** Pi Durable's default `reserveTokens` (16,384) gives a summary budget of 13,107 tokens. A long-lived conversation's summary grows past it, and then compaction fails on every run.
- **MiPi:** `summaryReserve` sets a per-model reserve of up to 32,768 tokens (adapted from Pi Pocket).
- **Remove when:** Pi Durable's default reserve scales with the model's output limit, or a failed summary no longer blocks later compactions.

### L5 · Compaction resets the prompt cache

- **Kind:** watch
- **Since:** 0.1.0-alpha.5
- **Upstream:** after compaction the conversation starts with a new summary, so the cached prefix no longer matches and the next turn is a full cache miss. Pi Durable is working on this (noted 2026-11-22).
- **MiPi:** nothing yet. When it lands, check that the Cached share recovers on the turn after a compaction.

### L6 · No long cache retention for Go's Anthropic-format models

- **Kind:** watch
- **Since:** 0.1.0-alpha.5
- **Upstream:** pi-ai 1.6.0's OpenCode Go compat for Claude, Qwen and MiniMax has no long-retention flag, so `cacheRetention: "long"` falls back to the default 5-minute `cache_control`.
- **MiPi:** asks for `long` once, in `CACHE_RETENTION`. Nothing to change on MiPi's side; it takes effect when pi-ai adds the flag.

### L7 · Daily caps are checked at admission and after each tool round

- **Kind:** workaround
- **Since:** 0.1.0-alpha.8
- **Upstream:** Pi Durable 1.6.0's `beforeRequest` hook gets a read-only `HookApi`, so nothing can count a model request as it starts. The first hook that can run a task (and write) is `afterTools`, after each tool round.
- **MiPi:** counts a reminder run's first round when the reminder is admitted (`expectProactive`, from the reminders' `reminder-task.ts`), and each later round in `RoundBudget`'s `afterTools` task (`proactive.ts`), which ends the run with `terminate` at the cap. Provider retries inside one round don't count. The spend cap and `MIPI_PAUSED` (0.1.0-beta.2, `spend.ts`) are checked at the same two places, with today's spend measured first, so a run can overshoot the spend cap by the one round in flight. Drop the admission checks and check in `beforeRequest` once a hook there can write or stop the request.

### L8 · No way from an entry to the input that placed it

- **Kind:** watch
- **Since:** 0.1.0-beta.2
- **Upstream:** Pi Durable 1.6.0 links an input one way: its submission record names the entry it was placed as (`submission.entry`), but a `pi.user` entry carries no submission id or request id, and there is no submission scan. So nothing can ask "which input, from which door, wrote this entry?"
- **MiPi:** nothing yet. The memory pass still leaves reminders' deliveries out of what it reads by recognising their text (`passLines`, `parseScheduledInstruction`), where it would rather use their origin (automated, `src/agent/origin.ts`). When upstream exposes the link (a request id on the entry, or a submission scan by conversation), `passLines` uses origin and keeps the text check only for entries whose origin is unknown (COD-211).

### L9 · Record provider limits before a failed input settles

- **Kind:** workaround
- **Since:** 0.1.0-beta.3
- **Upstream:** pi-ai 1.6.0 exposes the provider error as text without structured status or reset metadata. Pi Durable awaits `afterResponse`, but the observer has no write or task API and `afterRun` does not execute on failure.
- **MiPi:** the provider extension recognizes its own plan limits. Core's `provider-limits` observer awaits one bound callback that reads usage and commits the provider's record off the Session line.
- **Remove when:** pi-ai exposes structured limit information and a Pi Durable hook on failed responses can write or request a task.

### L10 · Bindings move to MiPi one at a time

- **Kind:** workaround
- **Since:** 0.2.0-alpha.1
- **Upstream:** Pi Durable 1.6.1 reads a document family only by key (`tx.doc(token, key, seed)`): a transaction can't list a family's keys, so core can't find every `app.channel-binding` (`tg:<chat>` for each Telegram chat) to move them in one commit.
- **MiPi:** when MiPi is first made (COD-197), each binding moves to it the first time a door reads it, and is marked `bots`; a marked binding never moves again (`boundConversation`). Same result as moving them all at once, with no read of Pi Durable's tables.
- **MiPi (archive, COD-198):** for the same reason, archiving a bot can't move the bindings that point at it. A binding to an archived bot falls back to MiPi the first time a door reads it, and its key is recorded in `app.bots.released`; restore binds each recorded key back unless it was bound elsewhere since. A door that never read it in between still points at the bot, which is live again.
- **Remove when:** a transaction can list a document family's keys: then `ensureBots` moves every binding in its own commit, archive moves a bot's bindings in its own, and the `bots` marker can go.

### L11 · Archived bots' schedules hold themselves

- **Kind:** workaround
- **Since:** 0.2.0-alpha.2
- **Upstream:** Pi Durable 1.6.1 can pause neither a task nor a conversation's background tasks: a sleeping reminder wakes at its time whatever its conversation's state, and a task's input (its conversation) can't change.
- **MiPi:** every reminder asks core where it runs when it comes due (`routeSchedule`, `src/agent/archive.ts`). An archived bot's repeat skips that time (`skippedArchived`); a one-time reminder parks itself in `app.bots.held` and ends, and restore sends it marked late (`held:<reminderId>`). Nothing polls. A reminder of a chat from before bots (archived when MiPi was made) runs in MiPi instead, with an answer for its transcript going to MiPi's: its task keeps its old conversation, since it can't be moved. The heartbeat counts an archived bot's schedules as a known hold, not overdue.
- **Remove when:** Pi Durable can pause and resume a conversation's tasks: archive pauses them, restore resumes them, and the held list goes.

### L12 · Purpose bots exchange durable follow-ups

- **Kind:** choice
- **Since:** 0.2.0-alpha.3
- **Upstream:** Pi Durable's `22-subagent-background` example submits work to a child conversation and reports back after it settles.
- **Upstream link:** https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#abort-and-subagents
- **MiPi:** purpose bots own their conversations independently of the tool that sends work. Admission stores `bot:<from>:<toolCallId>`, the hop and the proactive expectation together. Answer settlement durably queues a follow-up for the sender, then admits it separately under a stable request id. Bot-only turns share the proactive caps and can return `NO_SEND`. Each new delegation advances the highest hop of the turn, up to three. Returning an answer preserves that hop.
- **Revisit when:** Pi Durable offers durable messaging and answer routing between ownerless conversations.

### L13 · Archived conversations can't be deleted

- **Kind:** watch
- **Since:** 0.2.0-alpha.5
- **Upstream:** Pi Durable 1.6.1 has no way to delete a conversation: no harness or transaction call removes a conversation with its entries, documents and tasks. Archive (COD-198) only hides one and holds its schedules.
- **Upstream link:** https://github.com/earendil-works/pi/issues/11026 https://github.com/earendil-works/pi/pull/12562
- **MiPi:** Settings → Archived (COD-201) opens an archived conversation read-only or restores it, and offers no Delete. No MiPi code depends on this yet.
- **Revisit when:** Pi Durable can delete a conversation and its subtree: then Delete comes to Archived, for archived entries only, confirmed by typing the name, with a backup first.

### L14 · Approval cards read a waiting call from its task's input

- **Kind:** internals
- **Since:** 0.2.0-alpha.1
- **Upstream:** Pi Durable 1.6.1's task graph names a sleeping tool task, its conversation, deadline and signal keys, but not the call it runs. A model-issued call's name and arguments are only in its assistant entry, which the task's input (`ToolTaskInput`, read through `harness.getTask`) points to; `getTask` types the input as plain JSON.
- **MiPi:** `describeApproval` (`src/agent/approvals.ts`, COD-173) casts a pending approval's task input to `ToolTaskInput` and reads the call from the assistant entry it names (or from the input, for a nested call), to show the owner what they are asked. The pending list itself comes from the task graph's public fields. `test/contract.test.ts` checks the input's `kind` on a real harness. These are the arguments as the model sent them, before `prepareArguments` and any `beforeTool` rewrite: no MiPi hook rewrites arguments today, so they are what the gate approves. An extension that starts rewriting them must also have the gate keep the arguments it saw (a memo) and show those.
- **Remove when:** the task graph or a tool slot carries a parked call's name and arguments, or `getTask` returns a typed tool task input.

## Closed

None yet.
