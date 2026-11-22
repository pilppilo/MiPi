---
"mipi": minor
---

M2a: Pi Durable sits behind one folder, enforced by lint and a contract test.

**Added**

- Lint (`oxlint`, in `pnpm check`): nothing outside `src/agent/pi/` and `test/` may import `@earendil-works/*`, subpaths included (`@earendil-works/chord/context` is the import that touched 25 files in Pi Pocket).
- `test/contract.test.ts`: every name the seam exports, used once against the real packages on Durable Object SQLite (a full tool-using turn, docs, doc families, schemas, chord deltas).
- `src/agent/pi/storage.ts`: reads the stored Pi Durable schema version and the highest stored version of each task kind, and compares them with what this build supports (for M2b's startup guard).

**Changed**

- `src/agent/pi/` exports only the names MiPi uses instead of whole packages. The browser code (`src/client/`, `src/protocol.ts`) now goes through `src/agent/pi/shared.ts`.
- One session per owner (pulled forward from M3): the web app always opens the same session (`MIPI_OWNER`, default `jerome`), and a returning visitor goes straight back to it instead of starting a new one.

**Pi Durable**

- No change (1.6.0). Found while writing the readers: the `tasks.kind` column holds the kind JSON-encoded, so the readers use the task record's own `kind` and `version`.

**Migration**

- Conversations from the M1 spike were in separate, randomly named sessions and don't appear in the owner's session. Nothing to do (alpha).
