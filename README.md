# MiPi

An always-on personal agent built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), hosted on Cloudflare Workers and a SQLite-backed Durable Object. The model provider is OpenCode Go.

The build plan and milestones live in Linear (project **MiPi**). This README covers how to work on the code.

> Pi Durable is experimental and breaks between minor versions. Every Pi import goes through `src/agent/pi/`, so an upgrade is fixed in one folder; `test/contract.test.ts` is the test that fails first and points at it.

## Layout

| Path                             | What it is                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/worker/`                    | The Worker: routing and authentication                                                                                                                       |
| `src/agent/agent-do.ts`          | The Durable Object (`MipiAgent`): opens the harness, alarms, WebSockets                                                                                      |
| `src/agent/harness.ts`           | Agent composition: model, tools, prompt sections                                                                                                             |
| `src/agent/profiles.ts`          | Tool profiles (`default`, `empty`, `pidu`) and `toolsFor()`, the only place tools are offered                                                                |
| `src/agent/conversations.ts`     | Per-conversation profile and title, and channel bindings (which conversation a door talks to)                                                                |
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

Each lane has its own Durable Object storage. Every deploy backs up the target's agent first (a 30-day workflow artifact); if the backup can't be taken (a wrong token, a failing Worker), the deploy stops. Only a lane with no agent yet (404) deploys without one.

Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets; `OPENCODE_API_KEY`, `MIPI_SPIKE_TOKEN` and `ADMIN_TOKEN` (24+ random characters) per lane in the GitHub Environments `staging` and `production` (a repository secret of the same name is the fallback). To rotate a lane's `ADMIN_TOKEN`, set the new one and put the old one in `ADMIN_TOKEN_PREVIOUS` for one deploy, then delete it.

- **Startup guard.** Before Pi Durable opens the stored data, the agent checks the stored schema and task versions. Data from a newer build is refused with a 503 that names both versions; nothing runs, nothing is corrupted.
- **Agents:** [`AGENTS.md`](AGENTS.md) holds the rules for every coding agent (Grok Bot, Claude, others); `CLAUDE.md` imports it.
- **Pi Durable ledger:** [`docs/pi-durable-ledger.md`](docs/pi-durable-ledger.md) records every workaround, use of Pi Durable internals, and deliberate difference from Pi Durable, plus the upstream work MiPi is waiting on. Code that belongs to an entry carries a `pi-ledger L<n>` comment; `pnpm check` keeps the two in step, and `pnpm ledger` prints the open entries.
- **Upgrading Pi Durable:** `pnpm upgrade:pi <version>`, fix `src/agent/pi/` until `pnpm check` and `pnpm test` pass, add a changeset. If the release changes stored data so older builds can't read it, put a `> [!WARNING]` line with `**One-way:**` in the changeset. Merge, use it on staging for a day, then deploy production.
- **Rolling back:** Actions → **rollback** (target, release tag). It refuses to cross a one-way release unless forced. After a one-way release, the old build refuses the newer data until you restore a backup taken before the upgrade: Actions → **restore** (the deploy run's ID and the backup's version). `restore` can also roll storage back to a point-in-time bookmark from the agent's status.
- **Admin API** (`/api/admin/*`, Access service token when enabled, otherwise `Authorization: Bearer $ADMIN_TOKEN`): status, paged export, restore. `node scripts/deploy.ts` wraps it. Only the startup guard really protects the data: a rollback from the Cloudflare dashboard or `wrangler rollback` skips the workflow's one-way check, but never the guard.

## Cloudflare Access

Configure staging first in Cloudflare Zero Trust under **Access controls → Applications**. Add a **Self-hosted** application for the staging hostname with an Allow policy for the owner's sign-in identity. Use the hostname application for WebSocket support. Add a separate application for the exact `/api/health` path with a Bypass policy. When the Telegram and relay handlers are deployed, configure path bypass applications for them and verify each handler's own authentication (see the Telegram and PiDu relay sections).

Create a service token under **Access controls → Service credentials → Service Tokens**. On the staging hostname application, add a Service Auth policy selecting that token. Keep the exact-path health application on its Bypass policy. In the matching GitHub Environment, set:

- Variables `ACCESS_TEAM_DOMAIN` (the team's Access domain), `ACCESS_AUD` (the application's AUD), `ACCESS_OWNER_EMAIL` (the exact email in the owner's Access identity), and `ACCESS_SERVICE_CLIENT_ID` (the service token's client ID).
- Secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` for backup, deploy, and rollback requests.

Keep the existing admin token available for deployments before Access is enabled. Set `MIPI_ACCESS_SKIP` only for localhost development. Use a separate application and token for production.

On staging, verify signed-out HTTP and WebSocket requests are denied, then sign in on desktop and phone and exchange a chat message on each. Verify signed-out `/api/health` returns only `{"ok":true}`. Run a backup with the service token and verify the same token is refused on an owner `/api/` route, such as the WebSocket upgrade (`GET /api/sessions/<owner>`) or `GET /api/unlock`. A `200` from `/` with that token is expected: `wrangler.jsonc` runs the Worker first only for `/api/*`, so `/` is a static asset and Access lets the token through without the Worker seeing it. The relay's and Telegram's checks are in their sections below.

Worker preview URLs are not covered by the hostname application, so disable preview URLs for the staging and production Workers, or protect them separately.

## Telegram

Each lane has its own bot. Telegram stays off for a lane until its GitHub Environment has the bot token. Set it up in this order; all of it can be done before the code is deployed.

**1. Telegram: create the bot.** Send `/newbot` to [@BotFather](https://t.me/BotFather), give it a name and a username ending in `bot`. It replies with a token (`123456789:AAH…`): that is `TELEGRAM_BOT_TOKEN`. The username without `@` is `TELEGRAM_BOT_USERNAME`. Send anything to [@userinfobot](https://t.me/userinfobot): the Id it replies with is `TELEGRAM_ALLOWED_USER_IDS` (several ids are separated by commas). Make a webhook secret of 32–64 random letters and digits (a password manager's generator with symbols off): that is `TELEGRAM_WEBHOOK_SECRET`.

**2. GitHub: store the values.** Settings → Environments → `staging` (or `production`):

| Where                                            | Name                        | Value                      |
| ------------------------------------------------ | --------------------------- | -------------------------- |
| Environment secrets → Add environment secret     | `TELEGRAM_BOT_TOKEN`        | the bot's token            |
| Environment secrets → Add environment secret     | `TELEGRAM_WEBHOOK_SECRET`   | the random secret          |
| Environment variables → Add environment variable | `TELEGRAM_ALLOWED_USER_IDS` | your Telegram user id      |
| Environment variables → Add environment variable | `TELEGRAM_BOT_USERNAME`     | the bot's username, no `@` |

The deploy stops with an error naming what is missing if only some are set.

**3. Cloudflare: let Telegram past Access.** Zero Trust → Access controls → Applications → Add an application → Self-hosted. Name it `mipi-staging-telegram`, use the same hostname as the lane's Access application with **Path** `api/telegram` (no leading slash), and add a policy with **Action: Bypass**, **Include: Everyone**, as for `/api/health`. The Worker routes `/api/telegram` before Access authentication and checks the webhook secret itself.

**4. Deploy.** Merging to `main` deploys staging; the deploy's last step, **Register the Telegram webhook**, points the bot at `<worker>/api/telegram` and prints what Telegram reports (`url`, no `last_error_message`). Values added after a deploy take effect on the next one: Actions → deploy → Run workflow → target.

**5. Verify.**

- Open the bot, press **Start**, send `hi`: one reply. `/version` answers the version, `/new` answers "Started a new conversation.".
- `curl -X POST <worker>/api/telegram` answers 401 `{"error":"Unauthorized"}` (the Worker's own check, so the bypass works); a `GET` answers 405.
- A message from another account, or in a group, gets no answer.

## PiDu relay

`POST /api/relay` lets PiDu (or any script with the token) talk to MiPi. Messages go to one conversation, `relay:pidu`, on the `pidu` profile. The relay stays off for a lane until its GitHub Environment has `RELAY_TOKEN`.

**1. GitHub: store the token.** Make 32 or more random letters and digits (a password manager's generator with symbols off). Settings → Environments → `staging` (or `production`) → Environment secrets → Add environment secret: name `RELAY_TOKEN`, value the token. Give the same token to PiDu.

**2. Cloudflare: let the relay past Access.** Zero Trust → Access controls → Applications → Add an application → Self-hosted. Name it `mipi-staging-relay`, use the lane's hostname with **Path** `api/relay` (no leading slash), and add a policy with **Action: Bypass**, **Include: Everyone**. The path covers `api/relay/<key>` too. The Worker checks the token itself on both routes, and every other route keeps its own authentication.

**3. Deploy.** Merging to `main` deploys staging. A token added after a deploy takes effect on the next one: Actions → deploy → Run workflow → target.

**4. Use it.**

```sh
curl -sS -X POST "$URL/api/relay" \
  -H "Authorization: Bearer $RELAY_TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" -d '{"text":"What is on my list today?"}'
```

- The `Idempotency-Key` is 1 to 64 letters, digits, `-` or `_`. Sending the same key again returns the first answer and admits nothing. The same key with a different text gets `409`.
- The request waits up to 25 seconds. `200 {"id","status":"done","answer"}` is the answer. `202 {"id","status":"pending"}` means it isn't ready yet: poll `GET /api/relay/<key>` with the same token. A turn that ends without an answer is `200 {"status":"unanswered","reason"}`.
- Text is at most 16,384 UTF-8 bytes (`413`), and at most 60 messages are admitted per sliding hour (`429` with `Retry-After`). A wrong token is `401`, and maintenance is `503`.

**Rotating the token.** Put the new token in `RELAY_TOKEN` and the old one in `RELAY_TOKEN_PREVIOUS`, then deploy: both work. Give PiDu the new token, delete `RELAY_TOKEN_PREVIOUS`, and deploy again: the old one stops working. Deleting `RELAY_TOKEN` and deploying turns the relay off.

**Verify.**

- The curl above answers `200` with an answer, or `202` and then the answer from `GET /api/relay/<key>`.
- The same curl with the same key returns the same answer.
- A wrong token answers `401 {"error":"Unauthorized"}` on both routes.
- Signed out, an owner route such as `GET /api/unlock` is still refused by Access.

## Versions and changes

Versions are `0.MINOR.PATCH-alpha.N`, then `-beta.N`, then `0.MINOR.PATCH`; MiPi stays in `0.x` while Pi Durable is experimental. Every pull request adds a changeset (`pnpm changeset`) with **Added / Changed / Fixed / Pi Durable / Migration** notes. A release runs `pnpm bump` (`changeset version`, then re-stamps `src/version.ts`), which bumps the pre-release number and writes `CHANGELOG.md`.

## Credits

Seeded from [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare) @ `b68bf92` (MIT, `LICENSES/pi-durable-cloudflare.txt`). Some code is adapted from [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket) @ `2f060f2` (MIT, `LICENSES/pi-pocket.txt`); those files say so in their first line.
