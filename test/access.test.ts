import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearAccessKeys, verifyAccessJwt } from "../src/worker/access.ts";
import worker from "../src/worker/index.ts";
import { SPIKE_TOKEN } from "./spike.ts";

const TEAM = "https://mipi-test.cloudflareaccess.com";
const AUD = "test-aud-tag";
const SERVICE_ID = "deploy-client.access";

const encode = (value: unknown): string =>
  btoa(typeof value === "string" ? value : JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const bytesToBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

interface Signer {
  readonly kid: string;
  readonly jwk: JsonWebKey;
  sign(claims: Record<string, unknown>): Promise<string>;
}

async function signer(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey,
    async sign(claims) {
      const head = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode(claims)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(head),
      );
      return `${head}.${bytesToBase64Url(signature)}`;
    },
  };
}

const now = () => Math.floor(Date.now() / 1000);
const userClaims = (extra: Record<string, unknown> = {}) => ({
  iss: TEAM,
  aud: [AUD],
  email: "jerome@example.com",
  exp: now() + 600,
  nbf: now() - 10,
  ...extra,
});
const serviceClaims = (extra: Record<string, unknown> = {}) => ({
  iss: TEAM,
  aud: [AUD],
  common_name: SERVICE_ID,
  type: "app",
  exp: now() + 600,
  ...extra,
});

let current: Signer;
let rotated: Signer;
let published: Signer[];
let certFetches = 0;
const certs = async (url: string): Promise<Response> => {
  certFetches += 1;
  expect(url).toBe(`${TEAM}/cdn-cgi/access/certs`);
  return Response.json({ keys: published.map(({ jwk }) => jwk) });
};

beforeAll(async () => {
  current = await signer("key-1");
  rotated = await signer("key-2");
});

afterEach(() => {
  clearAccessKeys();
  certFetches = 0;
  vi.unstubAllGlobals();
});

describe("Access JWT verification", () => {
  const config = { teamDomain: TEAM, aud: AUD };

  it("accepts a person's token and a service token, and says which", async () => {
    published = [current];
    await expect(verifyAccessJwt(await current.sign(userClaims()), config, certs)).resolves.toEqual(
      {
        ok: true,
        identity: { type: "user", email: "jerome@example.com" },
      },
    );
    await expect(
      verifyAccessJwt(await current.sign(serviceClaims()), config, certs),
    ).resolves.toEqual({
      ok: true,
      identity: { type: "service", clientId: SERVICE_ID },
    });
    // The team's keys are fetched once and kept.
    expect(certFetches).toBe(1);
  });

  it.each([
    ["another audience", { aud: ["someone-else"] }, "Wrong audience"],
    ["another issuer", { iss: "https://evil.cloudflareaccess.com" }, "Wrong issuer"],
    ["an expired token", { exp: now() - 3600 }, "Expired"],
    ["a token not valid yet", { nbf: now() + 3600 }, "Not valid yet"],
    ["no identity", { email: undefined }, "names no user"],
  ])("refuses %s", async (_name, change, reason) => {
    published = [current];
    const result = await verifyAccessJwt(await current.sign(userClaims(change)), config, certs);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });

  it("refuses a forged signature and a malformed token", async () => {
    published = [current];
    const token = await current.sign(userClaims());
    const [head, , signature] = token.split(".");
    const forged = `${head}.${encode(userClaims({ email: "attacker@example.com" }))}.${signature}`;
    await expect(verifyAccessJwt(forged, config, certs)).resolves.toMatchObject({
      ok: false,
      reason: "Bad signature",
    });
    await expect(verifyAccessJwt("not-a-jwt", config, certs)).resolves.toMatchObject({ ok: false });
    const none = `${encode({ alg: "none", kid: "key-1" })}.${encode(userClaims())}.`;
    await expect(verifyAccessJwt(none, config, certs)).resolves.toMatchObject({ ok: false });
  });

  it("refetches the keys for an unknown kid after a rotation, at most once a minute", async () => {
    published = [current];
    const start = Date.now();
    expect((await verifyAccessJwt(await current.sign(userClaims()), config, certs, start)).ok).toBe(
      true,
    );

    published = [rotated, current];
    const rotatedToken = await rotated.sign(userClaims());
    // Within a minute of the last fetch, an unknown kid doesn't refetch.
    await expect(
      verifyAccessJwt(rotatedToken, config, certs, start + 1_000),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Unknown signing key",
    });
    expect(certFetches).toBe(1);
    expect((await verifyAccessJwt(rotatedToken, config, certs, start + 61_000)).ok).toBe(true);
    expect(certFetches).toBe(2);
  });

  it("refuses, without throwing, when the certs can't be read", async () => {
    const down = async () => new Response("", { status: 503 });
    await expect(
      verifyAccessJwt(await current.sign(userClaims()), config, down),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("Access keys unavailable"),
    });
  });
});

