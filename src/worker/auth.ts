/**
 * M1's temporary lock (until Cloudflare Access in M4): every `/api` request, including the WebSocket upgrade, must
 * carry `MIPI_SPIKE_TOKEN`. A browser sends it as an HttpOnly cookie set once by `POST /api/unlock`; scripts send
 * `Authorization: Bearer <token>`. Without the secret configured, everything is refused.
 */

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
    return json({ error: "Wrong token" }, 401);
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `${SPIKE_COOKIE}=${encodeURIComponent(token)}; Path=/api; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}
