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

## Versions and changes

Versions are `0.MINOR.PATCH-alpha.N`, then `-beta.N`, then `0.MINOR.PATCH`; MiPi stays in `0.x` while Pi Durable is experimental. Every pull request adds a changeset (`pnpm changeset`) with **Added / Changed / Fixed / Pi Durable / Migration** notes. A release runs `pnpm version` (`changeset version`), which bumps the pre-release number and writes `CHANGELOG.md`.

## Credits

Seeded from [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare) @ `b68bf92` (MIT, `LICENSES/pi-durable-cloudflare.txt`). Some code is adapted from [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket) @ `2f060f2` (MIT, `LICENSES/pi-pocket.txt`); those files say so in their first line.