describe("routes with Access on", () => {
  const owner = "access-owner";
  const accessEnv = {
    ...env,
    MIPI_OWNER: owner,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_SERVICE_CLIENT_ID: SERVICE_ID,
  } as unknown as Env;
  const base = "https://mipi.example.workers.dev";

  const call = async (
    path: string,
    init: RequestInit & { jwt?: string } = {},
    target: Env = accessEnv,
  ) => {
    vi.stubGlobal("fetch", certs);
    const headers = new Headers(init.headers);
    if (init.jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.jwt);
    return worker.fetch(new Request(`${base}${path}`, { ...init, headers }), target);
  };

  it("refuses everything but the health check without an Access JWT, spike token and ADMIN_TOKEN included", async () => {
    published = [current];
    const health = await call("/api/health");
    expect(await health.json()).toEqual({ ok: true });

    for (const [path, init] of [
      ["/api/sessions", { method: "POST" }],
      [`/api/sessions/${owner}`, { headers: { Upgrade: "websocket" } }],
      ["/api/sessions", { method: "POST", headers: { Authorization: `Bearer ${SPIKE_TOKEN}` } }],
      ["/api/admin/status", { headers: { Authorization: "Bearer test-admin-token" } }],
      ["/api/unlock", {}],
    ] as const) {
      const response = await call(path, init);
      expect(response.status, path).toBe(401);
      expect(response.webSocket).toBeNull();
      await response.body?.cancel();
    }
  });

  it("lets the owner in on web routes and the socket, from the same site only", async () => {
    published = [current];
    const jwt = await current.sign(userClaims());
    const unlocked = await call("/api/unlock", { jwt });
    expect(unlocked.status).toBe(204);

    const session = await call("/api/sessions", { method: "POST", jwt });
    expect(session.status).toBe(200);
    await session.body?.cancel();

    const socket = await call(`/api/sessions/${owner}`, {
      jwt,
      headers: { Upgrade: "websocket", Origin: base },
    });
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close(1000, "done");

    const crossSite = await call(`/api/sessions/${owner}`, {
      jwt,
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    await crossSite.body?.cancel();

    // A person's session can't use the admin routes.
    const admin = await call("/api/admin/status", { jwt });
    expect(admin.status).toBe(403);
    await admin.body?.cancel();
  });

  it("accepts the deploy service token on admin routes only", async () => {
    published = [current];
    const jwt = await current.sign(serviceClaims());
    const status = await call("/api/admin/status", { jwt });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { state: unknown }).state).toEqual({ kind: "open" });

    const health = await call("/api/health", { jwt });
    expect(await health.json()).toMatchObject({ ok: true, version: expect.any(String) });

    const web = await call("/api/sessions", { method: "POST", jwt });
    expect(web.status).toBe(403);
    await web.body?.cancel();

    const otherToken = await call("/api/admin/status", {
      jwt: await current.sign(serviceClaims({ common_name: "someone-elses-token" })),
    });
    expect(otherToken.status).toBe(403);
    await otherToken.body?.cancel();
  });

  it("refuses the local skip flag anywhere but a local host", async () => {
    const skipEnv = { ...accessEnv, MIPI_ACCESS_SKIP: "1" } as Env;
    const deployed = await call("/api/sessions", { method: "POST" }, skipEnv);
    expect(deployed.status).toBe(500);
    expect(((await deployed.json()) as { error: string }).error).toContain("MIPI_ACCESS_SKIP");

    const local = await worker.fetch(
      new Request("http://localhost:5173/api/sessions", { method: "POST" }),
      skipEnv,
    );
    expect(local.status).toBe(200);
    await local.body?.cancel();
  });
});
