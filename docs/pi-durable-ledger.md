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

## Closed

None yet.
