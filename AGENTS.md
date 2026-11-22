# AGENTS.md

Instructions for any coding agent working in this repo (Grok Bot, Claude, Codex, Cursor and others). Claude Code reads it through `CLAUDE.md`. This file is the single source of truth: change the rules here, never in a tool-specific copy.

## What MiPi is

One owner's always-on personal agent. It runs on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) (experimental, breaks between versions) inside a SQLite Durable Object on Cloudflare Workers (free plan), with OpenCode Go as the model provider.

Before changing behaviour, read `README.md` and `docs/pi-durable-ledger.md`, plus the Linear issue you're working on (workspace nuttydev, team Code, issue keys COD-…, project MiPi).

## Who does what

- **PiDu** is the owner's Grok Bot assistant. When the owner asks, it plans, writes and refines Linear issues, coordinates other agents, reviews PRs, and watches upstream (Pi Durable, pi-ai, Pi Pocket) against the ledger. It confirms a plan with the owner before any code. Code is written by Cursor Cloud agents it launches only after the owner says start, not by PiDu directly.
- A coding agent reading this file is not PiDu, even if it runs on a Grok model. Follow the coding-agent rules: take a Linear issue, implement it on a branch, and open a PR.
- **Claude** and other coding agents take a Linear issue, implement it on a branch, and open a PR.
- **The owner (jerome)** decides on merges and production deploys. No agent merges or deploys production unless the owner says so in that conversation.

Coordinate through Linear and GitHub, not chat memory. Set the issue to In Progress when you start, link the PR, and comment with results; another agent may pick the issue up next. Leave the work as one issue per branch, and never take over a branch another agent has open.

## Principles

- **One agent, many doors.** Web, Telegram, relay and future channels are interchangeable ways into the same agent. Caching, context, compaction, time and identity live in `src/agent/`, never in one door.
- **MiPi is its own agent.** The original Pi Durable sample was a one-time seed; don't preserve its behaviour for its own sake. Pi Durable is the only dependency expected to break.
- **No default tools.** Tools come only from explicit profiles (`default`, `empty`, `pidu`), and each is opt-in. Never add Pi Durable's coding tools (read, write, edit, bash), codemode or tool search.
- **Cache-stable prompts.** System sections stay static so the prompt prefix stays cacheable. Anything that changes over time goes on the message itself (`stampInput`).
- **Fail clearly.** Refusing with a clear message is better than half-running. Back up before anything destructive, and test behaviour, not just types.

## Environment

Agents work in their own Linux VMs with GitHub and Linear connected; the owner may also work locally on Windows or Linux. Everything must work on all three.

- Node 22 (`.node-version`) and pnpm 11 via Corepack (`corepack enable`). Run `pnpm install` once per checkout.
- Scripts are Node (`node scripts/*.ts`), not shell, so they run on Windows too. Don't add bash-only steps to `package.json` scripts; use Node or `shx`.
- Files use LF line endings (`.gitattributes`). On Windows, keep `core.autocrlf` off or rely on `.gitattributes`; the format check fails on CRLF.
- Local secrets go in `.dev.vars` (copy `.dev.vars.example`); never commit it. Deployed secrets live in GitHub: per lane in the Environments `staging` and `production` (`OPENCODE_API_KEY`, `MIPI_SPIKE_TOKEN`, `ADMIN_TOKEN`, and `ADMIN_TOKEN_PREVIOUS` only while rotating), with repository secrets as the fallback and for the Cloudflare credentials.

## Commands

| Command                     | What it does                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                | Format, lint, version stamp, ledger, types (app, client, scripts), build, dry-run deploy. Must pass before a PR. |
| `pnpm test`                 | Vitest in workerd. Pi Durable runs for real on Durable Object SQLite; the model is faked.                        |
| `pnpm format`               | Fix formatting (oxfmt).                                                                                          |
| `pnpm dev`                  | Local dev server (needs `.dev.vars`).                                                                            |
| `pnpm changeset`            | Every PR. Use `--empty` when nothing that runs changes.                                                          |
| `pnpm ledger`               | Open Pi Durable ledger entries and where they live in the code.                                                  |
| `pnpm upgrade:pi <version>` | The only way to move Pi Durable to another version.                                                              |

## Layout

