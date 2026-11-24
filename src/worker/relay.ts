/**
 * The PiDu relay's HTTP door (M7): `POST /api/relay` and `GET /api/relay/:key`. They run before the owner's web
 * authentication (Cloudflare Access bypasses the `api/relay` path), so this handler is their whole authentication:
 * `Authorization: Bearer <RELAY_TOKEN>`, compared in constant time. `RELAY_TOKEN_PREVIOUS` is accepted too while a
 * token is being rotated. Without a valid `RELAY_TOKEN` the relay is off and refuses everything.
 *
 * The agent does the work (`src/agent/relay.ts`); this file only authenticates, reads the request, and maps the
 * agent's result to a status. `done` and `unanswered` are both 200 with the same JSON shape, so a model failure is
 * never mistaken for an outage.
 */
import { constantTimeEqual } from "./auth.ts";
import { readBounded } from "./body.ts";
import { RELAY_MAX_TEXT_BYTES, type RelayResult } from "../agent/relay.ts";
import { isRelayKey } from "../lib/requests.ts";

/** The shortest token accepted, as for `ADMIN_TOKEN`: a shorter one leaves the relay off. */
export const RELAY_TOKEN_MIN_LENGTH = 24;
/** A request body: the text, JSON-escaped (up to 6 bytes per byte), and a little more. */
export const MAX_RELAY_BODY_BYTES = 6 * RELAY_MAX_TEXT_BYTES + 1024;
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** Seconds a client waits before trying again when the agent is unavailable. */
export const UNAVAILABLE_RETRY_SECONDS = 30;
/** Seconds a client waits before trying again while MiPi is paused (`MIPI_PAUSED`). */
export const PAUSED_RETRY_SECONDS = 3600;

export interface RelayAgent {
  /** `host` is the hostname the request came to, which the agent keeps so `web_fetch` refuses it. */
  relayAdmit(key: string, text: string, host?: string): Promise<RelayResult>;
  relayResult(key: string, host?: string): Promise<RelayResult>;
}

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

function setting(env: Env, name: string): string | undefined {
  const value: unknown = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim().length >= RELAY_TOKEN_MIN_LENGTH
    ? value.trim()
    : undefined;
}

/** The tokens the relay accepts now: none while `RELAY_TOKEN` is unset or too short. */
export function relayTokens(env: Env): string[] {
  const current = setting(env, "RELAY_TOKEN");
  if (current === undefined) return [];
  const previous = setting(env, "RELAY_TOKEN_PREVIOUS");
  return previous === undefined ? [current] : [current, previous];
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return false;
  const presented = authorization.slice("Bearer ".length).trim();
  if (presented.length === 0) return false;
  // Every configured token is compared, so the time doesn't say which one matched.
  const matches = await Promise.all(
    relayTokens(env).map((token) => constantTimeEqual(presented, token)),
  );
  return matches.includes(true);
}

/** Whether a path is the relay's: `/api/relay` or anything under `/api/relay/`. */
export const isRelayPath = (pathname: string): boolean =>
  pathname === "/api/relay" || pathname.startsWith("/api/relay/");

/** The agent's result as a response. `id` is the key the client sent. */
export function relayResponse(id: string, result: RelayResult): Response {
  switch (result.kind) {
    case "done":
      return json({ id, status: "done", answer: result.answer }, 200);
    case "unanswered":
      return json({ id, status: "unanswered", reason: result.reason }, 200);
    case "pending":
      return json({ id, status: "pending" }, 202, {
        Location: `/api/relay/${id}`,
        "Retry-After": "5",
      });
    case "conflict":
      return json({ id, error: "This Idempotency-Key was used with another text" }, 409);
    case "limited":
      return json({ id, error: "Too many relay messages this hour" }, 429, {
        "Retry-After": String(result.retryAfterSeconds),
      });
    case "invalid":
      return json({ id, error: result.reason }, 400);
    case "too-large":
      return json({ id, error: `text is over ${result.limitBytes} bytes` }, 413);
    case "not-found":
      return json({ id, error: "Not found" }, 404);
    case "unavailable":
      return json({ id, error: "Unavailable" }, 503, {
        "Retry-After": String(UNAVAILABLE_RETRY_SECONDS),
      });
    case "paused":
      // A pause lasts until the owner redeploys without it: no point retrying within minutes.
      return json({ id, error: "Paused" }, 503, { "Retry-After": String(PAUSED_RETRY_SECONDS) });
    default: {
      const _: never = result;
      throw new Error("Unknown relay result");
    }
  }
}

async function call(id: string, work: () => Promise<RelayResult>): Promise<Response> {
  try {
    return relayResponse(id, await work());
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Relay call to the agent failed",
        key: id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return relayResponse(id, { kind: "unavailable" });
  }
}

export async function handleRelay(
  request: Request,
  env: Env,
  pathname: string,
  agent: () => RelayAgent,
): Promise<Response> {
  // Authentication first: without a token nothing about the relay is told, not even which methods exist.
  if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

  if (pathname === "/api/relay" || pathname === "/api/relay/") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    const key = request.headers.get(IDEMPOTENCY_HEADER)?.trim() ?? "";
    if (!isRelayKey(key)) {
      return json({ error: `${IDEMPOTENCY_HEADER} must be 1 to 64 letters, digits, - or _` }, 400);
    }
    const body = await readBounded(request, MAX_RELAY_BODY_BYTES);
    if (body === undefined) return json({ id: key, error: "Body too large" }, 413);
    let text: unknown;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      // `in` on an unknown value at the trust boundary.
      text =
        typeof parsed === "object" && parsed !== null && "text" in parsed ? parsed.text : undefined;
    } catch {
      return json({ id: key, error: 'Expected JSON: { "text": "…" }' }, 400);
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return json({ id: key, error: "text must be a non-empty string" }, 400);
    }
    if (new TextEncoder().encode(text).byteLength > RELAY_MAX_TEXT_BYTES) {
      return relayResponse(key, { kind: "too-large", limitBytes: RELAY_MAX_TEXT_BYTES });
    }
    return call(key, () => agent().relayAdmit(key, text, new URL(request.url).hostname));
  }

  // `/api/relay/<key>`: exactly one segment, checked before the agent is asked anything.
  const key = pathname.slice("/api/relay/".length);
  if (!isRelayKey(key)) return json({ error: "Not found" }, 404);
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }
  return call(key, () => agent().relayResult(key, new URL(request.url).hostname));
}
