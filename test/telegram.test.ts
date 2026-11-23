/** The Telegram door's pure parts: chunking, update parsing, outbox transitions, the Bot API sender, and the webhook. */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  botApiSender,
  enqueueReply,
  FINISHED_REPLIES_KEPT,
  MAX_ATTEMPTS,
  nextOutboxWake,
  type OutboxState,
  PER_CHAT_GAP_MS,
  pickSend,
  recordSend,
  type SendResult,
} from "../src/agent/telegram-outbox.ts";
import { splitForTelegram, TELEGRAM_TEXT_LIMIT } from "../src/lib/telegram-text.ts";
import {
  parseAllowedUserIds,
  parseTelegramUpdate,
  type TelegramInbound,
} from "../src/lib/telegram-update.ts";
import {
  handleTelegramWebhook,
  MAX_UPDATE_BYTES,
  TELEGRAM_SECRET_HEADER,
  type TelegramAdmission,
} from "../src/worker/telegram.ts";
import worker from "../src/worker/index.ts";

const graphemes = (text: string): string[] =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    ({ segment }) => segment,
  );

describe("splitForTelegram", () => {
  it("keeps a short reply whole and drops empty ones", () => {
    expect(splitForTelegram("  Hello  ")).toEqual(["Hello"]);
    expect(splitForTelegram(" \n ")).toEqual([]);
  });

  it("splits at paragraphs, then lines, then spaces, within the limit and in order", () => {
    const paragraph = "a".repeat(3000);
    expect(splitForTelegram(`${paragraph}\n\n${paragraph}`)).toEqual([paragraph, paragraph]);
    const words = Array.from({ length: 2000 }, (_, index) => `w${index}`).join(" ");
    const chunks = splitForTelegram(words);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(chunks.join(" ")).toBe(words);
  });

  it("never splits a surrogate pair or a ZWJ emoji, and never goes past 4,096 UTF-16 units", () => {
    for (const emoji of ["😀", "👨‍👩‍👧‍👦", "🇺🇸", "é"]) {
      const text = emoji.repeat(Math.ceil(9000 / emoji.length));
      const chunks = splitForTelegram(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
        expect(graphemes(chunk).every((grapheme) => grapheme === emoji)).toBe(true);
      }
      expect(chunks.join("")).toBe(text);
    }
  });

  it("falls back to code points for one grapheme longer than a message", () => {
    const zalgo = `a${"́".repeat(5000)}`;
    const chunks = splitForTelegram(zalgo, 100);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(zalgo);
  });
});

const ALLOWED = { allowedUserIds: parseAllowedUserIds("42, 7"), botUsername: "MiPiBot" };

const message = (overrides: Record<string, unknown> = {}, chat: Record<string, unknown> = {}) => ({
  update_id: 100,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: "private", ...chat },
    from: { id: 42, is_bot: false, first_name: "J" },
    text: "Hello",
    ...overrides,
  },
});

