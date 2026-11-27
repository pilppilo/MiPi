# Development

How to work on the MiPi code. Running and deploying MiPi is in [Deployment and operations](deployment.md). The rules every coding agent follows are in [`AGENTS.md`](../AGENTS.md).

> Pi Durable is experimental and breaks between minor versions. Every Pi import goes through `src/agent/pi/`, so an upgrade is fixed in one folder; `test/contract.test.ts` is the test that fails first and points at it.

## Layout

| Path                             | What it is                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/worker/`                    | The Worker: routing and authentication                                                                                                                        |
| `src/agent/agent-do.ts`          | The Durable Object (`MipiAgent`): opens the harness, alarms, WebSockets                                                                                       |
| `src/agent/harness.ts`           | Core composition: the preamble, the extension selection, models and settings (`composeAgent`)                                                                 |
| `src/agent/composition.ts`       | The composition root: core plus the built-in and optional extensions and the profile table (`composeMipi`)                                                    |
| `src/agent/extensions.ts`        | The extension contract: a Pi Durable extension plus MiPi registrations; replacement, order, tasks                                                             |
| `src/agent/profiles.ts`          | Tool profiles (`default`, `empty`, `pidu`) as a mechanism: `Profiles.toolsFor()`, the only place tools are offered                                            |
| `src/extensions/`                | Built-in extensions (`builtin/<name>/`, `builtins.ts`), optional ones (`optional/<name>/`, `optional.ts`) and which tools each profile offers (`profiles.ts`) |
| `src/agent/providers.ts`         | What a provider's extension registers: its usage reader and its model list (`model-list.ts`)                                                                  |
| `src/agent/conversations.ts`     | Per-conversation profile and title, and channel bindings (which conversation a door talks to)                                                                 |
| `src/agent/connectors.ts`        | What doors and extensions register with core: origin (`origin.ts`), delivery (`delivery.ts`) and the inputs waiting for an answer                             |
| `src/agent/answers.ts`           | Core's one answer settlement: settled inputs of every door and every reminder, judged once (`proactive.ts`) and delivered                                     |
| `src/agent/gates.ts`             | The run cap, the spend cap and the pause, read-only for doors and extensions                                                                                  |
| `src/agent/visibility.ts`        | Which conversations are the owner's, for history search and the memory pass                                                                                   |
| `src/doors/`                     | The doors (`telegram/`, `relay/`, `web/`): their registrations with core and their runtimes                                                                   |
| `src/agent/pi/`                  | The only code that imports `@earendil-works/*` (lint-enforced): `durable.ts` for the server, `shared.ts` for the browser, `storage.ts` for the upgrade guard  |
| `src/lib/`                       | Small helpers with no Pi imports                                                                                                                              |
| `src/protocol.ts`, `src/client/` | WebSocket protocol and the React web client                                                                                                                   |

## Core, doors and extensions

MiPi draws its boundary the way Pi does (COD-208): a small core, and everything else plugs into it through named connectors. `pnpm check` enforces the import rules (`.oxlintrc.json` and `scripts/check-boundaries.ts`).

### Tiers

| Tier                | Where                                            | What it is                                                                                                              | May import                                                          |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Core                | `src/agent/`                                     | The agent: caching, context, compaction, time, identity, the connectors. Names no door, no extension, no provider.      | `src/agent/`, `src/lib/`, `src/protocol.ts`. Pi only via `pi/`.     |
| Composition root    | `src/agent/agent-do.ts`, `composition.ts`        | Wires core to the lists of doors and extensions, and to the Worker's bindings.                                          | Everything above, the door and extension lists, the doors' runtimes |
| Doors               | `src/doors/<name>/`, listed in `index.ts`        | Ways into the one agent (web, Telegram, relay). Register with core; their runtimes are started by the composition root. | Core and `src/lib/`. Never an extension or another door's documents |
| Built-in extensions | `src/extensions/builtin/<name>/`, `builtins.ts`  | Features shipped on by default (memory, reminders, history search, web fetch).                                          | Core and `src/lib/`. Never a door or another extension              |
| Optional extensions | `src/extensions/optional/<name>/`, `optional.ts` | Added at build time, after the built-ins (today OpenCode Go's provider pieces).                                         | Same as built-in                                                    |

The lists (`builtins.ts`, `optional.ts`, `profiles.ts`) sit above the extensions, not in them: an extension never imports a list. A provider's URLs, key names and response shapes live in its optional extension; Pi's own wiring of the provider (the catalog, the key from the bindings) stays in the model seam, `src/agent/pi/models.ts`.

### The extension contract

An extension (`MipiExtension`, `src/agent/extensions.ts`) is a Pi Durable extension (`pi`: tools, sections, hooks, wraps, tasks) plus MiPi's registrations: tier, `replaceable`, prompt slot, untrusted tools, origins, wake sources and providers. There is no second registry; tools and sections reach the model only through Pi Durable.

- **Installed vs selected.** Every extension is installed, even a replaced one, so the tasks and documents it stored keep resolving. A conversation's selection is one default list (core's own first, then by slot and name) that it edits only with `{ remove }`, so the prompt prefix never depends on load order.
- **No Pi part.** An extension with only agent-wide pieces (a provider's) has no `pi`. It is never in a selection and can't be switched off per conversation.
- **Replacement.** Pi's rule: a `replaceable` extension that shares a tool name with a non-replaceable one is dropped whole from the selection. Its wake sources don't start and its providers aren't registered. Two keepers on one tool name, a name used twice, or one provider piece registered twice refuse to compose.
- **Startup report.** Each replacement is logged when the agent opens; the admin status lists the extensions in use and the replacements.

### Connectors

| Connector                         | File                            | Who registers                                                                           | Who uses                                                                                                              |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Wake sources                      | `wake-sources.ts`               | Extensions (`wakeSources`: the memory pass), the Telegram door via the composition root | The alarm (`alarm.ts`), the commit observer, shutdown                                                                 |
| Side calls                        | `side-calls.ts`                 | Core (one way to call the conversation's model)                                         | Titles (`titles.ts`), the memory pass                                                                                 |
| Untrusted content                 | `untrusted.ts`                  | Extensions (`untrustedTools`: web fetch)                                                | `remember` and the memory pass (a run that read a page writes no memory)                                              |
| Origin                            | `origin.ts`                     | Doors (request-id prefixes), extensions (`origins`: reminders)                          | Memory (a lesson's source), answer settlement, the doors                                                              |
| Delivery                          | `delivery.ts`                   | Doors (an adapter per destination kind)                                                 | Reminders, proactive runs, answer settlement                                                                          |
| Pending inputs, answer settlement | `connectors.ts`, `answers.ts`   | Doors (the inputs they expect an answer for)                                            | Core's one settlement loop, which delivers each answer                                                                |
| Gates                             | `gates.ts`                      | Core (run cap, spend cap, pause)                                                        | Doors (Telegram, relay), reminders, the memory pass, the usage readout (`usage.ts`), the composition root — read-only |
| Approvals                         | `approvals.ts`                  | Tools (`approval` on a registration: core's gate, or the tool asks itself)              | The composition root: the pending list off the task graph, the owner's answer, notices                                |
| Conversation visibility           | `visibility.ts`                 | Core                                                                                    | History search, the memory pass                                                                                       |
| Providers                         | `providers.ts`, `model-list.ts` | Optional extensions (`providers`: OpenCode Go)                                          | The composition root: the model picker and `/model`, the usage readout                                                |

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
