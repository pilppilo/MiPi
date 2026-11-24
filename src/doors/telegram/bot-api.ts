/**
 * The Telegram Bot API transport: one `sendMessage` request per chunk, its answer classified for the outbox
 * (`outbox.ts`). Apart from the outbox so the composition root can make the sender without naming the door's
 * documents.
 */
import { MAX_RETRY_AFTER_MS } from "./outbox.ts";

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
