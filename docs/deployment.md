# Deployment and operations

Where MiPi runs, how it deploys, and how to back up, restore and roll back. The setup guides for each way into MiPi are separate: [Cloudflare Access](cloudflare-access.md), [Telegram](telegram.md) and [the PiDu relay](relay.md).

## Lanes, deploys, and rollback

| Lane       | Worker         | How it deploys                                      |
| ---------- | -------------- | --------------------------------------------------- |
| local      | `pnpm dev`     | your machine                                        |
| staging    | `mipi-staging` | automatically after `check` passes on `main`        |
| production | `mipi`         | by hand: Actions → **deploy** → target `production` |

Each lane has its own Durable Object storage. Every deploy backs up the target's agent first (a 30-day workflow artifact); if the backup can't be taken (a wrong token, a failing Worker), the deploy stops. Only a lane with no agent yet (404) deploys without one.

Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets; `OPENCODE_API_KEY`, `MIPI_SPIKE_TOKEN` and `ADMIN_TOKEN` (24+ random characters) per lane in the GitHub Environments `staging` and `production` (a repository secret of the same name is the fallback). To rotate a lane's `ADMIN_TOKEN`, set the new one and put the old one in `ADMIN_TOKEN_PREVIOUS` for one deploy, then delete it.

- **Startup guard.** Before Pi Durable opens the stored data, the agent checks the stored schema and task versions. Data from a newer build is refused with a 503 that names both versions; nothing runs, nothing is corrupted.

- **Rolling back:** Actions → **rollback** (target, release tag). It refuses to cross a one-way release unless forced. After a one-way release, the old build refuses the newer data until you restore a backup taken before the upgrade: Actions → **restore** (the deploy run's ID and the backup's version). `restore` can also roll storage back to a point-in-time bookmark from the agent's status.
- **Admin API** (`/api/admin/*`, Access service token when enabled, otherwise `Authorization: Bearer $ADMIN_TOKEN`): status, paged export, restore. `node scripts/deploy.ts` wraps it. Only the startup guard really protects the data: a rollback from the Cloudflare dashboard or `wrangler rollback` skips the workflow's one-way check, but never the guard.

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

## Scheduled checks

- [`heartbeat.yml`](../.github/workflows/heartbeat.yml) checks both deployed lanes daily at 14:17 UTC. It flags recent lost alarms, unhealthy agent state, and overdue schedules without a hold.
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
