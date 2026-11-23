/** The PiDu relay's HTTP door (M7 slice 2): authentication, request checks, and how results map to responses. */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RELAY_MAX_TEXT_BYTES, type RelayResult } from "../src/agent/relay.ts";
import {
  handleRelay,
  IDEMPOTENCY_HEADER,
  isRelayPath,
  MAX_RELAY_BODY_BYTES,
  type RelayAgent,
  relayResponse,
  relayTokens,
} from "../src/worker/relay.ts";
import worker from "../src/worker/index.ts";

const TOKEN = "relay-token-0123456789abcdef";
const OLD_TOKEN = "relay-token-previous-0123456789";

const relayEnv = (overrides: Record<string, string> = {}): Env =>
  ({ ...env, RELAY_TOKEN: TOKEN, ...overrides }) as Env;

const post = (
  body: string,
  headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    [IDEMPOTENCY_HEADER]: "key-1",
  },
) => new Request("https://mipi.example/api/relay", { method: "POST", body, headers });

const get = (key: string, token = TOKEN) =>
  new Request(`https://mipi.example/api/relay/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

const recordingAgent = (result: RelayResult | Error = { kind: "done", answer: "Hi" }) => {
  const calls: string[] = [];
  const answer = async (call: string) => {
    calls.push(call);
    if (result instanceof Error) throw result;
    return result;
  };
  const agent: RelayAgent = {
    relayAdmit: (key, text) => answer(`admit ${key} ${text}`),
    relayResult: (key) => answer(`result ${key}`),
  };
  return { calls, agent: () => agent };
};

const handle = (request: Request, agent: () => RelayAgent, settings: Record<string, string> = {}) =>
  handleRelay(request, relayEnv(settings), new URL(request.url).pathname, agent);

describe("relay authentication", () => {
  it("refuses a wrong or missing token, and everything while RELAY_TOKEN is unset or short", async () => {
    const { calls, agent } = recordingAgent();
    const body = JSON.stringify({ text: "hi" });
    for (const [request, settings] of [
      [post(body, { Authorization: "Bearer wrong", [IDEMPOTENCY_HEADER]: "k" }), {}],
      [post(body, { [IDEMPOTENCY_HEADER]: "k" }), {}],
      [post(body, { Authorization: TOKEN, [IDEMPOTENCY_HEADER]: "k" }), {}],
      [post(body), { RELAY_TOKEN: "" }],
      [
        post(body, { Authorization: "Bearer short", [IDEMPOTENCY_HEADER]: "k" }),
        { RELAY_TOKEN: "short" },
      ],
      [
        post(body, { Authorization: "Bearer off", [IDEMPOTENCY_HEADER]: "k" }),
        { RELAY_TOKEN: "off" },
      ],
      [get("key-1", "wrong"), {}],
    ] as const) {
      const response = await handle(request, agent, settings);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expect(calls).toEqual([]);
  });

  it("accepts the previous token only while it is set and RELAY_TOKEN is on", async () => {
    expect(relayTokens(relayEnv({ RELAY_TOKEN_PREVIOUS: OLD_TOKEN }))).toEqual([TOKEN, OLD_TOKEN]);
    expect(relayTokens(relayEnv({ RELAY_TOKEN_PREVIOUS: "off" }))).toEqual([TOKEN]);
    expect(relayTokens(relayEnv({ RELAY_TOKEN: "", RELAY_TOKEN_PREVIOUS: OLD_TOKEN }))).toEqual([]);
    const { agent } = recordingAgent();
    expect(
      (await handle(get("k", OLD_TOKEN), agent, { RELAY_TOKEN_PREVIOUS: OLD_TOKEN })).status,
    ).toBe(200);
    expect((await handle(get("k", OLD_TOKEN), agent)).status).toBe(401);
  });

  it("is routed before the owner's web authentication, for the relay's paths only", async () => {
    expect(isRelayPath("/api/relay")).toBe(true);
    expect(isRelayPath("/api/relay/abc")).toBe(true);
    expect(isRelayPath("/api/relayx")).toBe(false);
    // No spike token or Access JWT: a web route would answer 401 "Locked".
    const refused = await worker.fetch(get("k", "wrong"), relayEnv());
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "Unauthorized" });
    // Through the Worker to the real agent: a key never sent is not found.
    const unknown = await worker.fetch(get("never-sent"), relayEnv());
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/relay", () => {
  it("admits the text under its key and answers 200 with the answer", async () => {
    const { calls, agent } = recordingAgent();
    const response = await handle(post(JSON.stringify({ text: "hello" })), agent);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "key-1", status: "done", answer: "Hi" });
    expect(calls).toEqual(["admit key-1 hello"]);
  });

  it("answers 400 for a bad key, a body that isn't JSON, or missing or empty text", async () => {
    const { calls, agent } = recordingAgent();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const request of [
      post(JSON.stringify({ text: "hi" }), auth),
      post(JSON.stringify({ text: "hi" }), { ...auth, [IDEMPOTENCY_HEADER]: "a.b" }),
      post(JSON.stringify({ text: "hi" }), { ...auth, [IDEMPOTENCY_HEADER]: "x".repeat(65) }),
      post("not json"),
      post(JSON.stringify(["hi"])),
      post(JSON.stringify({ text: 5 })),
      post(JSON.stringify({ text: "  " })),
    ]) {
      expect((await handle(request, agent)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("answers 413 to an oversized body or text, before asking the agent", async () => {
    const { calls, agent } = recordingAgent();
    const big = post(`{"text":"${"x".repeat(MAX_RELAY_BODY_BYTES)}"}`);
    expect((await handle(big, agent)).status).toBe(413);
    const long = post(JSON.stringify({ text: "x".repeat(RELAY_MAX_TEXT_BYTES + 1) }));
    expect((await handle(long, agent)).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("answers 405 to other methods, with Allow", async () => {
    const { agent } = recordingAgent();
    const response = await handle(
      new Request("https://mipi.example/api/relay", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      agent,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("answers 503 when the agent can't be reached", async () => {
    const { agent } = recordingAgent(new Error("object reset"));
    const response = await handle(post(JSON.stringify({ text: "hi" })), agent);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
  });
});

describe("GET /api/relay/:key", () => {
  it("reads a key's result, and refuses other paths and methods without asking the agent", async () => {
    const { calls, agent } = recordingAgent({ kind: "pending" });
    const pending = await handle(get("key-1"), agent);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ id: "key-1", status: "pending" });
    for (const path of ["a.b", "a/b", "x".repeat(65), "%2e%2e"]) {
      expect((await handle(get(path), agent)).status, path).toBe(404);
    }
    const posted = await handle(
      new Request("https://mipi.example/api/relay/key-1", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      agent,
    );
    expect(posted.status).toBe(405);
    expect(posted.headers.get("Allow")).toBe("GET");
    expect(calls).toEqual(["result key-1"]);
  });
});

describe("relay responses", () => {
  it("maps every result to its status and the same JSON shape", async () => {
    const cases: Array<[RelayResult, number, Record<string, unknown>, Record<string, string>?]> = [
      [{ kind: "done", answer: "A" }, 200, { id: "k", status: "done", answer: "A" }],
      [
        { kind: "unanswered", reason: "provider down" },
        200,
        { id: "k", status: "unanswered", reason: "provider down" },
      ],
      [{ kind: "pending" }, 202, { id: "k", status: "pending" }, { Location: "/api/relay/k" }],
      [{ kind: "conflict" }, 409, { id: "k" }],
      [{ kind: "limited", retryAfterSeconds: 120 }, 429, { id: "k" }, { "Retry-After": "120" }],
      [{ kind: "invalid", reason: "bad" }, 400, { id: "k", error: "bad" }],
      [{ kind: "too-large", limitBytes: 10 }, 413, { id: "k" }],
      [{ kind: "not-found" }, 404, { id: "k" }],
      [{ kind: "unavailable" }, 503, { id: "k" }, { "Retry-After": "30" }],
    ];
    for (const [result, status, body, headers = {}] of cases) {
      const response = relayResponse("k", result);
      expect(response.status, result.kind).toBe(status);
      expect(await response.json()).toMatchObject(body);
      for (const [name, value] of Object.entries(headers)) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
  });
});
