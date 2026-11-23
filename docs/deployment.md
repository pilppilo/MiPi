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
