/**
 * The vault core (COD-255): keys, lock state, policy checks before decrypting, redirects, the scrubber, the ask
 * decision and the hash-chained audit. The Vault runs on a real Durable Object's SQLite; outbound requests are faked.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import {
  askDecision,
  checkPolicy,
  headerRefusal,
  methodRefusal,
  pathMatches,
  type SecretPolicy,
  urlRefusal,
  valueRefusal,
  categoryRefusal,
} from "../src/agent/vault-policy.ts";
import { scrub, scrubPattern } from "../src/agent/vault-scrub.ts";
import {
  askFacts,
  createVaultProviders,
  readVaultRows,
  resolveBotId,
  type SecretCall,
  type SecretCaller,
  Vault,
  VAULT_TABLES,
  vaultOf,
} from "../src/agent/vault.ts";
import { parseVaultKey, toBase64, vaultKeyFingerprint } from "../src/lib/vault-key.ts";
import { vaultDeployCheck } from "../scripts/vault-check.ts";
import { composeMipi } from "../src/agent/composition.ts";
import { createBot, createCobot } from "../src/agent/bots.ts";
import { PROFILES } from "./mipi.ts";
import { obj } from "../src/agent/pi/schema.ts";
import type { ToolRegistration } from "../src/agent/pi/durable.ts";
import { boundConversation } from "../src/agent/conversations.ts";
import { BUILT_IN_EXTENSIONS } from "../src/extensions/builtins.ts";
import { PROFILE_TABLE } from "../src/extensions/profiles.ts";
import worker from "../src/worker/index.ts";

const ctx = BACKGROUND_CONTEXT;
const KEY_A = toBase64(new Uint8Array(32).fill(7));
const KEY_B = toBase64(new Uint8Array(32).fill(9));
const SECRET = "ghp_TestSecretValue1234567890abcdef";
const BOT = 41;

const POLICY = {
  botAccess: "auto",
  bots: [BOT],
  hosts: ["api.github.com"],
  methods: ["GET", "HEAD", "POST", "DELETE"],
  paths: ["/repos/pilppilo"],
  inject: { header: "Authorization", template: "Bearer {}" },
} as const;

const OWNER_FACTS = { untrustedRun: false, nonOwnerInput: false, automated: false };
const caller = (overrides: Partial<SecretCaller> = {}): SecretCaller => ({
  conversationId: BOT,
  botId: BOT,
  tool: "secret_get",
  facts: OWNER_FACTS,
  ...overrides,
});
const get = (id: string, url: string, overrides: Partial<SecretCall> = {}): SecretCall => ({
  secretId: id,
  intent: "read",
  method: "GET",
  url,
  ...overrides,
});

const policy = (overrides: Record<string, unknown> = {}): SecretPolicy => {
  const checked = checkPolicy({ ...POLICY, ...overrides });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.policy;
};

type Sent = { readonly url: string; readonly method: string; readonly headers: Headers };

/** A fresh object's SQLite without the vault tables its own start made. */
function withSql<T>(owner: string, run: (sql: SqlStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(env.AGENT.getByName(owner), async (_instance, state) => {
    for (const table of VAULT_TABLES) state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    return run(state.storage.sql);
  });
}

/** A vault on `sql` whose requests go to `answer`, opened with KEY_A, holding one GitHub token. */
async function seeded(
  sql: SqlStorage,
  answer: (request: Request) => Response | Promise<Response> = () => new Response("ok"),
  overrides: Record<string, unknown> = {},
) {
  const sent: Sent[] = [];
  const vault = new Vault(sql, {
    fetch: async (request) => {
      sent.push({ url: request.url, method: request.method, headers: request.headers });
      return answer(request);
    },
  });
  await vault.open({ current: KEY_A, previous: undefined });
  expect(vault.lock).toEqual({ state: "open" });
  const saved = await vault.saveBotSecret({
    category: "token",
    name: "GitHub token",
    policy: { ...POLICY, ...overrides },
    value: SECRET,
  });
  if (!saved.ok) throw new Error(saved.reason);
  return { vault, id: saved.id, sent };
}

describe("vault keys", () => {
  it("reads a lane key: unset, invalid or 32 bytes", async () => {
    expect(parseVaultKey(undefined)).toEqual({ kind: "unset" });
    expect(parseVaultKey("off")).toEqual({ kind: "unset" });
    expect(parseVaultKey("  ")).toEqual({ kind: "unset" });
    expect(parseVaultKey("not base64!").kind).toBe("invalid");
    expect(parseVaultKey(toBase64(new Uint8Array(16))).kind).toBe("invalid");
    const key = parseVaultKey(KEY_A);
    expect(key.kind).toBe("key");
    const fingerprint = await vaultKeyFingerprint(new Uint8Array(32).fill(7));
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint).not.toBe(await vaultKeyFingerprint(new Uint8Array(32).fill(9)));
  });

  it("makes the tables and a data key on first open, and stores only ciphertext", async () => {
    await withSql("vault-first-open", async (sql) => {
      const { vault, id } = await seeded(sql);
      const row = sql
        .exec<{ ciphertext: ArrayBuffer; name: string; policy: string }>(
          "SELECT ciphertext, name, policy FROM app_vault_items WHERE id = ?",
          id,
        )
        .one();
      const stored = new TextDecoder("latin1").decode(row.ciphertext);
      expect(stored).not.toContain(SECRET);
      expect(row.name).toBe("GitHub token");
      expect(JSON.parse(row.policy).hosts).toEqual(["api.github.com"]);
      const keys = sql.exec("SELECT * FROM app_vault_keys").toArray();
      expect(keys).toHaveLength(1);
      expect(JSON.stringify(keys)).not.toContain(KEY_A);
      expect(vault.status()).toMatchObject({
        state: "open",
        keyFingerprint: await vaultKeyFingerprint(new Uint8Array(32).fill(7)),
        rows: { personal: 0, bot: 1, audit: 0 },
      });
      // name, hint and policy are nullable from day one: personal rows store NULL.
      vault.putPersonal({
        category: "login",
        ciphertext: new Uint8Array([1, 2, 3]),
        iv: new Uint8Array(12),
        keyVersion: 1,
      });
      const personal = sql
        .exec<{ name: null; hint: null; policy: null }>(
          "SELECT name, hint, policy FROM app_vault_items WHERE tier = 'personal'",
        )
        .one();
      expect(personal).toEqual({ name: null, hint: null, policy: null });
      expect(readVaultRows(sql).rows).toEqual({ personal: 1, bot: 1, audit: 0 });
    });
  });

  it("locks the vault alone when the key is missing, invalid or wrong, and refuses every use with the reason", async () => {
    await withSql("vault-locks", async (sql) => {
      const { id } = await seeded(sql);
      for (const [keys, reason] of [
        [{ current: undefined, previous: undefined }, "MIPI_VAULT_KEY is not set"],
        [{ current: "off", previous: undefined }, "MIPI_VAULT_KEY is not set"],
        [{ current: "abc", previous: undefined }, "MIPI_VAULT_KEY is not base64"],
        [
          { current: KEY_B, previous: undefined },
          "MIPI_VAULT_KEY doesn't match the key this lane's bot secrets were saved with",
        ],
      ] as const) {
        const vault = new Vault(sql, { fetch: () => Promise.reject(new Error("never sent")) });
        await vault.open(keys);
        expect(vault.lock).toEqual({ state: "locked", reason });
        expect(
          await vault.fetchWithSecret(
            get(id, "https://api.github.com/repos/pilppilo/mipi"),
            caller(),
          ),
        ).toEqual({
          kind: "refused",
          reason: `locked: ${reason}`,
        });
      }
      // The right key opens it again: nothing was changed by the locked opens.
      const vault = new Vault(sql, { fetch: async () => new Response("ok") });
      await vault.open({ current: KEY_A, previous: undefined });
      expect(vault.lock.state).toBe("open");
    });
  });

  it("rotates with MIPI_VAULT_KEY_PREVIOUS: rewraps the data key, after which the old key alone is refused", async () => {
    await withSql("vault-rotate", async (sql) => {
      const { id } = await seeded(sql);
      const rotated = new Vault(sql, { fetch: async () => new Response("ok") });
      await rotated.open({ current: KEY_B, previous: KEY_A });
      expect(rotated.lock.state).toBe("open");
      expect(rotated.status().keyFingerprint).toBe(
        await vaultKeyFingerprint(new Uint8Array(32).fill(9)),
      );
      const result = await rotated.fetchWithSecret(
        get(id, "https://api.github.com/repos/pilppilo/mipi"),
        caller(),
      );
      expect(result.kind).toBe("response");

      const after = new Vault(sql, { fetch: async () => new Response("ok") });
      await after.open({ current: KEY_B, previous: undefined });
      expect(after.lock.state).toBe("open");
      const old = new Vault(sql);
      await old.open({ current: KEY_A, previous: undefined });
      expect(old.lock.state).toBe("locked");
    });
  });

  it("replaces the data key when no bot secret depends on it", async () => {
    await withSql("vault-empty-rekey", async (sql) => {
      const first = new Vault(sql);
      await first.open({ current: KEY_A, previous: undefined });
      const second = new Vault(sql);
      await second.open({ current: KEY_B, previous: undefined });
      expect(second.lock.state).toBe("open");
    });
  });

  it("binds ciphertext to its row: a value moved to another row doesn't decrypt", async () => {
    await withSql("vault-aad", async (sql) => {
      const { vault, id } = await seeded(sql);
      const other = await vault.saveBotSecret({
        category: "token",
        name: "Other",
        policy: POLICY,
        value: "another-secret-value",
      });
      if (!other.ok) throw new Error(other.reason);
      sql.exec(
        `UPDATE app_vault_items SET ciphertext = (SELECT ciphertext FROM app_vault_items WHERE id = ?),
           iv = (SELECT iv FROM app_vault_items WHERE id = ?) WHERE id = ?`,
        id,
        id,
        other.id,
      );
      expect(
        await vault.fetchWithSecret(
          get(other.id, "https://api.github.com/repos/pilppilo/x"),
          caller(),
        ),
      ).toEqual({
        kind: "refused",
        reason: "the stored secret doesn't decrypt",
      });
    });
  });
});

