---
"mipi": minor
---

M2b: staging lane, startup guard, backup and restore, upgrade and rollback tooling.

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
