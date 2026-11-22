# mipi

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
