/**
 * The durable Telegram outbox: every message MiPi sends to Telegram (answers, command replies, notices) is a reply of
 * ordered chunks in one session document, and is sent from there. Each chat drains first in, first out, one chunk at
 * a time. A send's intent is stored before the request goes out, so a restart in the middle can't send it twice
 * unseen. M6: a chunk carries rendered HTML beside its markdown source, and a send whose outcome is unclear (a
 * timeout, a lost answer, a chunk found `sending` after a restart) is tried once more before it counts as
 * `delivery-unknown`. Telegram has no way to look a message up in a chat, so a rare duplicate is the lesser harm than
 * a lost reminder.
 *
 * The transitions here are pure functions on the document's state, so they are tested without a harness.
 */
import { defineDoc } from "./pi/durable.ts";
import {
  FENCE_RESERVE,
  renderTelegramHtml,
  splitMarkdownForTelegram,
} from "../lib/telegram-html.ts";

export type ChunkStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "delivery-unknown"
  | "skipped-after-failure";

export type OutboxChunk = {
  /**
   * Stable identity: `<reply>#<n>`, and `<id>:<n>` for the halves of a chunk Telegram found too long. Absent on chunks
   * an M5 build stored; `chunkKey()` gives those `<reply>#<index>`.
   */
  id?: string;
  /** The markdown source, also what is sent as plain text. */
  text: string;
  /** `text` as Telegram HTML (M6). Absent on M5 chunks, which send plain text. */
  html?: string;
  /** `plain` once Telegram refused the HTML ("can't parse entities"): the source goes out instead. */
  mode?: "html" | "plain";
  /** `retry-once`: an unclear outcome is tried once more (M6). Absent on M5 chunks, whose unclear outcome is final. */
  ambiguousPolicy?: "retry-once";
  ambiguousRetries?: number;
  /** How many times this chunk's text was halved because Telegram found it too long. */
  splitDepth?: number;
  status: ChunkStatus;
  /** Requests started for this chunk. */
  attempts: number;
  /** A retry waits until then (429 `retry_after`, or backoff after a 5xx). */
  notBefore?: number;
  /** Telegram's id for the sent message: present exactly when `sent`. */
  messageId?: number;
  /** Why it ended `failed` or `delivery-unknown`, for inspection. */
  error?: string;
};

export type OutboxReply = {
  /** Stable identity, so enqueueing the same reply twice is a no-op: `answer:<entry>:<chat>`, `cmd:<update>`, … */
  id: string;
  chatId: number;
  createdAt: number;
  chunks: OutboxChunk[];
};

export type OutboxState = {
  replies: OutboxReply[];
  /** Per chat (by id): no send before this time, so a long reply doesn't trip Telegram's per-chat limit. */
  pacedUntil: Record<string, number>;
};

/** Finished replies kept for inspection; older ones are dropped. */
export const FINISHED_REPLIES_KEPT = 50;
/** Requests per chunk before a retryable error becomes `failed`. */
export const MAX_ATTEMPTS = 5;
/** Gap between two sends to one chat. */
export const PER_CHAT_GAP_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** The longest 429 `retry_after` honoured; a larger one waits this long. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** The one retry of an unclear send waits this long. */
export const AMBIGUOUS_RETRY_MS = 3_000;
/** A chunk is halved at most this often; then a "too long" is final. */
export const MAX_SPLIT_DEPTH = 3;

const TERMINAL: ReadonlySet<ChunkStatus> = new Set([
  "sent",
  "failed",
  "delivery-unknown",
  "skipped-after-failure",
]);

export const isFinished = (reply: OutboxReply): boolean =>
  reply.chunks.every((chunk) => TERMINAL.has(chunk.status));

export const TelegramOutbox = defineDoc<OutboxState>({
  kind: "app.telegram-outbox",
  version: 1,
  scope: "session",
  initial: () => ({ replies: [], pacedUntil: {} }),
  // Changed by every send: store a small base whenever nothing is waiting, so replay stays short.
  checkpointWhen: (value) => value.replies.every(isFinished),
});