describe("saving bot secrets", () => {
  it("refuses short values, personal-only categories and invalid policies", async () => {
    expect(valueRefusal("short")).toMatch(/at least 8/);
    expect(valueRefusal("12345678")).toBeUndefined();
    for (const category of ["payment", "login", "contact"])
      expect(categoryRefusal(category)).toMatch(/personal only/);
    expect(categoryRefusal("token")).toBeUndefined();

    await withSql("vault-save-refusals", async (sql) => {
      const vault = new Vault(sql);
      await vault.open({ current: KEY_A, previous: undefined });
      const save = (overrides: Record<string, unknown>) =>
        vault.saveBotSecret({
          category: "token",
          name: "X",
          policy: POLICY,
          value: SECRET,
          ...overrides,
        });
      expect(await save({ value: "1234567" })).toMatchObject({ ok: false });
      expect(await save({ category: "payment" })).toMatchObject({ ok: false });
      expect(await save({ provider: "bitwarden" })).toEqual({
        ok: false,
        reason: 'the provider "bitwarden" isn\'t installed',
      });
      expect(await save({ policy: { ...POLICY, hosts: [] } })).toMatchObject({ ok: false });
      expect(await save({ policy: { ...POLICY, hosts: ["*.github.com"] } })).toMatchObject({
        ok: false,
      });
      expect(await save({ policy: { ...POLICY, hosts: ["127.0.0.1"] } })).toMatchObject({
        ok: false,
      });
      expect(await save({ policy: { ...POLICY, hosts: ["printer.local"] } })).toMatchObject({
        ok: false,
      });
      expect(await save({ policy: { ...POLICY, botAccess: "always" } })).toMatchObject({
        ok: false,
      });
      expect(
        await save({ policy: { ...POLICY, inject: { header: "Host", template: "{}" } } }),
      ).toMatchObject({
        ok: false,
      });
      expect(
        await save({ policy: { ...POLICY, inject: { header: "X-Key", template: "no slot" } } }),
      ).toMatchObject({ ok: false });
      expect(await save({ policy: { ...POLICY, paths: ["/repos/%2e%2e"] } })).toMatchObject({
        ok: false,
      });
      expect(await save({})).toMatchObject({ ok: true });
    });
  });

  it("normalizes a policy: lowercase hosts without trailing dots, deduplicated lists, port 443 left out", () => {
    expect(
      checkPolicy({
        ...POLICY,
        hosts: ["API.GitHub.com.", "api.github.com"],
        methods: ["GET", "GET"],
        bots: [BOT, BOT],
        port: 443,
        paths: ["/repos/pilppilo/"],
      }),
    ).toEqual({
      ok: true,
      policy: {
        botAccess: "auto",
        bots: [BOT],
        hosts: ["api.github.com"],
        methods: ["GET"],
        paths: ["/repos/pilppilo"],
        inject: { header: "Authorization", template: "Bearer {}" },
      },
    });
  });
});

