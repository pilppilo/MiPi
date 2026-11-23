# Cloudflare Access

Configure staging first in Cloudflare Zero Trust under **Access controls → Applications**. Add a **Self-hosted** application for the staging hostname with an Allow policy for the owner's sign-in identity. Use the hostname application for WebSocket support. Add a separate application for the exact `/api/health` path with a Bypass policy. When the Telegram and relay handlers are deployed, configure path bypass applications for them and verify each handler's own authentication (see [Telegram](telegram.md) and [the PiDu relay](relay.md)).

Create a service token under **Access controls → Service credentials → Service Tokens**. On the staging hostname application, add a Service Auth policy selecting that token. Keep the exact-path health application on its Bypass policy. In the matching GitHub Environment, set:

- Variables `ACCESS_TEAM_DOMAIN` (the team's Access domain), `ACCESS_AUD` (the application's AUD), `ACCESS_OWNER_EMAIL` (the exact email in the owner's Access identity), and `ACCESS_SERVICE_CLIENT_ID` (the service token's client ID).
- Secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` for backup, deploy, and rollback requests.

Keep the existing admin token available for deployments before Access is enabled. Set `MIPI_ACCESS_SKIP` only for localhost development. Use a separate application and token for production.

On staging, verify signed-out HTTP and WebSocket requests are denied, then sign in on desktop and phone and exchange a chat message on each. Verify signed-out `/api/health` returns only `{"ok":true}`. Run a backup with the service token and verify the same token is refused on an owner `/api/` route, such as the WebSocket upgrade (`GET /api/sessions/<owner>`) or `GET /api/unlock`. A `200` from `/` with that token is expected: `wrangler.jsonc` runs the Worker first only for `/api/*`, so `/` is a static asset and Access lets the token through without the Worker seeing it. The checks for Telegram and the relay are in their own guides.

Worker preview URLs are not covered by the hostname application, so disable preview URLs for the staging and production Workers, or protect them separately.
