---
"mipi": minor
---

M1 free-plan spike: MiPi deploys to Cloudflare from GitHub Actions, behind a temporary lock.

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
