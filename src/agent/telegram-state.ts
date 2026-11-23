/**
 * The Telegram door's session document, on its own so the scheduling tools can record where a reminder's answer goes
 * without importing the door (`telegram.ts` imports the profiles, which import the tools).
 */
import { defineDoc } from "./pi/durable.ts";

/** Messages of one idle chat waiting for their window to end. */
export type StagedWindow = {
  chatId: number;
  /** The chat's conversation when the window opened; the batch goes there even if `/new` rebinds the chat. */
  conversationId: number;
  firstUpdateId: number;
  /** First message's admission plus `BATCH_WINDOW_MS`. Later messages never move it. */
  deadline: number;
  messages: Array<{ updateId: number; text: string; at: number }>;
};

export type TelegramChannelState = {
  /** Admitted `update_id`s, oldest first. */
  receipts: Array<{ updateId: number; at: number }>;
  /**
   * Inputs submitted and not settled yet, with the chat their reply goes to. `updateId` is the Telegram update (the
   * first of a batch); a scheduled reminder for this chat (M6) has none.
   */
  inputs: Array<{
    updateId?: number;
    chatId: number;
    conversationId: number;
    submissionId: number;
  }>;
  /** Commands admitted that still need an outside lookup (`/model <id>` reads the live model list). */
  commands: Array<{ updateId: number; chatId: number; conversationId: number; model: string }>;
  /**
   * Windows of idle chats still collecting messages (COD-174). Optional, so the document needs no new version: a
   * build from before it ignores the field (and the messages waiting in it, on a rollback).
   */
  staged?: StagedWindow[];
};

/** The document's kind, which commit observers match on. */
export const TELEGRAM_DOC_KIND = "app.telegram";

export const TelegramChannel = defineDoc<TelegramChannelState>({
  kind: TELEGRAM_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ receipts: [], inputs: [], commands: [] }),
  checkpointWhen: (value) =>
    value.inputs.length === 0 && value.commands.length === 0 && (value.staged ?? []).length === 0,
});
