import { handleUnlock, isSpikeAuthorized } from "./auth.ts";

export { MipiAgent } from "../agent/agent-do.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public: a liveness check that says nothing else.
    if (url.pathname === "/api/health") return json({ ok: true }, 200);

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
      const sessionId = crypto.randomUUID();
      return json({ sessionId, url: `/sessions/${sessionId}` }, 201);
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
