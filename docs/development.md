# Development

How to work on the MiPi code. Running and deploying MiPi is in [Deployment and operations](deployment.md). The rules every coding agent follows are in [`AGENTS.md`](../AGENTS.md).

> Pi Durable is experimental and breaks between minor versions. Every Pi import goes through `src/agent/pi/`, so an upgrade is fixed in one folder; `test/contract.test.ts` is the test that fails first and points at it.

## Layout

| Path                             | What it is                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/worker/`                    | The Worker: routing and authentication                                                                                                                       |
| `src/agent/agent-do.ts`          | The Durable Object (`MipiAgent`): opens the harness, alarms, WebSockets                                                                                      |
| `src/agent/harness.ts`           | Core composition: the preamble, the extension selection, models and settings (`composeAgent`)                                                                |
| `src/agent/composition.ts`       | The composition root: core plus the built-in extensions and the profile table (`composeMipi`)                                                                |
| `src/agent/extensions.ts`        | The extension contract: a Pi Durable extension plus MiPi registrations; replacement, order, tasks                                                            |
| `src/agent/profiles.ts`          | Tool profiles (`default`, `empty`, `pidu`) as a mechanism: `Profiles.toolsFor()`, the only place tools are offered                                           |
| `src/extensions/`                | Built-in extensions (`builtin/<name>/`, listed in `builtins.ts`) and which tools each profile offers (`profiles.ts`)                                         |
| `src/agent/conversations.ts`     | Per-conversation profile and title, and channel bindings (which conversation a door talks to)                                                                |
| `src/agent/pi/`                  | The only code that imports `@earendil-works/*` (lint-enforced): `durable.ts` for the server, `shared.ts` for the browser, `storage.ts` for the upgrade guard |
| `src/tools/`                     | The reminders' and history search's code, until COD-210 and COD-211 move it into its extensions                                                              |
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

## Working with Pi Durable

- **Agents:** [`AGENTS.md`](../AGENTS.md) holds the rules for every coding agent (Grok Bot, Claude, others); `CLAUDE.md` imports it.
- **Pi Durable ledger:** [`pi-durable-ledger.md`](pi-durable-ledger.md) records every workaround, use of Pi Durable internals, and deliberate difference from Pi Durable, plus the upstream work MiPi is waiting on. Code that belongs to an entry carries a `pi-ledger L<n>` comment; `pnpm check` keeps the two in step, and `pnpm ledger` prints the open entries.
- **Upgrading Pi Durable:** `pnpm upgrade:pi <version>`, fix `src/agent/pi/` until `pnpm check` and `pnpm test` pass, add a changeset. If the release changes stored data so older builds can't read it, put a `> [!WARNING]` line with `**One-way:**` in the changeset. Merge, use it on staging for a day, then deploy production.

## Versions and changes

Versions are `0.MINOR.PATCH-alpha.N`, then `-beta.N`, then `0.MINOR.PATCH`; MiPi stays in `0.x` while Pi Durable is experimental. Every pull request adds a changeset (`pnpm changeset`) with **Added / Changed / Fixed / Pi Durable / Migration** notes. A release runs `pnpm bump` (`changeset version`, then re-stamps `src/version.ts`), which bumps the pre-release number and writes `CHANGELOG.md`.
