import { handleAdmin, isAdmin } from "./admin.ts";
import { handleUnlock, isSpikeAuthorized } from "./auth.ts";
import { SUPPORTED_SCHEMA_VERSION } from "../agent/pi/storage.ts";
import { MIPI_VERSION, PI_DURABLE_VERSION } from "../version.ts";

export { MipiAgent } from "../agent/agent-do.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public liveness check. Versions only for the admin token (deploy scripts), never publicly.
    if (url.pathname === "/api/health") {
      return (await isAdmin(request, env.ADMIN_TOKEN))
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

    // Admin routes have their own token (deploy scripts), not the spike lock.
    if (url.pathname.startsWith("/api/admin/")) return handleAdmin(request, env, url.pathname);

    if (url.pathname === "/api/unlock") return handleUnlock(request, env.MIPI_SPIKE_TOKEN);

    // Everything else under /api, the WebSocket upgrade included, needs the spike token (M1, until Access in M4).
    if (!(await isSpikeAuthorized(request, env.MIPI_SPIKE_TOKEN))) {
      return json({ error: "Locked" }, 401);
    }

    if (url.pathname === "/api/spike/probe") {
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      // Plan facts are per account, so any object will do.
      return json(await env.AGENT.getByName("spike-probe").spikeProbe(), 200);
    }

    if (url.pathname === "/api/sessions" || url.pathname === "/api/sessions/") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      // One session per owner (pulled forward from M3): every visit opens the same Durable Object.
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
      return env.AGENT.getByName(sessionMatch[1]).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
