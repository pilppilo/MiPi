/**
 * Auth for every route. Before Cloudflare Access is configured, M1's temporary lock applies: every `/api` request, including the WebSocket upgrade, must
 * carry `MIPI_SPIKE_TOKEN`. A browser sends it as an HttpOnly cookie set once by `POST /api/unlock`; scripts send
 * `Authorization: Bearer <token>`. Without the secret configured, everything is refused.
 */

import {
  ACCESS_JWT_HEADER,
  type AccessConfig,
  type Fetch as AccessFetch,
  verifyAccessJwt,
} from "./access.ts";
import { logRefusedRequest } from "../agent/diag.ts";

export const SPIKE_COOKIE = "mipi_spike";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

/** Equal strings, in time that doesn't depend on where they differ (both are hashed to the same length first). */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function presentedToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  return cookie(request, SPIKE_COOKIE);
}

/** Whether the request carries the spike token. False when no token is configured (fail closed). */
export async function isSpikeAuthorized(
  request: Request,
  expected: string | undefined,
): Promise<boolean> {
  if (expected === undefined || expected.trim().length === 0) return false;
  const presented = presentedToken(request);
  if (presented === undefined || presented.length === 0) return false;
  return constantTimeEqual(presented, expected);
}

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

/**
 * `GET /api/unlock`: 204 when the request is already unlocked, else 401 (the client's check).
 * `POST /api/unlock` with `{ "token": "…" }`: sets the cookie when the token matches.
 */
export async function handleUnlock(
  request: Request,
  expected: string | undefined,
): Promise<Response> {
  if (request.method === "GET") {
    return (await isSpikeAuthorized(request, expected))
      ? new Response(null, { status: 204 })
      : json({ error: "Locked" }, 401);
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });

  let token: unknown;
  try {
    token = ((await request.json()) as { token?: unknown } | null)?.token;
  } catch {
    return json({ error: "Expected JSON with a token" }, 400);
  }
  if (
    typeof token !== "string" ||
    expected === undefined ||
    expected.trim().length === 0 ||
    !(await constantTimeEqual(token, expected))
  ) {
    // A guess at the unlock token, logged like any refused credential (the GET check above stays quiet).
    logRefusedRequest("auth.refused", request, 401, "wrong unlock token");
    return json({ error: "Wrong token" }, 401);
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `${SPIKE_COOKIE}=${encodeURIComponent(token)}; Path=/api; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

// ---- Who is calling (M4) ----

/**
 * Who a request is, for the kind of route it asks for. Cloudflare Access is on when `ACCESS_TEAM_DOMAIN` and
 * `ACCESS_AUD` are set: then every protected route needs a valid Access JWT, the owner's for web routes and the
 * deploy service token's for admin routes, and the spike lock and `ADMIN_TOKEN` are no longer accepted. Until they
 * are set, the M1 spike lock (web) and `ADMIN_TOKEN` (admin) apply, so a deploy before Access is configured locks
 * nobody out.
 */
export type Principal =
  | { readonly kind: "owner" }
  | { readonly kind: "admin" }
  | { readonly kind: "refused"; readonly status: 401 | 403 | 500; readonly reason: string };

export type RouteKind = "web" | "admin";

/** Optional configuration, read where the Worker meets its bindings: a var may be absent at runtime. */
function setting(env: Env, name: string): string | undefined {
  const value: unknown = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function accessConfig(env: Env): AccessConfig | undefined {
  const teamDomain = setting(env, "ACCESS_TEAM_DOMAIN");
  const aud = setting(env, "ACCESS_AUD");
  return teamDomain === undefined || aud === undefined ? undefined : { teamDomain, aud };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function authenticate(
  request: Request,
  env: Env,
  route: RouteKind,
  fetcher?: AccessFetch,
): Promise<Principal> {
  // Local development only: the flag is refused anywhere but a local host, so it can't open staging or production.
  if (setting(env, "MIPI_ACCESS_SKIP") !== undefined) {
    if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) {
      return {
        kind: "refused",
        status: 500,
        reason: "MIPI_ACCESS_SKIP is set outside local development; refusing every request",
      };
    }
    return { kind: route === "admin" ? "admin" : "owner" };
  }

  const access = accessConfig(env);
  if (access === undefined) {
    if (route === "admin") {
      return (await isBearer(request, env.ADMIN_TOKEN))
        ? { kind: "admin" }
        : { kind: "refused", status: 401, reason: "Unauthorized" };
    }
    return (await isSpikeAuthorized(request, env.MIPI_SPIKE_TOKEN))
      ? { kind: "owner" }
      : { kind: "refused", status: 401, reason: "Locked" };
  }

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token.length === 0) {
    return { kind: "refused", status: 401, reason: "Sign in through Cloudflare Access" };
  }
  const result = await verifyAccessJwt(token, access, fetcher);
  if (!result.ok) return { kind: "refused", status: 401, reason: result.reason };
  const identity = result.identity;
  switch (identity.type) {
    case "user": {
      if (route === "admin") {
        return {
          kind: "refused",
          status: 403,
          reason: "Admin routes need the deploy service token",
        };
      }
      if (identity.email !== setting(env, "ACCESS_OWNER_EMAIL")) {
        return { kind: "refused", status: 403, reason: "Access identity is not the owner" };
      }
      return { kind: "owner" };
    }
    case "service": {
      if (route === "web") {
        return { kind: "refused", status: 403, reason: "A service token can't use web routes" };
      }
      const expected = setting(env, "ACCESS_SERVICE_CLIENT_ID");
      if (expected === undefined) {
        return { kind: "refused", status: 403, reason: "ACCESS_SERVICE_CLIENT_ID is not set" };
      }
      return (await constantTimeEqual(identity.clientId, expected))
        ? { kind: "admin" }
        : { kind: "refused", status: 403, reason: "Unknown service token" };
    }
    default: {
      const _: never = identity;
      return { kind: "refused", status: 403, reason: "Unknown identity" };
    }
  }
}

/** Whether the request carries `Authorization: Bearer <expected>`. False when nothing is configured (fail closed). */
export async function isBearer(request: Request, expected: string | undefined): Promise<boolean> {
  if (expected === undefined || expected.trim().length === 0) return false;
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  return constantTimeEqual(authorization.slice("Bearer ".length).trim(), expected);
}

/**
 * A browser's WebSocket upgrade must come from this site: cookies (Access's, or the spike lock's) ride along on
 * cross-site upgrades too, so another page could otherwise open the owner's socket.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true; // Not a browser (scripts, tests): nothing to forge.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