- `src/agent/pi/`: the **only** code that imports `@earendil-works/*` (lint-enforced). New Pi imports go here as named re-exports, and `test/contract.test.ts` calls each one.
- `src/agent/`: the agent: Durable Object (`agent-do.ts`), harness, stamps, startup guard, export and restore.
- `src/worker/`: HTTP routes, auth (spike lock), admin API.
- `src/tools/`: tools, registered only through profiles.
- `src/lib/`: small helpers with no Pi imports.
- `src/protocol.ts`: WebSocket command/event protocol and wire validation.
- `src/client/`: the web door.
- `scripts/`: deploy, release notes, upgrade, ledger.
- `docs/pi-durable-ledger.md`: every Pi Durable workaround, use of its internals, deliberate difference, and upstream item MiPi waits on.

## Code style

- Read files in full before wide-ranging edits, before changing files you haven't inspected, and when auditing. Don't rely on search snippets alone.
- Before designing a fix, check how sibling modules (other doors, tools, or scripts) handle the same concern and follow that pattern; if you deviate, explain why.
- Check `node_modules` for external API types (especially `@earendil-works/*`) instead of guessing, then use Pi types through `src/agent/pi/` (never import `@earendil-works/*` directly outside `src/agent/pi/` and `test/`).
- Top-level imports only in `src/agent/`, `src/worker/`, `src/tools/`, and `scripts/`: no `await import()`, `import("pkg").Type`, or dynamic type imports (in `src/client/`, dynamic imports are allowed only for code-splitting, with a comment).
- No `any` unless unavoidable.
- Erasable TypeScript only (`erasableSyntaxOnly`; scripts run with Node's type stripping): no parameter properties, `enum`, `namespace`, or `import =`. Use explicit fields assigned in the constructor.
- Use tagged unions (`kind` field + `switch`) instead of `"field" in x`, and end each new `switch` with an exhaustiveness check (`const _: never = value.kind`) so a new variant fails to compile; existing switches get it when next touched. Reserve `in` for `unknown` values at trust boundaries, feature detection, or persisted/wire formats that a version bump would have to change (note it in a comment).
- Validate only at trust boundaries (`src/worker/`, `src/protocol.ts`, tool schemas, external responses, and stored data read back: socket attachments, `app_meta`, documents an older build wrote). Don't add redundant `typeof`/`instanceof`/`Array.isArray` checks on values TypeScript already guarantees.
- Never remove or downgrade code to silence type errors from an outdated dependency: upgrade the dependency instead, in its own PR. For `@earendil-works/*` that is a separate `pnpm upgrade:pi` PR with its ledger review, never part of a feature PR.
- Don't remove code that looks intentional (especially `pi-ledger` workarounds, startup guards, or Durable Object safety wrappers); leave it in place and flag it in the PR description and Linear issue for the owner to decide.
- Don't add ad-hoc backward-compatibility shims unless asked. During `alpha`, handle breaking persisted-data changes through the startup guard and a `**One-way:**` changeset warning (from `0.1.0-beta.1` onward, data must survive upgrades and pass fixture-DB tests).

## Pi Durable rules

- Pin every `@earendil-works/*` package to the same exact version. Upgrade only with `pnpm upgrade:pi`.
- Anything that works around Pi Durable or pi-ai, reads its internals, or deliberately differs from it gets a ledger entry plus `pi-ledger L<n>` comments on its code. Add an **Upstream link** as soon as one exists. `pnpm check` keeps the comments and the ledger in step.
- On an upgrade, close the entries upstream fixed and delete their code. Name ledger changes in the changeset's **Pi Durable** note.

## Versions and releases

- Versions are SemVer pre-releases only: `0.x.y-alpha.N`, then `-beta.N`. Never use "v1/v2" naming. Don't hand-edit version numbers; `pnpm bump` sets them and re-stamps `src/version.ts`.
- Every PR adds a changeset with **Added / Changed / Fixed / Pi Durable / Migration** notes. A release that older builds can't roll back past gets a `> [!WARNING]` line with `**One-way:**`.
- Merging to `main` deploys staging automatically. Production deploys only through the manual deploy workflow, when the owner asks. Every deploy backs up first.

## Git

- Branch from `main`, named after the Linear issue (`cod-150-…`). Never push to `main`.
- Commit messages say what changed and why. Mention the Linear issue (COD-123) in the PR title or body.
- Don't commit `.dev.vars`, `.wrangler/`, `dist/` or anything with a secret in it.

## Durable Object gotchas

- A throw inside `blockConcurrencyWhile` resets the object. Use `#exclusive` in `agent-do.ts`.
- DO SQL forbids `total_changes()` and `PRAGMA schema_version`, and bookmarks advance on every call. Export uses a fingerprint instead.
- A Worker has no `process.env`: read bindings (ledger L1).
- Build for an environment with `CLOUDFLARE_ENV=staging`; the Vite plugin ignores `--env`.
