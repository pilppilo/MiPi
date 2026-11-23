---
"mipi": minor
---

COD-151 (M4, work in progress): Cloudflare Access.

**Added**

- The Worker verifies Cloudflare Access JWTs (`Cf-Access-Jwt-Assertion`: RS256, issuer, audience, time; team keys cached, refetched on an unknown key at most once a minute or hourly). A person's token opens web routes and the socket; the deploy service token (`common_name` = `ACCESS_SERVICE_CLIENT_ID`) opens admin routes only.
- WebSocket upgrades from another site are refused.
- `MIPI_ACCESS_SKIP=1` skips auth on localhost only; on any other host it refuses every request.
- Deploy scripts send the Access service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`); `deploy.ts version` reads the deployed version through the admin API.

**Changed**

- Access is on once a lane's GitHub Environment has the variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (passed as Worker vars at deploy). Until then the spike lock and `ADMIN_TOKEN` apply as before, so deploying this changes nothing.
- The deploy and rollback workflows read the deployed version through the admin API, since the public health check shows none.

**Pi Durable**

- No change (1.6.0). No ledger changes.

**Migration**

- None until Access is set up for a lane.