describe("request checks before decrypting", () => {
  const rules = policy();
  const refused = (address: string, rule: SecretPolicy = rules) => {
    const result = urlRefusal(address, rule, ["mipi.example.workers.dev"]);
    return result.kind === "refused" ? result.reason : undefined;
  };

  it("matches paths on whole segments", () => {
    expect(pathMatches("/repos/pilppilo", "/repos/pilppilo")).toBe(true);
    expect(pathMatches("/repos/pilppilo/mipi", "/repos/pilppilo")).toBe(true);
    expect(pathMatches("/repos/pilppilo-other", "/repos/pilppilo")).toBe(false);
    expect(pathMatches("/anything", "/")).toBe(true);
    expect(refused("https://api.github.com/repos/pilppilo/mipi")).toBeUndefined();
    expect(refused("https://api.github.com/repos/pilppilo-other/x")).toMatch(/not a path/);
  });

  it("refuses other hosts, ports, schemes, credentials, IPs and MiPi's own host", () => {
    expect(refused("https://evil.example/repos/pilppilo")).toMatch(/not a host/);
    expect(refused("https://api.github.com.evil.example/repos/pilppilo")).toMatch(/not a host/);
    expect(refused("http://api.github.com/repos/pilppilo")).toMatch(/only https/);
    expect(refused("https://api.github.com:8443/repos/pilppilo")).toMatch(/port 8443/);
    expect(refused("https://user:pw@api.github.com/repos/pilppilo")).toMatch(/username/);
    expect(refused("https://140.82.112.6/repos/pilppilo")).toMatch(/IP/);
    expect(
      refused("https://mipi.example.workers.dev/", policy({ hosts: ["mipi.example.workers.dev"] })),
    ).toMatch(/own address/);
    expect(
      refused("https://api.github.com:8443/repos/pilppilo", policy({ port: 8443 })),
    ).toBeUndefined();
    expect(refused("https://API.GITHUB.COM./repos/pilppilo")).toBeUndefined();
    expect(refused("not a url")).toBeDefined();
  });

  it("refuses traversal and encoded separators, as written and after parsing", () => {
    for (const address of [
      "https://api.github.com/repos/pilppilo/../other",
      "https://api.github.com/repos/pilppilo/./x",
      "https://api.github.com/repos/pilppilo/%2e%2e/other",
      "https://api.github.com/repos/pilppilo/%2E%2E/other",
      "https://api.github.com/repos/pilppilo%2fother",
      "https://api.github.com/repos/pilppilo%2Fother",
      "https://api.github.com/repos/pilppilo%5cother",
      "https://api.github.com/repos/pilppilo\\..\\other",
    ]) {
      expect(refused(address), address).toBeDefined();
    }
    // `URL` drops tabs and newlines and trims spaces before it resolves dot segments: refused as written.
    for (const address of [
      "https://api.github.com/repos/other/.\t./pilppilo/mipi",
      "https://api.github.com/repos/other/.\n./pilppilo/mipi",
      "https://api.github.com/repos/other/.\r./pilppilo/mipi",
      "https://api.github.com/repos/pilppilo/.. ",
      " https://api.github.com/repos/pilppilo/mipi",
      "https://api.github.com/repos/pilppilo/a b",
      "https://api.github.com/repos/pilppilo/\u0000x",
      "https://api.github.com/repos/pilppilo/\u007fx",
    ]) {
      expect(refused(address), JSON.stringify(address)).toBe(
        "control characters and spaces are refused",
      );
    }
    // A query may hold encoded slashes: only the path is checked.
    expect(refused("https://api.github.com/repos/pilppilo/mipi?next=%2Fa")).toBeUndefined();
  });

  it("refuses methods outside the policy or the tool's intent", () => {
    expect(methodRefusal("GET", "read", rules)).toBeUndefined();
    expect(methodRefusal("POST", "read", rules)).toMatch(/changes data/);
    expect(methodRefusal("GET", "change", rules)).toMatch(/only reads/);
    expect(methodRefusal("PUT", "change", rules)).toMatch(/not allowed/);
    expect(methodRefusal("TRACE", "change", rules)).toMatch(/not a method/);
  });

  it("refuses headers the model may never set, the secret's own among them", () => {
    expect(headerRefusal({ Accept: "application/json" }, rules)).toBeUndefined();
    for (const name of [
      "Authorization",
      "cookie",
      "Host",
      "Proxy-Authorization",
      "Content-Length",
    ]) {
      expect(headerRefusal({ [name]: "x" }, rules), name).toBeDefined();
    }
    expect(
      headerRefusal(
        { "X-Api-Key": "x" },
        policy({ inject: { header: "X-Api-Key", template: "{}" } }),
      ),
    ).toMatch(/can't be set/);
    expect(headerRefusal({ "X-A": "a\r\nInjected: 1" }, rules)).toMatch(/line breaks/);
  });
});

describe("the ask decision", () => {
  it("always asks for a change, asks under approve, and under auto only for untrusted, non-owner or automated runs", () => {
    expect(askDecision("auto", "change", OWNER_FACTS)).toBe("ask");
    expect(askDecision("approve", "read", OWNER_FACTS)).toBe("ask");
    expect(askDecision("auto", "read", OWNER_FACTS)).toBe("allow");
    expect(askDecision("auto", "read", { ...OWNER_FACTS, untrustedRun: true })).toBe("ask");
    expect(askDecision("auto", "read", { ...OWNER_FACTS, nonOwnerInput: true })).toBe("ask");
    expect(askDecision("auto", "read", { ...OWNER_FACTS, automated: true })).toBe("ask");
  });
});

describe("the scrubber", () => {
  it("replaces the value raw, JSON-escaped, percent-encoded in any case, and as base64 and base64url", () => {
    const value = "tok/en+val=ue?1234";
    const pattern = scrubPattern(value);
    const bytes = new TextEncoder().encode(value);
    const b64 = toBase64(bytes);
    const b64url = b64.replaceAll("+", "-").replaceAll("/", "_");
    for (const form of [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      encodeURIComponent(value)
        .toLowerCase()
        .replace(/[a-z]/g, (c) => c), // lowercase hex digits
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
      [...bytes].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
      b64,
      b64.replace(/=+$/, ""),
      b64url,
      b64url.replace(/=+$/, ""),
    ]) {
      const scrubbed = scrub(`before ${form} after`, pattern, "sec_1");
      expect(scrubbed, form).toBe("before [REDACTED:sec_1] after");
    }
    expect(scrub("nothing here", pattern, "sec_1")).toBe("nothing here");
  });
});

describe("fetchWithSecret", () => {
  it("sends the value only in the policy's header, and scrubs it from the body, headers and URL echoes", async () => {
    await withSql("vault-send", async (sql) => {
      const { vault, id, sent } = await seeded(sql, (request) =>
        Response.json(
          { echoed: request.headers.get("Authorization"), b64: btoa(SECRET) },
          { headers: { "X-Echo": SECRET, "Set-Cookie": "session=abc" } },
        ),
      );
      const result = await vault.fetchWithSecret(
        get(id, "https://api.github.com/repos/pilppilo/mipi", {
          headers: { Accept: "application/json" },
        }),
        caller(),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
      expect(sent[0]!.headers.get("Accept")).toBe("application/json");
      expect(sent[0]!.url).not.toContain(SECRET);
      expect(result.kind).toBe("response");
      if (result.kind !== "response") return;
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain(btoa(SECRET));
      expect(JSON.parse(result.body)).toEqual({
        echoed: `Bearer [REDACTED:${id}]`,
        b64: `[REDACTED:${id}]`,
      });
      expect(result.headers.find(([name]) => name === "x-echo")?.[1]).toBe(`[REDACTED:${id}]`);
      expect(result.headers.some(([name]) => name === "set-cookie")).toBe(false);
    });
  });

  it("puts a value holding $& or $$ in the header exactly as saved", async () => {
    await withSql("vault-dollar", async (sql) => {
      const value = "tok$&en$$x$'y$`z$1";
      const sent: Headers[] = [];
      const vault = new Vault(sql, {
        fetch: async (request) => {
          sent.push(request.headers);
          return new Response(`echo ${request.headers.get("Authorization")}`);
        },
      });
      await vault.open({ current: KEY_A, previous: undefined });
      const saved = await vault.saveBotSecret({
        category: "token",
        name: "Dollar",
        policy: POLICY,
        value,
      });
      if (!saved.ok) throw new Error(saved.reason);
      const result = await vault.fetchWithSecret(
        get(saved.id, "https://api.github.com/repos/pilppilo/x"),
        caller(),
      );
      expect(sent[0]!.get("Authorization")).toBe(`Bearer ${value}`);
      expect(result).toMatchObject({
        kind: "response",
        body: `echo Bearer [REDACTED:${saved.id}]`,
      });
    });
  });

  it("refuses before decrypting: unknown, personal, none, other bots, expired and a missing provider", async () => {
    await withSql("vault-refusals", async (sql) => {
      const { vault, id, sent } = await seeded(sql);
      const url = "https://api.github.com/repos/pilppilo/mipi";
      expect(
        await vault.fetchWithSecret(get("sec_000000000000000000000000", url), caller()),
      ).toEqual({
        kind: "refused",
        reason: "no such secret",
      });
      expect((await vault.fetchWithSecret(get("not-an-id", url), caller())).kind).toBe("refused");
      const personal = vault.putPersonal({
        category: "login",
        ciphertext: new Uint8Array(4),
        iv: new Uint8Array(12),
        keyVersion: 1,
      });
      expect(await vault.fetchWithSecret(get(personal, url), caller())).toMatchObject({
        reason: expect.stringMatching(/personal/),
      });
      // Other bots, and a chat from before bots, match no grant.
      expect(await vault.fetchWithSecret(get(id, url), caller({ botId: 99 }))).toMatchObject({
        reason: "this bot may not use GitHub token",
      });
      expect(await vault.fetchWithSecret(get(id, url), caller({ botId: undefined }))).toMatchObject(
        {
          kind: "refused",
        },
      );
      expect(vault.updatePolicy(id, { ...POLICY, botAccess: "none" })).toEqual({ ok: true });
      expect(await vault.fetchWithSecret(get(id, url), caller())).toMatchObject({
        reason: "GitHub token is not usable by the assistant",
      });
      expect(vault.updatePolicy(id, { ...POLICY, expiresAt: 1 })).toEqual({ ok: true });
      expect(await vault.fetchWithSecret(get(id, url), caller())).toMatchObject({
        reason: "GitHub token has expired",
      });
      vault.updatePolicy(id, POLICY);
      sql.exec("UPDATE app_vault_items SET provider = 'gone' WHERE id = ?", id);
      expect(await vault.fetchWithSecret(get(id, url), caller())).toMatchObject({
        reason: "GitHub token's provider \"gone\" isn't installed",
      });
      sql.exec(
        "UPDATE app_vault_items SET provider = 'mipi', policy = '{\"botAccess\":1}' WHERE id = ?",
        id,
      );
      expect(await vault.fetchWithSecret(get(id, url), caller())).toMatchObject({
        reason: expect.stringMatching(/unreadable/),
      });
      expect(sent).toHaveLength(0);
    });
  });

  it("asks when the decision says so, and sends only once approved", async () => {
    await withSql("vault-ask", async (sql) => {
      const { vault, id, sent } = await seeded(sql);
      const url = "https://api.github.com/repos/pilppilo/mipi/issues/1";
      const call = get(id, url);
      expect(
        await vault.fetchWithSecret(
          call,
          caller({ facts: { ...OWNER_FACTS, untrustedRun: true } }),
        ),
      ).toEqual({
        kind: "ask",
        secretName: "GitHub token",
        method: "GET",
        host: "api.github.com",
        path: "/repos/pilppilo/mipi/issues/1",
      });
      const change: SecretCall = { ...call, intent: "change", method: "DELETE" };
      expect((await vault.fetchWithSecret(change, caller())).kind).toBe("ask");
      expect(sent).toHaveLength(0);
      expect((await vault.fetchWithSecret(change, caller(), { approved: true })).kind).toBe(
        "response",
      );
      expect(sent.map(({ method }) => method)).toEqual(["DELETE"]);
      await vault.recordDenied(change, caller(), "Denied by the owner.");
      expect(vault.readAudit().map(({ decision }) => decision)).toEqual(["approved", "denied"]);
    });
  });

  it("follows redirects by hand for reads, checks every hop, and never sends the secret to another host", async () => {
    await withSql("vault-redirects", async (sql) => {
      const hops: Record<string, Response | (() => Response)> = {};
      const { vault, id, sent } = await seeded(sql, (request) => {
        const answer = hops[request.url];
        if (answer === undefined) return new Response("final");
        return typeof answer === "function" ? answer() : answer;
      });
      const redirect = (location: string) => () =>
        new Response(null, { status: 302, headers: { Location: location } });
      hops["https://api.github.com/repos/pilppilo/a"] = redirect("/repos/pilppilo/b");
      const followed = await vault.fetchWithSecret(
        get(id, "https://api.github.com/repos/pilppilo/a"),
        caller(),
      );
      expect(followed).toMatchObject({
        kind: "response",
        body: "final",
        url: "https://api.github.com/repos/pilppilo/b",
      });
      expect(sent.map(({ url }) => url)).toEqual([
        "https://api.github.com/repos/pilppilo/a",
        "https://api.github.com/repos/pilppilo/b",
      ]);

      sent.length = 0;
      hops["https://api.github.com/repos/pilppilo/out"] = redirect("https://evil.example/steal");
      expect(
        await vault.fetchWithSecret(get(id, "https://api.github.com/repos/pilppilo/out"), caller()),
      ).toEqual({
        kind: "failed",
        reason: "it redirects to evil.example; the secret was not sent there",
      });
      expect(sent.map(({ url }) => url)).toEqual(["https://api.github.com/repos/pilppilo/out"]);

      hops["https://api.github.com/repos/pilppilo/up"] = redirect("/repos/other");
      expect(
        await vault.fetchWithSecret(get(id, "https://api.github.com/repos/pilppilo/up"), caller()),
      ).toMatchObject({
        kind: "failed",
        reason: expect.stringMatching(/not a path/),
      });
      hops["https://api.github.com/repos/pilppilo/enc"] = redirect("/repos/pilppilo/%2e%2e/other");
      expect(
        await vault.fetchWithSecret(get(id, "https://api.github.com/repos/pilppilo/enc"), caller()),
      ).toMatchObject({
        kind: "failed",
        reason: expect.stringMatching(/encoded/),
      });
      hops["https://api.github.com/repos/pilppilo/tab"] = redirect("/repos/other/.\t./pilppilo/b");
      expect(
        await vault.fetchWithSecret(get(id, "https://api.github.com/repos/pilppilo/tab"), caller()),
      ).toEqual({
        kind: "failed",
        reason: "it redirects to a refused address: control characters and spaces are refused",
      });
      hops["https://api.github.com/repos/pilppilo/loop"] = redirect("/repos/pilppilo/loop");
      expect(
        await vault.fetchWithSecret(
          get(id, "https://api.github.com/repos/pilppilo/loop"),
          caller(),
        ),
      ).toEqual({
        kind: "failed",
        reason: "more than 3 redirects",
      });

      // A change gets the redirect back, unfollowed.
      sent.length = 0;
      hops["https://api.github.com/repos/pilppilo/post"] = redirect("/repos/pilppilo/b");
      const posted = await vault.fetchWithSecret(
        {
          ...get(id, "https://api.github.com/repos/pilppilo/post"),
          intent: "change",
          method: "POST",
          body: "{}",
        },
        caller(),
        { approved: true },
      );
      expect(posted).toMatchObject({ kind: "response", status: 302 });
      expect(sent).toHaveLength(1);
    });
  });

  it("scrubs a failure's text and times out with a clear reason", async () => {
    await withSql("vault-failures", async (sql) => {
      const { vault, id } = await seeded(sql, () => {
        throw new Error(`connection reset while sending ${SECRET}`);
      });
      const result = await vault.fetchWithSecret(
        get(id, "https://api.github.com/repos/pilppilo/x"),
        caller(),
      );
      expect(result).toEqual({
        kind: "failed",
        reason: `connection reset while sending [REDACTED:${id}]`,
      });
      const audit = vault.readAudit();
      expect(JSON.stringify(audit)).not.toContain(SECRET);

      const slow = new Vault(sql, {
        timeoutMs: 20,
        fetch: (request) =>
          new Promise((_, reject) =>
            request.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      });
      await slow.open({ current: KEY_A, previous: undefined });
      expect(
        await slow.fetchWithSecret(get(id, "https://api.github.com/repos/pilppilo/x"), caller()),
      ).toEqual({
        kind: "failed",
        reason: "no full answer within 0 seconds",
      });
    });
  });

  it("resolves a provider's reference at send time, and never stores what it resolved", async () => {
    await withSql("vault-provider", async (sql) => {
      const resolved: string[] = [];
      const providers = createVaultProviders([
        {
          owner: "test-store",
          registration: {
            provider: "test-store",
            label: "Test store",
            resolve: async (reference) => {
              resolved.push(reference);
              return SECRET;
            },
          },
        },
      ]);
      const sent: Headers[] = [];
      const vault = new Vault(sql, {
        providers,
        fetch: async (request) => {
          sent.push(request.headers);
          return new Response(`echo ${SECRET}`);
        },
      });
      await vault.open({ current: KEY_A, previous: undefined });
      const saved = await vault.saveBotSecret({
        category: "token",
        name: "Stored elsewhere",
        policy: POLICY,
        value: "ref-123",
        provider: "test-store",
      });
      if (!saved.ok) throw new Error(saved.reason);
      const result = await vault.fetchWithSecret(
        get(saved.id, "https://api.github.com/repos/pilppilo/x"),
        caller(),
      );
      expect(resolved).toEqual(["ref-123"]);
      expect(sent[0]!.get("Authorization")).toBe(`Bearer ${SECRET}`);
      expect(result).toMatchObject({ kind: "response", body: `echo [REDACTED:${saved.id}]` });
      expect(
        sql.exec("SELECT count(*) AS n FROM app_vault_items WHERE provider = 'test-store'").one().n,
      ).toBe(1);
    });
  });

  it("refuses when a provider doesn't answer within the deadline", async () => {
    await withSql("vault-provider-timeout", async (sql) => {
      const providers = createVaultProviders([
        {
          owner: "slow",
          registration: {
            provider: "slow",
            label: "Slow store",
            resolve: () => new Promise(() => {}),
          },
        },
      ]);
      const sent: string[] = [];
      const vault = new Vault(sql, {
        providers,
        timeoutMs: 20,
        fetch: async (request) => {
          sent.push(request.url);
          return new Response("ok");
        },
      });
      await vault.open({ current: KEY_A, previous: undefined });
      const saved = await vault.saveBotSecret({
        category: "token",
        name: "Slow",
        policy: POLICY,
        value: "ref",
        provider: "slow",
      });
      if (!saved.ok) throw new Error(saved.reason);
      expect(
        await vault.fetchWithSecret(
          get(saved.id, "https://api.github.com/repos/pilppilo/x"),
          caller(),
        ),
      ).toEqual({ kind: "refused", reason: "Slow store couldn't resolve Slow" });
      expect(sent).toEqual([]);
    });
  });

  it("refuses a provider registered twice, or one named mipi", () => {
    const registration = { provider: "x", label: "X", resolve: async () => "" };
    expect(() =>
      createVaultProviders([
        { owner: "a", registration },
        { owner: "b", registration },
      ]),
    ).toThrow(/registered by both/);
    expect(() =>
      createVaultProviders([{ owner: "a", registration: { ...registration, provider: "mipi" } }]),
    ).toThrow(/built in/);
  });
});

describe("the audit", () => {
  it("records every use and refusal with the calling conversation, hash-chained, and shows an edit or a gap", async () => {
    await withSql("vault-audit", async (sql) => {
      const { vault, id } = await seeded(sql);
      const url = "https://api.github.com/repos/pilppilo/mipi?token=not-logged";
      await vault.fetchWithSecret(get(id, url), caller());
      await vault.fetchWithSecret(get(id, url), caller({ botId: 99, conversationId: 99 }));
      await Promise.all([
        vault.fetchWithSecret(get(id, url), caller({ conversationId: 7 })),
        vault.fetchWithSecret(get(id, url), caller({ conversationId: 8 })),
      ]);
      const rows = vault.readAudit();
      expect(
        rows.map(({ id: rowId, decision, conversationId }) => [rowId, decision, conversationId]),
      ).toEqual([
        [1, "allowed", BOT],
        [2, "refused", 99],
        [3, "allowed", 7],
        [4, "allowed", 8],
      ]);
      expect(rows[0]).toMatchObject({
        secretId: id,
        tool: "secret_get",
        method: "GET",
        host: "api.github.com",
        path: "/repos/pilppilo/mipi",
        status: 200,
      });
      expect(JSON.stringify(rows)).not.toContain("not-logged");
      expect(await vault.verifyAudit()).toEqual({ ok: true, rows: 4 });

      sql.exec("UPDATE app_vault_audit SET decision = 'allowed' WHERE id = 2");
      expect(await vault.verifyAudit()).toEqual({ ok: false, at: 2 });
      sql.exec("UPDATE app_vault_audit SET decision = 'refused' WHERE id = 2");
      expect(await vault.verifyAudit()).toEqual({ ok: true, rows: 4 });
      sql.exec("DELETE FROM app_vault_audit WHERE id = 3");
      expect(await vault.verifyAudit()).toEqual({ ok: false, at: 3 });
    });
  });
});

describe("who is calling", () => {
  it("resolves MiPi and purpose bots to themselves, cobots to their bot, and chats from before bots to none", async () => {
    const composition = composeMipi({ extensions: [] });
    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      const { main, bot } = await harness.commit(
        async (tx) => ({
          main: await createBot(
            tx,
            { kind: "main", name: "MiPi", profile: "main", createdBy: "owner" },
            PROFILES,
          ),
          bot: await createBot(
            tx,
            {
              kind: "bot",
              name: "Helper",
              purpose: "Help.",
              profile: "default",
              createdBy: "owner",
            },
            PROFILES,
          ),
        }),
        ctx,
      );
      const cobot = await harness.commit((tx) => createCobot(tx, bot, "side", PROFILES), ctx);
      const plain = await harness.commit(
        async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
        ctx,
      );
      const ids = { main, bot, cobot, plain };
      const resolved = await harness.commit(
        async (tx) => ({
          main: await resolveBotId(tx, ids.main),
          bot: await resolveBotId(tx, ids.bot),
          cobot: await resolveBotId(tx, ids.cobot),
          plain: await resolveBotId(tx, ids.plain),
        }),
        ctx,
      );
      expect(resolved).toEqual({ main: ids.main, bot: ids.bot, cobot: ids.bot, plain: undefined });
    } finally {
      await harness.close(ctx);
    }
  });

  it("gives tools no vault in a composition that made none", () => {
    const composition = composeMipi({ extensions: [] });
    const registry = {
      extension: (name: string) => composition.extensions.installed.find((e) => e.name === name),
    };
    expect(() => vaultOf(registry)).toThrow(/no vault/);
  });
});

describe("the agent's vault", () => {
  it("opens with the lane key and shows its state, fingerprint and counts in the admin status", async () => {
    const response = await worker.fetch(
      new Request("https://mipi.example/api/admin/status", {
        headers: { Authorization: "Bearer test-admin-token" },
      }),
      { ...env, MIPI_OWNER: "vault-admin-status" } as unknown as Env,
    );
    const status = (await response.json()) as { vault: unknown; rows: Record<string, number> };
    expect(status.vault).toEqual({
      state: "open",
      keyFingerprint: await vaultKeyFingerprint(
        Uint8Array.from({ length: 32 }, (_, index) => index),
      ),
      rows: { personal: 0, bot: 0, audit: 0 },
    });
    // Exported like every other table.
    expect(status.rows).toMatchObject({
      app_vault_items: 0,
      app_vault_keys: 1,
      app_vault_audit: 0,
    });
  });
});

describe("the deploy's vault check", () => {
  const fingerprintA = () => vaultKeyFingerprint(new Uint8Array(32).fill(7));

  it("passes a lane with no vault or no bot secrets, and refuses a key that isn't one", async () => {
    expect(
      await vaultDeployCheck(undefined, { current: undefined, previous: undefined }),
    ).toMatchObject({ ok: true });
    expect(
      await vaultDeployCheck({ rows: { bot: 0 } }, { current: undefined, previous: undefined }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await vaultDeployCheck({ rows: { bot: 0 } }, { current: "short", previous: undefined }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await vaultDeployCheck(undefined, { current: undefined, previous: KEY_A }),
    ).toMatchObject({ ok: false });
    // A new lane (no agent, so no vault yet) still has its key's format checked.
    expect(
      await vaultDeployCheck(undefined, { current: "short", previous: undefined }),
    ).toMatchObject({ ok: false, reason: "MIPI_VAULT_KEY is not base64" });
  });

  it("refuses a lane with bot secrets and no key or the wrong key, and passes the right key or a rotation", async () => {
    const vault = { rows: { bot: 2 }, keyFingerprint: await fingerprintA() };
    expect(
      await vaultDeployCheck(vault, { current: undefined, previous: undefined }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/2 bot secrets but MIPI_VAULT_KEY is not set/),
    });
    expect(await vaultDeployCheck(vault, { current: "off", previous: undefined })).toMatchObject({
      ok: false,
    });
    expect(await vaultDeployCheck(vault, { current: KEY_B, previous: undefined })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/doesn't match/),
    });
    expect(await vaultDeployCheck(vault, { current: KEY_A, previous: undefined })).toMatchObject({
      ok: true,
    });
    expect(await vaultDeployCheck(vault, { current: KEY_B, previous: KEY_A })).toMatchObject({
      ok: true,
      message: expect.stringMatching(/rewraps/),
    });
  });
});

describe("the turn the ask decision reads", () => {
  it("reads untrusted runs, non-owner authority and automated origin from the running turn", async () => {
    const seen: unknown[] = [];
    const probeTool: ToolRegistration = {
      name: "probe",
      description: "Reads the ask facts.",
      parameters: obj({}),
      execute: async (_args, api, context) => {
        seen.push(
          await api.commit((tx) => askFacts(tx, api.registry, api.conversationId), context),
        );
        return { output: [{ type: "text" as const, text: "ok" }] };
      },
    };
    const taintTool: ToolRegistration = {
      name: "taint",
      description: "Returns untrusted text.",
      parameters: obj({}),
      execute: async () => ({ output: [{ type: "text" as const, text: "page" }] }),
    };
    const probe = defineExtension({ name: "probe", tools: [probeTool, taintTool] });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const composition = composeMipi({
      extensions: [
        ...BUILT_IN_EXTENSIONS.filter(({ name }) => name === "reminders"),
        { name: "probe", tier: "builtin", pi: probe, untrustedTools: ["taint"] },
      ],
      models,
      model: { provider: "faux", modelId: "faux-1" },
      profiles: { ...PROFILE_TABLE, default: { description: "Probe", tools: ["probe", "taint"] } },
    });
    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      const id = await harness.commit(
        (tx) => boundConversation(tx, "web", "default", composition.profiles),
        ctx,
      );
      const conversation = (await harness.conversation(id, ctx))!;
      const turn = async (requestId: string, calls: readonly string[]) => {
        faux.setResponses([
          ...calls.map((name) =>
            fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
          ),
          fauxAssistantMessage([fauxText("Done.")]),
        ]);
        const result = await (
          await conversation.submit({ type: "input", content: "go", requestId }, ctx)
        ).wait(ctx);
        expect(result.status).toBe("done");
        return seen.at(-1);
      };
      expect(await turn("web:1", ["probe"])).toEqual({
        untrustedRun: false,
        nonOwnerInput: false,
        automated: false,
      });
      expect(await turn("web:2", ["taint", "probe"])).toMatchObject({ untrustedRun: true });
      expect(await turn("relay:3", ["probe"])).toMatchObject({
        nonOwnerInput: true,
        untrustedRun: false,
      });
      expect(await turn("sched:4", ["probe"])).toMatchObject({
        automated: true,
        nonOwnerInput: true,
      });
    } finally {
      await harness.close(ctx);
    }
  });
});

describe("bot secret management", () => {
  it("rotates the value and preserves the id, creation time, audit chain and policy", async () => {
    await withSql("vault-rotate-bot-secret", async (sql) => {
      const { vault, id, sent } = await seeded(sql);
      const call = get(id, "https://api.github.com/repos/pilppilo/MiPi");
      await vault.fetchWithSecret(call, caller());
      const first = vault.botSecret(id)!;
      const before = sql
        .exec<{ iv: ArrayBuffer }>("SELECT iv FROM app_vault_items WHERE id = ?", id)
        .one().iv;
      expect(await vault.updateBotSecret(id, { value: "tiny" })).toMatchObject({
        ok: false,
        kind: "invalid",
      });
      expect(await vault.updateBotSecret(id, { provider: "other" })).toMatchObject({
        ok: false,
        kind: "invalid",
      });

      const value = "replacement-secret-value";
      expect(
        await vault.updateBotSecret(id, {
          name: "New name",
          category: "api-key",
          hint: "Read access",
          value,
        }),
      ).toMatchObject({
        ok: true,
        data: {
          item: {
            id,
            name: "New name",
            category: "api-key",
            hint: "Read access",
            policy: first.policy,
            createdAt: first.createdAt,
          },
        },
      });
      const after = sql
        .exec<{ iv: ArrayBuffer }>("SELECT iv FROM app_vault_items WHERE id = ?", id)
        .one().iv;
      expect(after.byteLength).toBe(12);
      expect([...new Uint8Array(after)]).not.toEqual([...new Uint8Array(before)]);
      await vault.fetchWithSecret(call, caller());
      expect(sent.map(({ headers }) => headers.get("authorization"))).toEqual([
        `Bearer ${SECRET}`,
        `Bearer ${value}`,
      ]);

      const page = vault.readSecretAudit(id, { limit: 1 });
      expect(page?.map(({ id }) => id)).toEqual([2]);
      expect(vault.readSecretAudit(id, { before: 2 })?.map(({ id }) => id)).toEqual([1]);
      expect(vault.lastUsedBySecret().get(id)).toBe(page?.[0]?.at);
      expect(vault.removeBotSecret(id)).toBe(true);
      expect(vault.readSecretAudit(id, { before: 1 })).toEqual([]);
      expect(await vault.verifyAudit()).toEqual({ ok: true, rows: 2 });
    });
  });

  it("edits metadata and revokes grants while locked, with personal rows excluded", async () => {
    await withSql("vault-locked-metadata", async (sql) => {
      const { vault, id } = await seeded(sql);
      const personal = vault.putPersonal({
        category: "login",
        ciphertext: new Uint8Array([1]),
        iv: new Uint8Array(12),
        keyVersion: 1,
      });
      await vault.updateBotSecret(id, { hint: "Remove me" });
      await vault.open({ current: undefined, previous: undefined });
      expect(
        await vault.updateBotSecret(id, {
          hint: null,
          policy: { ...POLICY, botAccess: "none", bots: [] },
        }),
      ).toMatchObject({ ok: true });
      expect(vault.botSecret(id)?.hint).toBeUndefined();
      expect(vault.botSecret(id)?.policy.bots).toEqual([]);
      expect(await vault.updateBotSecret(id, { value: "replacement-secret" })).toMatchObject({
        ok: false,
        kind: "locked",
        reason: expect.stringMatching(/^locked:/),
      });
      expect(await vault.updateBotSecret(personal, { name: "Personal" })).toMatchObject({
        ok: false,
        kind: "missing",
      });
      expect(vault.removeBotSecret(personal)).toBe(false);
      expect(vault.readSecretAudit(personal)).toBeUndefined();
      expect(vault.removeBotSecret(id)).toBe(true);
      expect(vault.status().rows).toMatchObject({ bot: 0, personal: 1 });
    });
  });
});
