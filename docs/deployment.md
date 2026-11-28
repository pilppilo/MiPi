# Deployment and operations

Where MiPi runs, how it deploys, and how to back up, restore and roll back. The setup guides for each way into MiPi are separate: [Cloudflare Access](cloudflare-access.md), [Telegram](telegram.md) and [the PiDu relay](relay.md).

## Lanes, deploys, and rollback

| Lane       | Worker         | How it deploys                                      |
| ---------- | -------------- | --------------------------------------------------- |
| local      | `pnpm dev`     | your machine                                        |
| staging    | `mipi-staging` | automatically after `check` passes on `main`        |
| production | `mipi`         | by hand: Actions → **deploy** → target `production` |

Each lane has its own Durable Object storage. Every deploy backs up the target's agent first (a 30-day workflow artifact); if the backup can't be taken (a wrong token, a failing Worker), the deploy stops. Only a lane with no agent yet (404) deploys without one.

Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets; `OPENCODE_API_KEY`, `MIPI_SPIKE_TOKEN` and `ADMIN_TOKEN` (24+ random characters) per lane in the GitHub Environments `staging` and `production` (a repository secret of the same name is the fallback), and `MIPI_VAULT_KEY` per lane for the vault ([below](#the-vault-key)). To rotate a lane's `ADMIN_TOKEN`, set the new one and put the old one in `ADMIN_TOKEN_PREVIOUS` for one deploy, then delete it.

- **The vault key.** Each lane has its own `MIPI_VAULT_KEY`; see [The vault key](#the-vault-key).

- **Startup guard.** Before Pi Durable opens the stored data, the agent checks the stored schema and task versions. Data from a newer build is refused with a 503 that names both versions; nothing runs, nothing is corrupted.

- **Rolling back:** Actions → **rollback** (target, release tag). It refuses to cross a one-way release unless forced. After a one-way release, the old build refuses the newer data until you restore a backup taken before the upgrade: Actions → **restore** (the deploy run's ID and the backup's version). `restore` can also roll storage back to a point-in-time bookmark from the agent's status.
- **Admin API** (`/api/admin/*`, Access service token when enabled, otherwise `Authorization: Bearer $ADMIN_TOKEN`): status, paged export, restore. `node scripts/deploy.ts` wraps it. Only the startup guard really protects the data: a rollback from the Cloudflare dashboard or `wrangler rollback` skips the workflow's one-way check, but never the guard.

## The vault key

The vault (COD-255, [plan](vault-plan.md)) keeps bot secrets encrypted in the agent's own storage. Each lane's
`MIPI_VAULT_KEY` wraps that lane's data key, which encrypts the secrets. The key is a Worker secret, never in the
database, so a backup holds no usable secret without it. Staging and production must have **different** keys: a
production backup restored to staging can't open production's bot secrets, which is intended.

**Set it up** (once per lane):

1. Make a key: `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`. It is 32 random bytes, base64.
2. GitHub → the MiPi repo → **Settings** → **Environments** → **staging** → **Add environment secret**, name
   `MIPI_VAULT_KEY`, paste the key.
3. The same in **production**, with a different key.
4. Staging deploys on the next merge to `main`; production when you run the deploy workflow.

**Rotate it:** set the new key as `MIPI_VAULT_KEY` and the old one as `MIPI_VAULT_KEY_PREVIOUS`, deploy, then delete
`MIPI_VAULT_KEY_PREVIOUS`. On open the agent rewraps the data key with the new key; no secret is re-encrypted.

**How it fails:**

- The deploy always writes both names, an unset one as `off` (`--secrets-file` only adds, so a deleted secret would
  otherwise stay live in Cloudflare). `off` is never a key.
- Before the backup and `wrangler deploy`, `node scripts/deploy.ts vault-check` reads the running agent's admin status
  and refuses the deploy when the lane has bot secrets and this deploy's `MIPI_VAULT_KEY` is missing, isn't a 32-byte
  base64 key, or matches neither the stored key's fingerprint nor `MIPI_VAULT_KEY_PREVIOUS`. A lane with no bot secrets
  deploys with or without a key.
- If the running agent still has no key or the wrong one (set by hand in Cloudflare, say), the vault alone is locked:
  the admin status shows `vault.state: "locked"` with the reason, every secret call refuses with it, and chat, Telegram
  and reminders keep working. With no bot secrets stored, a new key simply replaces the data key.

The admin status's `vault` holds the lock state and reason, the stored key's fingerprint (a hash, never the key) and
row counts per tier. It never holds a key, a value or a secret's name.

## Spend cap, pause and usage

MiPi estimates what it spends from each conversation's recorded usage, at pi-ai's list prices, whatever the provider bills. Telegram `/usage`, a line in the web header, and the admin status (`usage`) show today's estimate beside each provider's own figures where MiPi can read them.

| Setting                | Where                                              | What it does                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIPI_DAILY_SPEND_CAP` | `wrangler.jsonc` (`1`), or an Environment variable | Dollars per Chicago day for work nobody asked for at that moment: reminders, the memory pass, model-written titles. At the cap they wait until midnight, a one-time Telegram reminder goes out as plain text, and one notice says so. Your own messages still go through. `off`: no cap. |
| `MIPI_PAUSED`          | `wrangler.jsonc` (`0`), or an Environment variable | `1` holds every model call. The web and Telegram answer "MiPi is paused", the relay answers 503 `Paused`, and reminders are held as at the cap. Anything other than on or off pauses.                                                                                                    |
| `OPENCODE_USAGE_KEY`   | Environment secret, optional                       | An OpenCode key with usage permission, when `OPENCODE_API_KEY` has none. Without either, the readout shows MiPi's estimate only.                                                                                                                                                         |
| `OPENCODE_ORG_ID`      | Environment variable, optional                     | The OpenCode workspace id, if Go's usage endpoint asks for one.                                                                                                                                                                                                                          |

To pause a lane: GitHub → **Settings → Environments →** the lane **→ Add variable** `MIPI_PAUSED` = `1`, then Actions → **deploy** for that lane. To resume, set it to `0` (or delete it) and deploy again. Setting a variable in the Cloudflare dashboard works too, but the next deploy replaces it. The run cap (`MIPI_DAILY_RUN_CAP`) still applies beside the spend cap. To turn the spend cap off for a lane, set its variable `MIPI_DAILY_SPEND_CAP` to `off`.

### OpenCode Go usage endpoint

MiPi requests `GET https://opencode.ai/zen/go/v1/usage` with a five-second timeout and `Accept: application/json`. The bearer token comes from `OPENCODE_USAGE_KEY` when set and otherwise from `OPENCODE_API_KEY`. If `OPENCODE_ORG_ID` is set, MiPi sends it as `x-opencode-org-id`. Empty values and `off` count as unset. The implementation is in [the Go usage reader](../src/extensions/optional/opencode-go/usage.ts).

The response has a `usage` object with `rolling`, `weekly`, and `monthly` windows. Each window has `status` (`ok` or `rate-limited`), numeric `percent`, and a date string in `resetsAt`. A 401 means the key lacks usage permission. A 403 means the key has no Go plan. Those responses, other HTTP failures, timeouts, and invalid responses make the provider readout unavailable. MiPi still shows its own spend estimate and chat continues. Admin status reads cached provider figures without making a provider call.

Run [`spike-probe.yml`](../.github/workflows/spike-probe.yml) manually to check the live endpoint URLs and response shape from outside the Worker.

## Diagnostic events

The agent keeps its last 1,000 diagnostic events (hops, holds and faults, never message text) in its own SQLite, outside backups. Debug events have their own 200 of those rows, so frequent ones can't push out warnings and errors. Read them with the admin credentials:

```
GET /api/admin/events?after=<id>&source=<source>&level=warn,error&limit=<1-500>
```

Every parameter is optional; `limit` defaults to 100. The answer is `{ events, health }`, oldest event first. It works whatever the agent's state, refused or in maintenance included, and writes nothing. A request the Worker refuses before it reaches the agent (a wrong webhook secret, relay token or admin token, a cross-site WebSocket) is never stored. It goes to Cloudflare's logs as a `"source":"worker"` event.

## Scheduled checks

- [`heartbeat.yml`](../.github/workflows/heartbeat.yml) checks both deployed lanes daily at 14:17 UTC. It flags recent lost alarms, unhealthy agent state, and overdue schedules without a hold. When a check fails, the report also lists the agent's last 10 warnings and errors from the diagnostic log. If those can't be read, the report says so in one line and the check still fails for its own reason.
- [`evals.yml`](../.github/workflows/evals.yml) checks proactive replies against OpenCode Go on Mondays at 15:17 UTC using staging credentials and mocked fetch results.
- [`canary.yml`](../.github/workflows/canary.yml) exercises the latest Pi Durable release on Mondays at 16:17 UTC. It runs the upgrade, checks, and tests in the runner. If a candidate fails, it creates or updates one open GitHub issue for that version. Use **Run workflow** to check a specific version or leave the input blank to check npm's latest. A version that isn't published on npm stops the run before the upgrade and opens no issue.

## Upgrading Pi Durable

A canary failure issue or an `@earendil-works/*` Dependabot PR can prompt an upgrade. Close the Dependabot signal PR and use the upgrade script so the pins, lockfile, workspace release-age exceptions, and version stamp move together.

1. Create a dedicated branch from `main` and run `pnpm upgrade:pi <version>`. Read the upstream changes and open ledger entries it prints.
2. Fix changed imports or APIs through `src/agent/pi/`. Start with [the Pi contract test](../test/contract.test.ts), which exercises the exports MiPi relies on. Run `pnpm check` and `pnpm test`.
3. Update [the Pi Durable ledger](pi-durable-ledger.md). Close entries fixed upstream and remove their workaround code. Add any new entries and mark their code with `pi-ledger L<n>` comments.
4. Run `pnpm changeset` and add **Pi Durable** and **Migration** notes. Name any ledger changes. If older builds cannot open data written by the upgrade, put `**One-way:**` in a `> [!WARNING]` alert. If the release changes stored data, run `pnpm fixture:capture` after `pnpm bump` and commit the fixture with the release.
5. Open a PR. Once the owner merges it, staging deploys automatically. Use staging for a day before the owner runs the manual **deploy** workflow for production. The workflow backs up the lane first.

If the upgrade regresses, follow the [rollback and restore order](#lanes-deploys-and-rollback). A rollback across a one-way release needs a backup from before the upgrade.
