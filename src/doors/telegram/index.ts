/**
 * The Telegram door's registration with core (COD-210): its request-id prefix and where a reply to one goes, its
 * delivery adapter, and its inputs waiting for an answer. The door's runtime (admitting updates, commands, draining the
 * outbox) is `channel.ts`, which the composition root runs.
 *
 * Only this folder reads or writes the door's documents (`app.telegram`, `app.telegram-outbox`; lint-enforced). A
 * Telegram destination is `{ kind: "telegram", chatId }`, the shape 0.1.0-beta.1 stored with reminders.
 */
import type { Tx } from "../../agent/pi/durable.ts";
import type { DoorRegistration, PendingInput } from "../../agent/connectors.ts";
import type { DeliveryDestination } from "../../agent/delivery.ts";
import { enqueueReply, TelegramOutbox } from "./outbox.ts";
import { TELEGRAM_DOC_KIND, TelegramChannel } from "./state.ts";

export const TELEGRAM_DESTINATION = "telegram";

/** A Telegram chat as a delivery destination. */
export const telegramDestination = (chatId: number): DeliveryDestination => ({
  kind: TELEGRAM_DESTINATION,
  chatId,
});

/** The chat of a stored Telegram destination. Stored data, so it is checked. */
export function chatOf(destination: DeliveryDestination): number {
  const chatId = destination.chatId;
  if (destination.kind !== TELEGRAM_DESTINATION || typeof chatId !== "number") {
    throw new Error(`Not a Telegram destination: ${JSON.stringify(destination)}`);
  }
  return chatId;
}

async function readPending(tx: Tx): Promise<readonly PendingInput[]> {
  return (await tx.doc(TelegramChannel)).inputs.map((input) => ({
    submissionId: input.submissionId,
    conversationId: input.conversationId,
    destination: telegramDestination(input.chatId),
  }));
}

export const telegramDoor: DoorRegistration = {
  name: "telegram",
  origins: [
    {
      prefix: "tg",
      source: "telegram",
      authority: "owner",
      automated: false,
      // The chat isn't in `tg:<update_id>`: it is the one the door recorded with the input.
      replyTo: async (tx, { submissionId }) => {
        const input = (await tx.doc(TelegramChannel)).inputs.find(
          (candidate) =>
            candidate.submissionId === submissionId && candidate.updateId !== undefined,
        );
        return input === undefined ? undefined : telegramDestination(input.chatId);
      },
    },
  ],
  delivery: {
    kind: TELEGRAM_DESTINATION,
    canPush: true,
    key: (destination) => String(chatOf(destination)),
    describe: () => "this Telegram chat",
    send: async (tx, destination, message, now) => {
      enqueueReply(
        await tx.doc(TelegramOutbox),
        {
          id: message.id,
          chatId: chatOf(destination),
          text: message.text,
          ...(message.proactive === undefined
            ? {}
            : { proactive: { reminderId: message.proactive.sourceId } }),
        },
        now,
      );
    },
    // The private chat that wrote last (M6).
    ownerDestination: async (tx) => {
      const chat = (await tx.doc(TelegramChannel)).lastChat;
      return chat === undefined ? undefined : telegramDestination(chat);
    },
  },
  pending: {
    name: "telegram",
    docKinds: [TELEGRAM_DOC_KIND],
    readPending,
    clearSettled: async (tx, submissionIds) => {
      const state = await tx.doc(TelegramChannel);
      // Assigned, not filtered in place: a value assigned to a draft is copied.
      state.inputs = state.inputs
        .filter(({ submissionId }) => !submissionIds.has(submissionId))
        .map((input) => ({ ...input }));
    },
  },
};
