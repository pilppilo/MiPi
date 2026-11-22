# mipi

## 0.1.0-alpha.2

### Minor Changes

- M1 free-plan spike: MiPi deploys to Cloudflare from GitHub Actions, behind a temporary lock.

  **Added**
  - Deploy workflow: after `check` passes on `main` (or by hand), `wrangler deploy` ships the Worker `mipi` with `OPENCODE_API_KEY` and `MIPI_SPIKE_TOKEN` uploaded in the same version, then checks `/api/health`.
  - Release workflow: a new version on `main` gets its tag and a GitHub release from its `CHANGELOG.md` section (pre-releases for `-alpha`/`-beta`).
  - Spike lock (until Cloudflare Access in M4): every `/api` route and the WebSocket upgrade need `MIPI_SPIKE_TOKEN`, as an HttpOnly cookie set once by `POST /api/unlock` or as a Bearer header. Constant-time compare; refuses everything when the secret is unset. The web app asks for the token once.
  - `/api/health` (public, says only `{ ok: true }`) and `/api/spike/probe` (locked; reports whether Durable Object point-in-time recovery bookmarks work).
  - `spike-probe` workflow: which OpenCode Go usage URL answers and its shape, the PITR probe, and Worker CPU/error/subrequest analytics.

  **Changed**
  - pi-ai gets `OPENCODE_API_KEY` from the Worker's bindings through its `authContext`, not from `process.env` (which a Worker only has with Node compatibility). Tested in workerd.

  **Pi Durable**
  - No change (1.6.0).

  **Migration**
  - New repository secret `MIPI_SPIKE_TOKEN` (24+ random characters) before the first deploy.

## 0.1.0-alpha.1

### Minor Changes

- M0 scaffold: MiPi seeded once from `earendil-works/pi-durable-cloudflare` @ `b68bf92` (MIT).

  **Added**
  - `src/agent/pi/`: the seam for all Pi Durable, pi-ai, pi-schema, and chord imports on the server (M2a narrows it and adds the lint rule).
  - OpenCode Go as the model provider (pi-ai's built-in `opencode-go`); default model `deepseek-v4.1-flash` at thinking level `low`, set by the `MIPI_MODEL` var.
  - Per-model compaction reserve (`summaryReserve`, adapted from Pi Pocket @ `2f060f2`, MIT) so long conversations keep room for their summary; `deepseek-v4.1-flash` gets 32,768 tokens.
  - Changesets in `alpha` pre mode, exact dependency pins, `.node-version`, and a CI workflow running `pnpm check` and `pnpm test`.

  **Changed**
  - Layout: `src/worker/`, `src/agent/`, `src/tools/`, `src/lib/`. The Durable Object is `MipiAgent` on binding `AGENT`; the Worker is `mipi`.
  - Client: tool calls that park (`waiting`, `sleeping`) show as running, and a sleep without a deadline shows as "until woken".

  **Removed**
  - The sample's mock `get_weather` tool.

  **Pi Durable**
  - `pi-durable`, `pi-ai`, `pi-schema`, `chord` 1.6.0 (from the sample's 1.5.2). Storage: Pi Durable 1.6 (`pi.tool` tasks v4, `pi.generation` v3).

  **Migration**
  - None: first release, no data.