/** What a send request came back with, classified by the transport. */
export type SendResult =
  | { readonly kind: "sent"; readonly messageId: number }
  /** Telegram asked to wait (429), or answered 5xx: try again later. */
  | { readonly kind: "retry"; readonly afterMs?: number; readonly reason: string }
  /** Telegram refused it for good (a revoked token, a blocked bot, a bad request). */
  | { readonly kind: "failed"; readonly reason: string }
  /** No usable answer (a timeout, a lost connection, a malformed body): it may have been delivered. */
  | { readonly kind: "unknown"; readonly reason: string }
  /** Telegram couldn't read the HTML ("can't parse entities"): send the plain text once instead. */
  | { readonly kind: "markup"; readonly reason: string }
  /** Telegram found the message too long: send it in halves. */
  | { readonly kind: "too-long"; readonly reason: string };

/** A chunk picked for sending: its intent is already stored. */
export type PickedSend = {
  readonly replyId: string;
  /** The chunk's `chunkKey()`, which the in-flight set and the result go by. */
  readonly key: string;
  readonly chatId: number;
  readonly text: string;
  /** Present when the chunk goes out as HTML. */
  readonly html?: string;
};

export const chunkKey = (reply: OutboxReply, chunk: OutboxChunk, index: number): string =>
  chunk.id ?? `${reply.id}#${index}`;

/** A new chunk of `text`: rendered, with the one retry for an unclear outcome. */
function newChunk(
  id: string,
  text: string,
  splitDepth: number,
  mode: "html" | "plain",
): OutboxChunk {
  return {
    id,
    text,
    html: renderTelegramHtml(text),
    ...(mode === "plain" ? { mode } : {}),
    status: "pending",
    attempts: 0,
    ambiguousPolicy: "retry-once",
    ambiguousRetries: 0,
    ...(splitDepth === 0 ? {} : { splitDepth }),
  };
}

/** The text MiPi sends when an answer has no text of its own. */
const EMPTY_REPLY = "(No text in the answer.)";

/**
 * Adds a reply, split into chunks, unless one with this id is already in the outbox. Returns whether it was added.
 */
export function enqueueReply(
  state: OutboxState,
  reply: { readonly id: string; readonly chatId: number; readonly text: string },
  now: number,
): boolean {
  if (state.replies.some(({ id }) => id === reply.id)) return false;
  const texts = splitMarkdownForTelegram(reply.text);
  state.replies.push({
    id: reply.id,
    chatId: reply.chatId,
    createdAt: now,
    chunks: (texts.length === 0 ? [EMPTY_REPLY] : texts).map((text, index) =>
      newChunk(`${reply.id}#${index}`, text, 0, "html"),
    ),
  });
  prune(state);
  return true;
}

/** Ends a reply's remaining chunks after chunk `index` ended badly, so no tail arrives without its start. */
function skipAfter(reply: OutboxReply, index: number): void {
  for (const chunk of reply.chunks.slice(index + 1)) {
    if (!TERMINAL.has(chunk.status)) chunk.status = "skipped-after-failure";
  }
}

/** Each chat's first unfinished reply: the only one that may send, so every chat stays in order. */
function heads(state: OutboxState): OutboxReply[] {
  const seen = new Set<number>();
  const result: OutboxReply[] = [];
  for (const reply of state.replies) {
    if (seen.has(reply.chatId) || isFinished(reply)) continue;
    seen.add(reply.chatId);
    result.push(reply);
  }
  return result;
}

/**
 * An unclear outcome: the chunk may or may not have arrived. With its one retry left, it goes back to `pending` and
 * the retry is counted now, before it runs, so a retry cut off in turn is never tried a third time. Otherwise, and
 * for an M5 chunk, it is `delivery-unknown` and the rest of its reply is skipped.
 */
function unclear(reply: OutboxReply, index: number, reason: string, now: number): void {
  const chunk = reply.chunks[index]!;
  chunk.error = reason;
  if (chunk.ambiguousPolicy === "retry-once" && (chunk.ambiguousRetries ?? 0) < 1) {
    chunk.ambiguousRetries = 1;
    chunk.status = "pending";
    chunk.notBefore = now + AMBIGUOUS_RETRY_MS;
    return;
  }
  chunk.status = "delivery-unknown";
  skipAfter(reply, index);
}

/**
 * Every chunk left `sending` by a send that is no longer running (the instance restarted, or the request never came
 * back) is an unclear outcome. `inFlight` holds the keys of the sends running now.
 */
