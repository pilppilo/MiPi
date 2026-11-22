---
"mipi": minor
---

COD-169: hardening before M4.

**Fixed**

- An export whose script died no longer keeps the agent closed: an export flag older than 10 minutes (`maintenance_started_at`) is cleared on start or on the next request. A restore never expires, so partial data never opens.
- A deploy backup that can't be taken now stops the deploy. Only a 404 (no agent yet) skips it; a wrong `ADMIN_TOKEN`, a 403, a 5xx or no answer fails with the reason.
- An export refuses a table without a rowid before closing the agent, instead of failing halfway.

**Changed**

- The deploy, rollback and restore workflows use the GitHub Environment of their lane (`staging` or `production`; auto-deploys from `main` use `staging`). Repository secrets stay the fallback.
- New optional secret `ADMIN_TOKEN_PREVIOUS`: while a lane's token is rotated, the backup and the rollback's version check try it after `ADMIN_TOKEN`.
- `pnpm check` builds and dry-runs both lanes (`scripts/dry-run.ts`).
- The owner's time zone is no longer module state: stamps take it explicitly, and scheduled deliveries read it from the agent's session (`app.settings`), written from `MIPI_TIMEZONE` when the agent opens.

**Pi Durable**

- No change (1.6.0). No ledger changes. The contract test now round-trips an export of a real harness's tables and checks none is `WITHOUT ROWID`.

**Migration**

- None needed. To separate the lanes' secrets, create the GitHub Environments `staging` and `production` and add their secrets (see the README); until then the repository secrets are used.
