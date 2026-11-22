# MiPi

An always-on personal agent built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), hosted on Cloudflare Workers and a SQLite-backed Durable Object. The model provider is OpenCode Go.

The build plan and milestones live in Linear (project **MiPi**). This README covers how to work on the code.

> Pi Durable is experimental and breaks between minor versions. Every Pi import goes through `src/agent/pi/`, so an upgrade is fixed in one folder; `test/contract.test.ts` is the test that fails first and points at it.

## Layout

| Path                             | What it is                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/worker/`                    | The Worker: routing (and, from later milestones, auth)                                                                                                       |
| `src/agent/agent-do.ts`          | The Durable Object (`MipiAgent`): opens the harness, alarms, WebSockets                                                                                      |
| `src/agent/harness.ts`           | Agent composition: model, tools, prompt sections                                                                                                             |
| `src/agent/pi/`                  | The only code that imports `@earendil-works/*` (lint-enforced): `durable.ts` for the server, `shared.ts` for the browser, `storage.ts` for the upgrade guard |
| `src/tools/`                     | Tools (`schedule`, `search_history`)                                                                                                                         |
| `src/lib/`                       | Small helpers with no Pi imports                                                                                                                             |
| `src/protocol.ts`, `src/client/` | WebSocket protocol and the React web client                                                                                                                  |

## Commands

You need Node.js 22.19 or newer and pnpm 11 (`corepack enable` picks the version from `package.json`).

```sh
pnpm install
pnpm check   # format, lint (incl. the Pi import rule), Worker types, tsc, build, deploy dry run
pnpm test    # Pi Durable runs for real on Durable Object SQLite; the model is faked
```

`pnpm dev` runs the app locally; it needs `OPENCODE_API_KEY` in `.dev.vars` (copy `.dev.vars.example`). Deploys run from GitHub Actions with the repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `OPENCODE_API_KEY` (from M1).

## Lanes, deploys, and rollback

| Lane       | Worker         | How it deploys                                      |
| ---------- | -------------- | --------------------------------------------------- |
| local      | `pnpm dev`     | your machine                                        |
| staging    | `mipi-staging` | automatically after `check` passes on `main`        |
| production | `mipi`         | by hand: Actions → **deploy** → target `production` |

Each lane has its own Durable Object storage. Every deploy backs up the target's agent first (a 30-day workflow artifact). The workflows need the repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OPENCODE_API_KEY`, `MIPI_SPIKE_TOKEN`, and `ADMIN_TOKEN` (24+ random characters).

- **Startup guard.** Before Pi Durable opens the stored data, the agent checks the stored schema and task versions. Data from a newer build is refused with a 503 that names both versions; nothing runs, nothing is corrupted.
- **Agents:** [`AGENTS.md`](AGENTS.md) holds the rules for every coding agent (Grok Bot, Claude, others); `CLAUDE.md` imports it.
- **Pi Durable ledger:** [`docs/pi-durable-ledger.md`](docs/pi-durable-ledger.md) records every workaround, use of Pi Durable internals, and deliberate difference from Pi Durable, plus the upstream work MiPi is waiting on. Code that belongs to an entry carries a `pi-ledger L<n>` comment; `pnpm check` keeps the two in step, and `pnpm ledger` prints the open entries.
- **Upgrading Pi Durable:** `pnpm upgrade:pi <version>`, fix `src/agent/pi/` until `pnpm check` and `pnpm test` pass, add a changeset. If the release changes stored data so older builds can't read it, put a `> [!WARNING]` line with `**One-way:**` in the changeset. Merge, use it on staging for a day, then deploy production.
- **Rolling back:** Actions → **rollback** (target, release tag). It refuses to cross a one-way release unless forced. After a one-way release, the old build refuses the newer data until you restore a backup taken before the upgrade: Actions → **restore** (the deploy run's ID and the backup's version). `restore` can also roll storage back to a point-in-time bookmark from the agent's status.
- **Admin API** (`/api/admin/*`, `Authorization: Bearer $ADMIN_TOKEN`): status, paged export, restore. `node scripts/deploy.ts` wraps it. Only the startup guard really protects the data: a rollback from the Cloudflare dashboard or `wrangler rollback` skips the workflow's one-way check, but never the guard.

## Versions and changes

Versions are `0.MINOR.PATCH-alpha.N`, then `-beta.N`, then `0.MINOR.PATCH`; MiPi stays in `0.x` while Pi Durable is experimental. Every pull request adds a changeset (`pnpm changeset`) with **Added / Changed / Fixed / Pi Durable / Migration** notes. A release runs `pnpm bump` (`changeset version`, then re-stamps `src/version.ts`), which bumps the pre-release number and writes `CHANGELOG.md`.

## Credits

Seeded from [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare) @ `b68bf92` (MIT, `LICENSES/pi-durable-cloudflare.txt`). Some code is adapted from [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket) @ `2f060f2` (MIT, `LICENSES/pi-pocket.txt`); those files say so in their first line.