export function settleStale(state: OutboxState, inFlight: ReadonlySet<string>, now: number): void {
  for (const reply of state.replies) {
    reply.chunks.forEach((chunk, index) => {
      if (chunk.status !== "sending" || inFlight.has(chunkKey(reply, chunk, index))) return;
      unclear(reply, index, "The send was cut off before Telegram answered", now);
    });
  }
}

/** The next chunk that may go out now, marked `sending` with its attempt counted; undefined when none can. */
export function pickSend(
  state: OutboxState,
  now: number,
  inFlight: ReadonlySet<string>,
): PickedSend | undefined {
  settleStale(state, inFlight, now);
  for (const reply of heads(state)) {
    if ((state.pacedUntil[String(reply.chatId)] ?? 0) > now) continue;
    const index = reply.chunks.findIndex((chunk) => !TERMINAL.has(chunk.status));
    const chunk = reply.chunks[index];
    if (chunk === undefined || chunk.status !== "pending") continue;
    if ((chunk.notBefore ?? 0) > now) continue;
    chunk.status = "sending";
    chunk.attempts += 1;
    delete chunk.notBefore;
    return {
      replyId: reply.id,
      key: chunkKey(reply, chunk, index),
      chatId: reply.chatId,
      text: chunk.text,
      ...(chunk.html !== undefined && chunk.mode !== "plain" ? { html: chunk.html } : {}),
    };
  }
  return undefined;
}

const backoff = (attempts: number): number => Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempts);

/** Records how a picked send ended. */
export function recordSend(
  state: OutboxState,
  send: PickedSend,
  result: SendResult,
  now: number,
): void {
  const reply = state.replies.find(({ id }) => id === send.replyId);
  const index =
    reply?.chunks.findIndex((candidate, at) => chunkKey(reply, candidate, at) === send.key) ?? -1;
  const chunk = reply?.chunks[index];
  if (reply === undefined || chunk === undefined || chunk.status !== "sending") return;
  state.pacedUntil[String(reply.chatId)] = now + PER_CHAT_GAP_MS;
  switch (result.kind) {
    case "sent":
      chunk.status = "sent";
      chunk.messageId = result.messageId;
      break;
    case "retry":
      if (chunk.attempts >= MAX_ATTEMPTS) {
        chunk.status = "failed";
        chunk.error = `Gave up after ${chunk.attempts} attempts: ${result.reason}`;
        skipAfter(reply, index);
        break;
      }
      chunk.status = "pending";
      chunk.notBefore = now + (result.afterMs ?? backoff(chunk.attempts));
      chunk.error = result.reason;
      break;
    case "failed":
      chunk.status = "failed";
      chunk.error = result.reason;
      skipAfter(reply, index);
      break;
    case "unknown":
      unclear(reply, index, result.reason, now);
      break;
    case "markup":
      // Committed before the plain resend runs, so a restart in between sends plain text, not the HTML again.
      if (chunk.mode === "plain" || chunk.html === undefined) {
        chunk.status = "failed";
        chunk.error = result.reason;
        skipAfter(reply, index);
        break;
      }
      chunk.mode = "plain";
      chunk.status = "pending";
      chunk.error = result.reason;
      // The resend is not Telegram asking to wait: no pacing for it.
      delete state.pacedUntil[String(reply.chatId)];
      break;
    case "too-long": {
      const depth = chunk.splitDepth ?? 0;
      const halves =
        depth >= MAX_SPLIT_DEPTH
          ? []
          : splitMarkdownForTelegram(chunk.text, Math.ceil(chunk.text.length / 2) + FENCE_RESERVE);
      if (halves.length < 2) {
        chunk.status = "failed";
        chunk.error = `${result.reason} (can't be split further)`;
        skipAfter(reply, index);
        break;
      }
      // In place, so the reply keeps its order; never sent, so each half has its own retry.
      reply.chunks.splice(
        index,
        1,
        ...halves.map((text, half) =>
          newChunk(
            `${send.key}:${half}`,
            text,
            depth + 1,
            chunk.mode === "plain" ? "plain" : "html",
          ),
        ),
      );
      delete state.pacedUntil[String(reply.chatId)];
      break;
    }
    default: {
      const _: never = result;
      throw new Error("Unknown send result");
    }
  }
  if (isFinished(reply)) prune(state);
}