describe("parseTelegramUpdate", () => {
  it("admits text from an allowlisted sender in a private chat", () => {
    expect(parseTelegramUpdate(message(), ALLOWED)).toEqual({
      kind: "text",
      updateId: 100,
      chatId: 42,
      text: "Hello",
    });
  });

  it("drops strangers, groups, edits, callbacks, and malformed updates", () => {
    const stranger = message({ from: { id: 9, is_bot: false } }, { id: 9 });
    const group = message({}, { id: -5, type: "group" });
    const edit = { update_id: 1, edited_message: message().message };
    const callback = { update_id: 2, callback_query: { id: "x", from: { id: 42 } } };
    for (const body of [stranger, group, edit, callback, null, [], { update_id: "1" }]) {
      expect(parseTelegramUpdate(body, ALLOWED).kind).toBe("ignored");
    }
    expect(parseTelegramUpdate(message(), { allowedUserIds: new Set() }).kind).toBe("ignored");
  });

  it("answers non-text messages with a hint", () => {
    expect(parseTelegramUpdate(message({ text: undefined, photo: [{}] }), ALLOWED)).toEqual({
      kind: "non-text",
      updateId: 100,
      chatId: 42,
    });
  });

  it("reads commands, ours with or without the suffix, and ignores other bots' commands", () => {
    expect(parseTelegramUpdate(message({ text: "/model  deepseek " }), ALLOWED)).toMatchObject({
      kind: "command",
      command: "model",
      argument: "deepseek",
    });
    expect(parseTelegramUpdate(message({ text: "/new@mipibot" }), ALLOWED)).toMatchObject({
      kind: "command",
      command: "new",
      argument: "",
    });
    expect(parseTelegramUpdate(message({ text: "/new@OtherBot" }), ALLOWED).kind).toBe("ignored");
    expect(
      parseTelegramUpdate(message({ text: "/new@MiPiBot" }), { allowedUserIds: new Set([42]) })
        .kind,
    ).toBe("ignored");
    // An unknown command is text for the model.
    expect(parseTelegramUpdate(message({ text: "/weather today" }), ALLOWED)).toMatchObject({
      kind: "text",
      text: "/weather today",
    });
  });

  it("parses the allowlist leniently and drops what isn't an id", () => {
    expect([...parseAllowedUserIds(" 1,2  3,abc,-4, 0 ")]).toEqual([1, 2, 3]);
    expect(parseAllowedUserIds(undefined).size).toBe(0);
  });
});

const empty = (): OutboxState => ({ replies: [], pacedUntil: {} });
const sent = (messageId: number): SendResult => ({ kind: "sent", messageId });

describe("outbox", () => {
  it("drains each chat in order, paced, with chats independent", () => {
    const state = empty();
    enqueueReply(state, { id: "a", chatId: 1, text: "A" }, 0);
    enqueueReply(state, { id: "b", chatId: 1, text: "B" }, 0);
    enqueueReply(state, { id: "c", chatId: 2, text: "C" }, 0);
    // The same id twice is one reply.
    expect(enqueueReply(state, { id: "a", chatId: 1, text: "A" }, 0)).toBe(false);
    const none = new Set<string>();

    const first = pickSend(state, 0, none)!;
    expect(first).toMatchObject({ replyId: "a", chatId: 1 });
    recordSend(state, first, sent(1), 0);
    // Chat 1 is paced now; chat 2 is not.
    expect(pickSend(state, 0, none)).toMatchObject({ replyId: "c" });
    const running = new Set(["c#0"]);
    expect(pickSend(state, 0, running)).toBeUndefined();
    // "c" is sending, so its outcome is due now; chat 1 waits for its gap.
    expect(nextOutboxWake(state, 0)).toBe(0);
    recordSend(state, { replyId: "c", index: 0, chatId: 2, text: "C" }, sent(2), 0);
    expect(nextOutboxWake(state, 0)).toBe(PER_CHAT_GAP_MS);
    expect(pickSend(state, PER_CHAT_GAP_MS, none)).toMatchObject({ replyId: "b" });
  });

  it("waits out a 429, backs off a 5xx, then gives up after the attempt limit", () => {
    const state = empty();
    enqueueReply(state, { id: "a", chatId: 1, text: "A" }, 0);
    const none = new Set<string>();
    let now = 0;
    let send = pickSend(state, now, none)!;
    recordSend(state, send, { kind: "retry", afterMs: 5_000, reason: "429" }, now);
    expect(pickSend(state, 4_999, none)).toBeUndefined();
    expect(nextOutboxWake(state, 0)).toBe(5_000);
    now = 5_000;
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      send = pickSend(state, now, none)!;
      expect(send).toBeDefined();
      recordSend(state, send, { kind: "retry", reason: "502" }, now);
      now = nextOutboxWake(state, now) ?? now;
    }
    expect(state.replies[0]!.chunks[0]).toMatchObject({ status: "failed" });
    expect(nextOutboxWake(state, now)).toBeUndefined();
  });

  it("skips the rest of a reply after a failed or unknown chunk, and the chat moves on", () => {
    for (const outcome of [
      { kind: "failed", reason: "400" },
      { kind: "unknown", reason: "Timed out" },
    ] as const) {
      const state = empty();
      enqueueReply(
        state,
        { id: "long", chatId: 1, text: `${"x".repeat(4000)}\n\n${"y".repeat(200)}` },
        0,
      );
      enqueueReply(state, { id: "next", chatId: 1, text: "Next" }, 0);
      const none = new Set<string>();
      const send = pickSend(state, 0, none)!;
      recordSend(state, send, outcome, 0);
      expect(state.replies[0]!.chunks.map(({ status }) => status)).toEqual([
        outcome.kind === "failed" ? "failed" : "delivery-unknown",
        "skipped-after-failure",
      ]);
      expect(pickSend(state, PER_CHAT_GAP_MS, none)).toMatchObject({ replyId: "next" });
    }
  });

  it("records a send left sending by a lost instance as delivery-unknown, never sending it again", () => {
    const state = empty();
    enqueueReply(state, { id: "a", chatId: 1, text: "A" }, 0);
    const running = pickSend(state, 0, new Set())!;
    // While its request runs, it stays sending.
    expect(pickSend(state, 0, new Set(["a#0"]))).toBeUndefined();
    expect(state.replies[0]!.chunks[0]!.status).toBe("sending");
    // After a restart nothing is running.
    expect(pickSend(state, 0, new Set())).toBeUndefined();
    expect(state.replies[0]!.chunks[0]!.status).toBe("delivery-unknown");
    // A late answer for it changes nothing.
    recordSend(state, running, sent(1), 0);
    expect(state.replies[0]!.chunks[0]!.status).toBe("delivery-unknown");
  });

  it("keeps a bounded number of finished replies", () => {
    const state = empty();
    for (let index = 0; index < FINISHED_REPLIES_KEPT + 20; index++) {
      enqueueReply(state, { id: `r${index}`, chatId: index, text: "x" }, 0);
      recordSend(state, pickSend(state, 0, new Set())!, sent(index), 0);
    }
    expect(state.replies).toHaveLength(FINISHED_REPLIES_KEPT);
    expect(state.replies[0]!.id).toBe("r20");
  });
});

