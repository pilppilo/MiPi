/**
 * `POST /api/telegram`: Telegram's webhook. It runs before the owner's web authentication (Cloudflare Access bypasses
 * this exact path), so this handler is its whole authentication: the webhook secret Telegram sends in
 * `X-Telegram-Bot-Api-Secret-Token`, compared in constant time, refusing everything while no valid secret is set.
 *
 * 200 tells Telegram the update is handled, so it is returned only once the agent stored the update (or for one MiPi
 * deliberately drops); 503 makes Telegram retry later.
 */
import { constantTimeEqual } from "./auth.ts";
import { readBounded } from "./body.ts";
import {
  parseAllowedUserIds,
  parseTelegramUpdate,
  type TelegramInbound,
} from "../doors/telegram/update.ts";

export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
/** Updates are small (a message is at most 4,096 characters); anything much larger is not one. */
export const MAX_UPDATE_BYTES = 128 * 1024;
/** What Telegram accepts as a `secret_token`. */
export const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/** What the agent says after an admission: stored, or not now (maintenance, a refused start, a failed commit). */
export type TelegramAdmission = { readonly kind: "stored" } | { readonly kind: "unavailable" };

export interface TelegramAgent {
  /** `host` is the hostname the webhook came to, which the agent keeps so `web_fetch` refuses it. */
  telegramAdmit(update: TelegramInbound, host?: string): Promise<TelegramAdmission>;
}

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const ok = (): Response => json({ ok: true }, 200);

function setting(env: Env, name: string): string | undefined {
  const value: unknown = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The configured webhook secret, or undefined when it is unset or not one Telegram accepts. */
export function webhookSecret(env: Env): string | undefined {
  const secret = setting(env, "TELEGRAM_WEBHOOK_SECRET");
  return secret !== undefined && WEBHOOK_SECRET_PATTERN.test(secret) ? secret : undefined;
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  agent: () => TelegramAgent,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }
  const expected = webhookSecret(env);
  const presented = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (
    expected === undefined ||
    presented === null ||
    !(await constantTimeEqual(presented, expected))
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await readBounded(request, MAX_UPDATE_BYTES);
  if (body === undefined) return json({ error: "Update too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Authenticated but unreadable: retrying won't fix it, so acknowledge it.
    return ok();
  }
  const update = parseTelegramUpdate(parsed, {
    allowedUserIds: parseAllowedUserIds(setting(env, "TELEGRAM_ALLOWED_USER_IDS")),
    ...(setting(env, "TELEGRAM_BOT_USERNAME") === undefined
      ? {}
      : { botUsername: setting(env, "TELEGRAM_BOT_USERNAME")! }),
  });
  if (update.kind === "ignored") return ok();

  let admission: TelegramAdmission;
  try {
    admission = await agent().telegramAdmit(update, new URL(request.url).hostname);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Telegram admission failed",
        updateId: update.updateId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    admission = { kind: "unavailable" };
  }
  return admission.kind === "stored"
    ? ok()
    : json({ error: "Unavailable" }, 503, { "Retry-After": "30" });
}