/**
 * When the outbox next has something to do: now for a chunk left `sending` (its outcome must be recorded), otherwise
 * the earliest time a waiting chunk may go out. Undefined when nothing waits.
 */
export function nextOutboxWake(state: OutboxState, now: number): number | undefined {
  let at: number | undefined;
  for (const reply of heads(state)) {
    const chunk = reply.chunks.find((candidate) => !TERMINAL.has(candidate.status));
    if (chunk === undefined) continue;
    const ready =
      chunk.status === "sending"
        ? now
        : Math.max(chunk.notBefore ?? 0, state.pacedUntil[String(reply.chatId)] ?? 0, now);
    at = at === undefined ? ready : Math.min(at, ready);
  }
  return at;
}

/** Drops the oldest finished replies past `FINISHED_REPLIES_KEPT`, and pacing for chats with nothing waiting. */
function prune(state: OutboxState): void {
  let finished = state.replies.filter(isFinished).length;
  if (finished > FINISHED_REPLIES_KEPT) {
    state.replies = state.replies.filter((reply) => {
      if (finished <= FINISHED_REPLIES_KEPT || !isFinished(reply)) return true;
      finished -= 1;
      return false;
    });
  }
  const waiting = new Set(
    state.replies.filter((reply) => !isFinished(reply)).map(({ chatId }) => String(chatId)),
  );
  for (const chat of Object.keys(state.pacedUntil)) {
    if (!waiting.has(chat)) delete state.pacedUntil[chat];
  }
}

// ---- Transport ----

/** One message: the source as plain text, or HTML when `html` is given. */
export type TelegramMessage = { readonly text: string; readonly html?: string };
export type TelegramSend = (chatId: number, message: TelegramMessage) => Promise<SendResult>;
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** How long one Bot API request may take before its outcome counts as unknown. */
export const SEND_TIMEOUT_MS = 10_000;

const describe = (body: unknown, status: number): string => {
  const description =
    typeof body === "object" && body !== null
      ? (body as { description?: unknown }).description
      : undefined;
  return typeof description === "string"
    ? `${status}: ${description.slice(0, 200)}`
    : `HTTP ${status}`;
};

/**
 * `sendMessage` through the Bot API, classified into a `SendResult`: as HTML (`parse_mode: "HTML"`) when the message
 * has `html`, otherwise as plain text.
 */
export function botApiSender(token: string | undefined, fetcher: Fetch = fetch): TelegramSend {
  return async (chatId, message) => {
    if (token === undefined || token.trim().length === 0) {
      return { kind: "failed", reason: "TELEGRAM_BOT_TOKEN is not set" };
    }
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          ...(message.html === undefined
            ? { text: message.text }
            : { text: message.html, parse_mode: "HTML" }),
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      // Never include the URL: it carries the token.
      return {
        kind: "unknown",
        reason: error instanceof Error && error.name === "TimeoutError" ? "Timed out" : "No answer",
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (response.status === 429) {
      const retryAfter = (body as { parameters?: { retry_after?: unknown } } | undefined)
        ?.parameters?.retry_after;
      return {
        kind: "retry",
        reason: describe(body, 429),
        ...(typeof retryAfter === "number" && retryAfter >= 0
          ? { afterMs: Math.min(MAX_RETRY_AFTER_MS, Math.ceil(retryAfter) * 1_000) }
          : {}),
      };
    }
    if (response.status >= 500) return { kind: "retry", reason: describe(body, response.status) };
    if (response.status === 400) {
      const reason = describe(body, 400);
      if (/can't parse entities/i.test(reason)) return { kind: "markup", reason };
      if (/message is too long|message_too_long/i.test(reason)) return { kind: "too-long", reason };
    }
    if (!response.ok) return { kind: "failed", reason: describe(body, response.status) };
    const result = body as { ok?: unknown; result?: { message_id?: unknown } } | undefined;
    const messageId = result?.result?.message_id;
    if (result?.ok === true && typeof messageId === "number" && Number.isSafeInteger(messageId)) {
      return { kind: "sent", messageId };
    }
    return { kind: "unknown", reason: "Telegram's answer had no message id" };
  };
}
