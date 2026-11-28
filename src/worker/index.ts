import { handleVault, isVaultPath, withVaultHeaders } from "./vault.ts";
import { handleAdmin } from "./admin.ts";
import { handleRelay, isRelayPath } from "./relay.ts";
import { handleTelegramWebhook } from "./telegram.ts";
import { accessConfig, authenticate, handleUnlock, isSameOrigin, type Principal } from "./auth.ts";
import { SUPPORTED_SCHEMA_VERSION } from "../agent/pi/storage.ts";
import { logRefusedRequest } from "../agent/diag.ts";
import { MIPI_VERSION, PI_DURABLE_VERSION } from "../version.ts";

export { MipiAgent } from "../agent/agent-do.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

/** The one agent: every door, alarm and admin call goes to the owner's Durable Object. */
const ownerAgent = (env: Env) => env.AGENT.getByName(env.MIPI_OWNER);

/** A refused request, with the reason (no secrets are in it), logged as a Worker diagnostic. */
const refuse = (request: Request, principal: Principal): Response => {
  const [status, reason] =
    principal.kind === "refused"
      ? [principal.status, principal.reason]
      : ([403, "Forbidden"] as const);
  logRefusedRequest("auth.refused", request, status, reason);
  return json({ error: reason }, status);
};

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Telegram's webhook: before owner auth (Access bypasses this exact path); its own secret authenticates it.
    if (url.pathname === "/api/telegram") {
      return handleTelegramWebhook(request, env, () => ownerAgent(env));
    }

    // The PiDu relay (M7): before owner auth (Access bypasses `api/relay`); its bearer token authenticates it.
    if (isRelayPath(url.pathname)) {
      return handleRelay(request, env, url.pathname, () => ownerAgent(env));
    }

    // Public liveness check (bypassed by Access). Versions only for the deploy scripts, never publicly.
    if (url.pathname === "/api/health") {
      // The Access Bypass policy sends no JWT. Deploys read the version through the admin API.
      return (await authenticate(request, env, "admin")).kind === "admin"
        ? json(
            {
              ok: true,
              version: MIPI_VERSION,
              piDurable: PI_DURABLE_VERSION,
              storageSchema: SUPPORTED_SCHEMA_VERSION,
              env: env.MIPI_ENV,
            },
            200,
          )
        : json({ ok: true }, 200);
    }

    // Admin routes are for the deploy scripts only: the Access service token, or `ADMIN_TOKEN` before Access.
    if (url.pathname.startsWith("/api/admin/")) {
      const admin = await authenticate(request, env, "admin");
      return admin.kind === "admin"
        ? handleAdmin(request, env, url.pathname)
        : refuse(request, admin);
    }

    if (url.pathname === "/api/unlock") {
      // With Access on, the web client's check is "am I signed in?"; the spike token no longer unlocks anything.
      if (accessConfig(env) === undefined && request.method !== "GET") {
        return handleUnlock(request, env.MIPI_SPIKE_TOKEN);
      }
      if (request.method !== "GET") return json({ error: "Signed in through Access" }, 409);
      const caller = await authenticate(request, env, "web");
      return caller.kind === "owner"
        ? new Response(null, { status: 204 })
        : refuse(request, caller);
    }

    // Everything else under /api, the WebSocket upgrade included, is the owner's.
    const caller = await authenticate(request, env, "web");
    if (isVaultPath(url.pathname)) {
      return withVaultHeaders(
        caller.kind === "owner"
          ? await handleVault(request, url, () => ownerAgent(env))
          : refuse(request, caller),
      );
    }
    if (caller.kind !== "owner") return refuse(request, caller);

    if (url.pathname === "/api/spike/probe") {
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      // Plan facts are per account; the owner's object answers like any other.
      return json(await ownerAgent(env).spikeProbe(), 200);
    }

    if (url.pathname === "/api/sessions" || url.pathname === "/api/sessions/") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      // One session per owner: every visit opens the same Durable Object.
      const sessionId = encodeURIComponent(env.MIPI_OWNER);
      return json({ sessionId, url: `/sessions/${sessionId}` }, 200);
    }

    const sessionMatch = sessionSocketRoute.exec(url.pathname);
    if (sessionMatch !== null) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
      }
      if (!isSameOrigin(request)) {
        logRefusedRequest("ws.cross_origin", request, 403, "Cross-site WebSocket refused");
        return json({ error: "Cross-site WebSocket refused" }, 403);
      }
      // Only the owner's session exists; any other id is not found, and never creates an object.
      if (sessionMatch[1] !== encodeURIComponent(env.MIPI_OWNER)) {
        return json({ error: "Not found" }, 404);
      }
      return ownerAgent(env).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