type FetchCall = { readonly url: string; readonly body: unknown };

const fakeFetch = (response: () => Response | Promise<Response>, calls: FetchCall[] = []) =>
  (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return response();
  }) as (input: string, init?: RequestInit) => Promise<Response>;

describe("botApiSender", () => {
  it("sends plain text and confirms only on ok with a message id", async () => {
    const calls: FetchCall[] = [];
    const send = botApiSender(
      "123:abc",
      fakeFetch(() => Response.json({ ok: true, result: { message_id: 77 } }), calls),
    );
    expect(await send(42, "Hi")).toEqual({ kind: "sent", messageId: 77 });
    expect(calls).toEqual([
      {
        url: "https://api.telegram.org/bot123:abc/sendMessage",
        body: { chat_id: 42, text: "Hi", link_preview_options: { is_disabled: true } },
      },
    ]);
    const noId = botApiSender(
      "t",
      fakeFetch(() => Response.json({ ok: true, result: {} })),
    );
    expect((await noId(1, "x")).kind).toBe("unknown");
  });

  it("classifies 429, 5xx, refusals and lost requests", async () => {
    const answer = (status: number, body: unknown) =>
      botApiSender(
        "t",
        fakeFetch(() => Response.json(body, { status })),
      )(1, "x");
    expect(
      await answer(429, { ok: false, description: "Too Many", parameters: { retry_after: 3 } }),
    ).toEqual({ kind: "retry", afterMs: 3_000, reason: "429: Too Many" });
    expect((await answer(502, {})).kind).toBe("retry");
    expect(
      await answer(403, { ok: false, description: "Forbidden: bot was blocked by the user" }),
    ).toEqual({ kind: "failed", reason: "403: Forbidden: bot was blocked by the user" });
    expect((await answer(401, { ok: false })).kind).toBe("failed");
    const lost = botApiSender("t", async () => {
      throw new TypeError("network");
    });
    expect(await lost(1, "x")).toEqual({ kind: "unknown", reason: "No answer" });
    expect(await botApiSender(undefined)(1, "x")).toMatchObject({ kind: "failed" });
  });
});

