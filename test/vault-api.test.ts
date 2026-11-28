import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Vault } from "../src/agent/vault.ts";
import worker from "../src/worker/index.ts";
import type { VaultItem, VaultList } from "../src/protocol.ts";

const ORIGIN = "https://mipi.example:8443";
const ITEMS = "/api/vault/items";
const VALUE = "test-value-only-for-the-vault";
const POLICY = {
  botAccess: "none",
  bots: [],
  hosts: ["api.example.com"],
  methods: ["GET"],
  inject: { header: "Authorization", template: "Bearer {}" },
};
const INPUT = { value: VALUE, name: "Example token", category: "token", policy: POLICY };

function api(owner: string) {
  return async (
    path: string,
    {
      method = "GET",
      token = "test-spike-token",
      origin = ORIGIN,
      site = "same-origin",
      media = "application/json",
      body,
    }: {
      method?: string;
      token?: string;
      origin?: string;
      site?: string;
      media?: string;
      body?: string;
    } = {},
  ) => {
    const response = await worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(site ? { "Sec-Fetch-Site": site } : {}),
          ...(body !== undefined && media ? { "Content-Type": media } : {}),
        },
        ...(body === undefined ? {} : { body }),
      }),
      { ...env, MIPI_OWNER: owner } as unknown as Env,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Origin, Sec-Fetch-Site");
    return response;
  };
}

async function metadata<T>(response: Response, expectedStatus: number): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  const text = await response.text();
  expect(text).not.toMatch(
    /ciphertext|"iv"|keyVersion|"value"|test-value-only-for-the-vault|replacement-value-only/,
  );
  return JSON.parse(text) as T;
}

describe("the owner Vault API", () => {
  it("requires owner auth and both exact origin signals for all mutations", async () => {
    const request = api("vault-http-auth");
    expect((await request(ITEMS, { token: "" })).status).toBe(401);
    expect((await request(ITEMS, { token: "test-admin-token" })).status).toBe(401);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await request(ITEMS, { method, origin: "" })).status).toBe(403);
      expect((await request(ITEMS, { method, origin: "http://mipi.example:8443" })).status).toBe(
        403,
      );
      expect((await request(ITEMS, { method, origin: "https://mipi.example" })).status).toBe(403);
      for (const site of ["", "same-site", "cross-site", "none"]) {
        expect((await request(ITEMS, { method, site })).status).toBe(403);
      }
    }
    expect((await request("/api/vault/missing")).status).toBe(404);
  });

  it("limits bodies, requires JSON, and validates ids and audit queries", async () => {
    const request = api("vault-http-validation");
    for (const method of ["POST", "PUT", "PATCH"]) {
      expect((await request(ITEMS, { method })).status).toBe(415);
      expect((await request(ITEMS, { method, media: "text/plain", body: "{}" })).status).toBe(415);
      expect(
        (await request(ITEMS, { method, body: '"' + "x".repeat(32 * 1024) + '"' })).status,
      ).toBe(413);
      expect((await request(ITEMS, { method, body: "{" })).status).toBe(400);
    }
    expect(
      (await request(ITEMS, { method: "POST", body: JSON.stringify({ ...INPUT, value: 1 }) }))
        .status,
    ).toBe(400);
    expect(
      (await request(ITEMS, { method: "POST", body: JSON.stringify({ ...INPUT, value: "short" }) }))
        .status,
    ).toBe(400);
    expect((await request(ITEMS + "/not-an-id", { method: "DELETE" })).status).toBe(400);
    const unknown = ITEMS + "/sec_000000000000000000000000";
    for (const query of [
      "?limit=0",
      "?limit=201",
      "?limit=2&limit=3",
      "?before=-1",
      "?before=1e4",
      "?other=1",
    ]) {
      expect((await request(unknown + "/audit" + query)).status).toBe(400);
    }
    expect((await request(unknown + "/audit")).status).toBe(404);
  });

  it("creates, lists, edits, and deletes on the real DO, and retains the audit", async () => {
    const owner = "vault-http-crud";
    const request = api(owner);
    const { item } = await metadata<VaultItem>(
      await request(ITEMS, {
        method: "POST",
        media: "application/json; charset=utf-8",
        body: JSON.stringify(INPUT),
      }),
      201,
    );
    expect(item.id).toMatch(/^sec_[a-f0-9]{24}$/);
    expect(item.name).toBe(INPUT.name);
    expect(item.policy.bots).toEqual([]);
    const path = ITEMS + "/" + item.id;

    const personal = await runInDurableObject(
      env.AGENT.getByName(owner),
      async (_instance, state) => {
        const vault = new Vault(state.storage.sql);
        await vault.recordDenied(
          {
            secretId: item.id,
            intent: "read",
            method: "GET",
            url: "https://api.example.com/data?private=yes",
          },
          { conversationId: 1, tool: "secret_get" },
          "Owner denied",
        );
        return vault.putPersonal({
          category: "login",
          ciphertext: new Uint8Array([1]),
          iv: new Uint8Array(12),
          keyVersion: 1,
        });
      },
    );

    const list = await metadata<VaultList>(await request(ITEMS), 200);
    expect(list.status).toEqual({ state: "open" });
    expect(list.providers).toEqual([{ id: "mipi", label: "MiPi" }]);
    expect(list.items).toEqual([{ ...item, lastUsedAt: expect.any(Number) }]);
    for (const method of ["PATCH", "DELETE"]) {
      expect(
        (
          await request(ITEMS + "/" + personal, {
            method,
            ...(method === "PATCH" ? { body: '{"name":"Renamed"}' } : {}),
          })
        ).status,
      ).toBe(404);
    }
    expect((await request(ITEMS + "/" + personal + "/audit")).status).toBe(404);

    const updated = await metadata<VaultItem>(
      await request(path, {
        method: "PATCH",
        body: JSON.stringify({ name: "Rotated token", value: "replacement-value-only" }),
      }),
      200,
    );
    expect(updated.item).toMatchObject({
      id: item.id,
      name: "Rotated token",
      createdAt: item.createdAt,
      lastUsedAt: expect.any(Number),
    });
    expect((await request(path, { method: "DELETE" })).status).toBe(204);
    expect((await request(path, { method: "DELETE" })).status).toBe(404);
    expect((await metadata<VaultList>(await request(ITEMS), 200)).items).toEqual([]);
    const audit = await metadata<{ rows: unknown[] }>(await request(path + "/audit?limit=1"), 200);
    expect(audit.rows).toEqual([
      expect.objectContaining({ tool: "secret_get", decision: "denied", path: "/data" }),
    ]);
    expect(await metadata(await request(path + "/audit?before=1"), 200)).toEqual({ rows: [] });
  });

  it("returns a clear unavailable response during maintenance", async () => {
    const owner = "vault-http-maintenance";
    const agent = env.AGENT.getByName(owner);
    await agent.exportBegin();
    try {
      const response = await api(owner)(ITEMS);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "The agent's vault is unavailable" });
    } finally {
      await agent.exportEnd();
    }
  });
});
