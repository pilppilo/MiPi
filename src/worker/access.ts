/**
 * Cloudflare Access (M4). Access signs a JWT for every request it lets through and sends it in
 * `Cf-Access-Jwt-Assertion`. The Worker verifies it on every route Access protects: signature (RS256, keys from the
 * team's certs endpoint), issuer, audience, and time. A person signed in through Access carries an `email`; a deploy
 * script using a service token carries `common_name` (the token's client id) and no email.
 */

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com` */
  readonly teamDomain: string;
  /** The Access application's AUD tag. */
  readonly aud: string;
}

/** Who a valid Access JWT names. */
export type AccessIdentity =
  | { readonly type: "user"; readonly email: string }
  | { readonly type: "service"; readonly clientId: string };

export type AccessResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly reason: string };

export type Fetch = (input: string) => Promise<Response>;

/** Keys stay this long; an unknown `kid` refetches sooner, at most once a minute. */
const KEYS_MAX_AGE_MS = 60 * 60_000;
const UNKNOWN_KID_RETRY_MS = 60_000;
/** Tolerated clock difference for `exp` and `nbf`. */
const LEEWAY_SECONDS = 60;

interface KeySet {
  readonly fetchedAt: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

/** Module scope: one isolate keeps the team's keys between requests. */
const keySets = new Map<string, KeySet>();

/** Tests only. */
export function clearAccessKeys(): void {
  keySets.clear();
}

const decoder = new TextDecoder();

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlJson(value: string): unknown {
  return JSON.parse(decoder.decode(base64UrlBytes(value)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The team domain as Access writes it in `iss`: `https://<team>.cloudflareaccess.com`, no trailing slash. */
export function normalizeTeamDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

async function loadKeys(teamDomain: string, fetcher: Fetch, now: number): Promise<KeySet> {
  const response = await fetcher(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs answered ${response.status}`);
  const body: unknown = await response.json();
  const keys = new Map<string, CryptoKey>();
  // External response: a JWK set with current and previous keys.
  for (const jwk of isRecord(body) && Array.isArray(body.keys) ? body.keys : []) {
    if (!isRecord(jwk) || typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n as string, e: jwk.e as string, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  if (keys.size === 0) throw new Error("Access certs had no RSA keys");
  const set = { fetchedAt: now, keys };
  keySets.set(teamDomain, set);
  return set;
}

async function keyFor(
  teamDomain: string,
  kid: string,
  fetcher: Fetch,
  now: number,
): Promise<CryptoKey | undefined> {
  let set = keySets.get(teamDomain);
  if (set === undefined || now - set.fetchedAt >= KEYS_MAX_AGE_MS) {
    set = await loadKeys(teamDomain, fetcher, now);
  }
  const key = set.keys.get(kid);
  if (key !== undefined) return key;
  // A rotated key: refetch, but not on every request with a bad kid.
  if (now - set.fetchedAt < UNKNOWN_KID_RETRY_MS) return undefined;
  return (await loadKeys(teamDomain, fetcher, now)).keys.get(kid);
}

/** Verifies an Access JWT and says who it names. Never throws for a bad token; a certs outage is a refusal too. */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  fetcher: Fetch = fetch,
  now: number = Date.now(),
): Promise<AccessResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "Malformed token" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = base64UrlJson(headerPart);
    payload = base64UrlJson(payloadPart);
  } catch {
    return { ok: false, reason: "Malformed token" };
  }
  if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "Unsupported token header" };
  }
  if (!isRecord(payload)) return { ok: false, reason: "Malformed token" };

  const teamDomain = normalizeTeamDomain(config.teamDomain);
  let key: CryptoKey | undefined;
  try {
    key = await keyFor(teamDomain, header.kid, fetcher, now);
  } catch (error) {
    return { ok: false, reason: `Access keys unavailable: ${(error as Error).message}` };
  }
  if (key === undefined) return { ok: false, reason: "Unknown signing key" };

  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlBytes(signaturePart),
      signed,
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "Bad signature" };

  if (payload.iss !== teamDomain) return { ok: false, reason: "Wrong issuer" };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.aud)) return { ok: false, reason: "Wrong audience" };
  const seconds = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_SECONDS < seconds) {
    return { ok: false, reason: "Expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_SECONDS > seconds) {
    return { ok: false, reason: "Not valid yet" };
  }

  if (typeof payload.email === "string" && payload.email.length > 0) {
    return { ok: true, identity: { type: "user", email: payload.email } };
  }
  if (typeof payload.common_name === "string" && payload.common_name.length > 0) {
    return { ok: true, identity: { type: "service", clientId: payload.common_name } };
  }
  return { ok: false, reason: "Token names no user or service token" };
}