const SECRET = "s3cret_-token";
const telegramEnv = (overrides: Record<string, string> = {}): Env =>
  ({
    ...env,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_ALLOWED_USER_IDS: "42",
    TELEGRAM_BOT_USERNAME: "MiPiBot",
    ...overrides,
  }) as Env;

const post = (
  body: string,
  headers: Record<string, string> = { [TELEGRAM_SECRET_HEADER]: SECRET },
) => new Request("https://mipi.example/api/telegram", { method: "POST", body, headers });

const recordingAgent = (admission: TelegramAdmission | Error = { kind: "stored" }) => {
  const admitted: TelegramInbound[] = [];
  return {
    admitted,
    agent: () => ({
      telegramAdmit: async (update: TelegramInbound) => {
        admitted.push(update);
        if (admission instanceof Error) throw admission;
        return admission;
      },
    }),
  };
};

describe("Telegram webhook", () => {
  it("admits an authenticated update and answers 200 once the agent stored it", async () => {
    const { admitted, agent } = recordingAgent();
    const response = await handleTelegramWebhook(
      post(JSON.stringify(message())),
      telegramEnv(),
      agent,
    );
    expect(response.status).toBe(200);
    expect(admitted).toEqual([{ kind: "text", updateId: 100, chatId: 42, text: "Hello" }]);
  });

  it("refuses a wrong or missing secret, and everything while the secret is unset or invalid", async () => {
    const { admitted, agent } = recordingAgent();
    const body = JSON.stringify(message());
    for (const [request, settings] of [
      [post(body, { [TELEGRAM_SECRET_HEADER]: "wrong" }), {}],
      [post(body, {}), {}],
      [post(body), { TELEGRAM_WEBHOOK_SECRET: "" }],
      [
        post(body, { [TELEGRAM_SECRET_HEADER]: "has space" }),
        { TELEGRAM_WEBHOOK_SECRET: "has space" },
      ],
    ] as const) {
      expect((await handleTelegramWebhook(request, telegramEnv(settings), agent)).status).toBe(401);
    }
    expect(admitted).toEqual([]);
  });

  it("answers 405 to other methods and 413 to an oversized body", async () => {
    const { admitted, agent } = recordingAgent();
    const get = new Request("https://mipi.example/api/telegram", {
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET },
    });
    const refused = await handleTelegramWebhook(get, telegramEnv(), agent);
    expect(refused.status).toBe(405);
    expect(refused.headers.get("Allow")).toBe("POST");
    const big = post(`{"update_id":1,"pad":"${"x".repeat(MAX_UPDATE_BYTES)}"}`);
    expect((await handleTelegramWebhook(big, telegramEnv(), agent)).status).toBe(413);
    expect(admitted).toEqual([]);
  });

  it("acknowledges updates it drops, without waking the agent", async () => {
    const { admitted, agent } = recordingAgent();
    for (const body of [
      "not json",
      JSON.stringify(message({ from: { id: 9 } }, { id: 9 })),
      JSON.stringify(message({}, { type: "group" })),
      JSON.stringify({ update_id: 5, edited_message: message().message }),
    ]) {
      expect((await handleTelegramWebhook(post(body), telegramEnv(), agent)).status).toBe(200);
    }
    expect(admitted).toEqual([]);
  });

  it("answers 503 so Telegram retries when the agent can't store the update", async () => {
    for (const admission of [{ kind: "unavailable" } as const, new Error("storage")]) {
      const { agent } = recordingAgent(admission);
      const response = await handleTelegramWebhook(
        post(JSON.stringify(message())),
        telegramEnv(),
        agent,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
    }
  });

  it("is routed before the owner's web authentication", async () => {
    // No spike token and no Access JWT: a web route would answer 401 "Locked".
    const unauthorized = await worker.fetch(
      post(JSON.stringify(message()), { [TELEGRAM_SECRET_HEADER]: "wrong" }),
      telegramEnv(),
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Unauthorized" });
    // An authenticated update the Worker drops never reaches the agent, and is acknowledged.
    const dropped = await worker.fetch(
      post(JSON.stringify(message({}, { type: "group" }))),
      telegramEnv(),
    );
    expect(dropped.status).toBe(200);
  });
});
