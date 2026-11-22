import { handleAdmin } from "./admin.ts";
import { accessConfig, authenticate, handleUnlock, isSameOrigin, type Principal } from "./auth.ts";
import { SUPPORTED_SCHEMA_VERSION } from "../agent/pi/storage.ts";
import { MIPI_VERSION, PI_DURABLE_VERSION } from "../version.ts";

export { MipiAgent } from "../agent/agent-do.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

/** The one agent: every door, alarm and admin call goes to the owner's Durable Object. */
const ownerAgent = (env: Env) => env.AGENT.getByName(env.MIPI_OWNER);

/** A refused request, with the reason (no secrets are in it). */
const refuse = (principal: Principal): Response =>
  principal.kind === "refused"
    ? json({ error: principal.reason }, principal.status)
    : json({ error: "Forbidden" }, 403);

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public liveness check (bypassed by Access). Versions only for the deploy scripts, never publicly.
    if (url.pathname === "/api/health") {
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
      return admin.kind === "admin" ? handleAdmin(request, env, url.pathname) : refuse(admin);
    }

    if (url.pathname === "/api/unlock") {
      // With Access on, the web client's check is "am I signed in?"; the spike token no longer unlocks anything.
      if (accessConfig(env) === undefined && request.method !== "GET") {
        return handleUnlock(request, env.MIPI_SPIKE_TOKEN);
      }
      if (request.method !== "GET") return json({ error: "Signed in through Access" }, 409);
      const caller = await authenticate(request, env, "web");
      return caller.kind === "owner" ? new Response(null, { status: 204 }) : refuse(caller);
    }

    // Everything else under /api, the WebSocket upgrade included, is the owner's.
    const caller = await authenticate(request, env, "web");
    if (caller.kind !== "owner") return refuse(caller);

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
      if (!isSameOrigin(request)) return json({ error: "Cross-site WebSocket refused" }, 403);
      // Only the owner's session exists; any other id is not found, and never creates an object.
      if (sessionMatch[1] !== encodeURIComponent(env.MIPI_OWNER)) {
        return json({ error: "Not found" }, 404);
      }
      return ownerAgent(env).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
