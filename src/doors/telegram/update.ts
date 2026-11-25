/**
 * What a Telegram webhook update means for MiPi, decided at the trust boundary (the Worker, after it checked the
 * webhook secret). Only text and non-text messages in a private chat with an allowlisted sender reach the agent;
 * everything else is acknowledged and dropped.
 */

export const TELEGRAM_COMMANDS = [
  "start",
  "new",
  "bot",
  "version",
  "profile",
  "model",
  "usage",
] as const;
export type TelegramCommandName = (typeof TELEGRAM_COMMANDS)[number];

/** An update the agent admits. `chatId` is a private chat, so it is also the sender's user id. */
export type TelegramInbound =
  | {
      readonly kind: "text";
      readonly updateId: number;
      readonly chatId: number;
      readonly text: string;
    }
  | {
      readonly kind: "command";
      readonly updateId: number;
      readonly chatId: number;
      readonly command: TelegramCommandName;
      /** What follows the command, trimmed; empty when nothing does. */
      readonly argument: string;
    }
  | {
      /** A photo, voice note, sticker, …: answered with a hint that only text works. */
      readonly kind: "non-text";
      readonly updateId: number;
      readonly chatId: number;
    };

export type TelegramUpdate =
  | TelegramInbound
  | { readonly kind: "ignored"; readonly reason: string; readonly updateId?: number };

export interface TelegramUpdateConfig {
  /** Telegram user ids allowed to talk to the agent. Empty: nobody. */
  readonly allowedUserIds: ReadonlySet<number>;
  /** This lane's bot username, without `@`, compared case-insensitively. Unset: suffixed commands are ignored. */
  readonly botUsername?: string;
}

/** `TELEGRAM_ALLOWED_USER_IDS`: ids separated by commas or whitespace. Anything that isn't an id is dropped. */
export function parseAllowedUserIds(value: string | undefined): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const part of (value ?? "").split(/[\s,]+/)) {
    if (!/^\d{1,16}$/.test(part)) continue;
    const id = Number(part);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const ignored = (reason: string, updateId?: number): TelegramUpdate => ({
  kind: "ignored",
  reason,
  ...(updateId === undefined ? {} : { updateId }),
});

const isCommandName = (name: string): name is TelegramCommandName =>
  (TELEGRAM_COMMANDS as readonly string[]).includes(name);

/** `/name`, `/name@bot`, then the argument. */
const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;

/** One webhook body, as parsed JSON. */
export function parseTelegramUpdate(body: unknown, config: TelegramUpdateConfig): TelegramUpdate {
  if (!isRecord(body)) return ignored("not an object");
  const updateId = safeInteger(body.update_id);
  if (updateId === undefined || updateId < 0) return ignored("no update_id");
  // Only new messages: edits, channel posts, callbacks and the rest are out of scope.
  const message = body.message;
  if (!isRecord(message)) return ignored("not a message", updateId);
  const chat = message.chat;
  const from = message.from;
  if (!isRecord(chat) || !isRecord(from)) return ignored("no chat or sender", updateId);
  if (chat.type !== "private") return ignored("not a private chat", updateId);
  const chatId = safeInteger(chat.id);
  const userId = safeInteger(from.id);
  if (chatId === undefined || userId === undefined)
    return ignored("no chat or sender id", updateId);
  if (!config.allowedUserIds.has(userId)) return ignored("sender is not allowlisted", updateId);
  // In a private chat the chat is the user; anything else is not a message from them.
  if (chatId !== userId) return ignored("chat is not the sender's", updateId);
  if (from.is_bot === true) return ignored("sender is a bot", updateId);

  const text = message.text;
  if (typeof text !== "string") return { kind: "non-text", updateId, chatId };
  if (text.trim().length === 0) return ignored("empty text", updateId);

  const command = COMMAND.exec(text.trim());
  if (command !== null) {
    const [, name, addressee, argument] = command;
    if (addressee !== undefined) {
      const ours = config.botUsername?.replace(/^@/, "").toLowerCase();
      if (ours === undefined || addressee.toLowerCase() !== ours) {
        return ignored("command for another bot", updateId);
      }
    }
    const lower = name!.toLowerCase();
    if (isCommandName(lower)) {
      return {
        kind: "command",
        updateId,
        chatId,
        command: lower,
        argument: (argument ?? "").trim(),
      };
    }
    // An unknown command is just text for the model.
  }
  return { kind: "text", updateId, chatId, text };
}
