import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, SPIKE_COOKIE } from "../src/worker/auth.ts";
import worker from "../src/worker/index.ts";
import { SPIKE_TOKEN, withSpikeToken } from "./spike.ts";

const url = (path: string) => `https://example.com${path}`;

describe("spike lock (M1, until Access)", () => {
  it("leaves only the health check open", async () => {
    const health = await exports.default.fetch(url("/api/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    for (const request of [
      new Request(url("/api/sessions"), { method: "POST" }),
      new Request(url("/api/sessions/locked"), { headers: { Upgrade: "websocket" } }),
      new Request(url("/api/spike/probe")),
      new Request(url("/api/unknown")),
    ]) {
      const response = await exports.default.fetch(request);
      expect(response.status, request.url).toBe(401);
      expect(response.webSocket).toBeNull();
      await response.body?.cancel();
    }
  });

  it("accepts the token as a Bearer header and refuses a wrong one", async () => {
    const allowed = await exports.default.fetch(
      withSpikeToken(url("/api/sessions"), { method: "POST" }),
    );
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();

    const wrong = await exports.default.fetch(
      new Request(url("/api/sessions"), {
        method: "POST",
        headers: { Authorization: `Bearer ${SPIKE_TOKEN}x` },
      }),
    );
    expect(wrong.status).toBe(401);
    await wrong.body?.cancel();
  });

  it("unlocks a browser with an HttpOnly cookie that then opens the WebSocket", async () => {
    const check = await exports.default.fetch(url("/api/unlock"));
    expect(check.status).toBe(401);
    await check.body?.cancel();

    const refused = await exports.default.fetch(
      new Request(url("/api/unlock"), { method: "POST", body: JSON.stringify({ token: "nope" }) }),
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("Set-Cookie")).toBeNull();
    await refused.body?.cancel();

    const unlocked = await exports.default.fetch(
      new Request(url("/api/unlock"), {
        method: "POST",
        body: JSON.stringify({ token: SPIKE_TOKEN }),
      }),
    );
    expect(unlocked.status).toBe(204);
    const setCookie = unlocked.headers.get("Set-Cookie") ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api"]) {
      expect(setCookie).toContain(attribute);
    }
    const cookie = setCookie.split(";")[0]!;
    expect(cookie.startsWith(`${SPIKE_COOKIE}=`)).toBe(true);

    const recheck = await exports.default.fetch(url("/api/unlock"), {
      headers: { Cookie: cookie },
    });
    expect(recheck.status).toBe(204);

    const socket = await exports.default.fetch(url("/api/sessions/jerome"), {
      headers: { Upgrade: "websocket", Cookie: `other=1; ${cookie}` },
    });
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close(1000, "done");
  });

  it("fails closed when no token is configured", async () => {
    const unconfigured = { ...env, MIPI_SPIKE_TOKEN: "" } as Env;
    const locked = await worker.fetch(
      withSpikeToken(url("/api/sessions"), { method: "POST" }),
      unconfigured,
    );
    expect(locked.status).toBe(401);

    const unlock = await worker.fetch(
      new Request(url("/api/unlock"), { method: "POST", body: JSON.stringify({ token: "" }) }),
      unconfigured,
    );
    expect(unlock.status).toBe(401);
  });

  it("compares tokens of any length", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
  });
});
