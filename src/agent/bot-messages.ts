import { defang } from "../lib/fence.ts";
import { isArchived } from "./archive.ts";
import { BOT_HOP_LIMIT, BOT_REPLY_KIND, BOT_TRANSCRIPT_KIND, BotHops } from "./bot-hops.ts";
import type { DeliveryAdapter, DeliveryDestination } from "./delivery.ts";
import { heldUntil, holdNow, proactiveHold, runsOff } from "./gates.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type Tx,
} from "./pi/durable.ts";
import { expectProactive } from "./proactive.ts";
import { AgentSettings } from "./settings.ts";
import { stampInput } from "./stamp.ts";

export function botInput(
  name: string,
  text: string,
  zone: string | undefined,
  now: number,
): string {
  const speaker = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}[\]<>]/gu, " ").trim();
  return stampInput(`bot:${speaker}`, `<bot_message>\n${defang(text)}\n</bot_message>`, zone, now);
}

// Entries don't link back to their submission while scanning a transcript (ledger L8).
export function isFencedBotInput(text: string): boolean {
  return /^\[bot:[^\n]+\]\n<bot_message>\n/.test(text);
}

type BotReply = {
  id: string;
  target: number;
  name: string;
  text: string;
  hop: number;
};

// pi-ledger L12: settlement queues replies durably. Each admission is a separate transaction.
export const BotReplies = defineDoc<{ pending: BotReply[] }>({
  kind: "app.bot-replies",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [] }),
  checkpointWhen: () => true,
});

export const botReplyDelivery: DeliveryAdapter = {
  kind: BOT_REPLY_KIND,
  canPush: true,
  key: ({ conversationId }) => `bot:${conversationId}`,
  describe: () => "the sending bot",
  send: async (tx, destination, message) => {
    const { conversationId, name, hop } = destination;
    if (typeof conversationId !== "number" || typeof name !== "string" || typeof hop !== "number") {
      throw new Error("Invalid stored bot reply destination");
    }
    const replies = await tx.doc(BotReplies);
    if (replies.pending.some(({ id }) => id === message.id)) return;
    replies.pending = [
      ...replies.pending,
      {
        id: message.id,
        target: conversationId,
        name,
        text: message.text,
        hop: Math.max(hop, message.botHop ?? 0),
      },
    ];
  },
};

// pi-ledger L12: every bot input is admitted with its hop and answer expectation in the same commit.
export async function admitBotInput(
  tx: Tx,
  conversation: Pick<Conversation, "id" | "admit">,
  input: {
    readonly requestId: string;
    readonly sender: string;
    readonly text: string;
    readonly destination: DeliveryDestination;
    readonly hop: number;
  },
  now: number,
) {
  const { requestId, sender, text, destination, hop } = input;
  const zone = (await tx.doc(AgentSettings)).timeZone;
  const submissionId = await conversation.admit(tx, {
    type: "input",
    requestId,
    content: botInput(sender, text, zone, now),
    whenBusy: "followUp",
  });
  (await tx.doc(BotHops))[submissionId] = hop;
  await expectProactive(
    tx,
    {
      submissionId,
      sourceId: requestId,
      instruction: text,
      conversationId: conversation.id,
      destination,
    },
    now,
  );
  return submissionId;
}

/** Deliver pending replies, or return the next time their caps permit another try. */
export async function deliverBotReplies(
  harness: Harness,
  pending: readonly BotReply[],
  now: number,
): Promise<number | undefined> {
  for (const reply of pending) {
    const conversation = await harness.conversation(
      reply.target as ConversationId,
      BACKGROUND_CONTEXT,
    );
    const next = await harness.commit(async (tx) => {
      const replies = await tx.doc(BotReplies);
      if (!replies.pending.some(({ id }) => id === reply.id)) return undefined;
      const requestId = `bot:reply:${reply.id}`;
      if (
        conversation !== undefined &&
        !(await isArchived(tx, conversation.id)) &&
        (await tx.submissionByRequest(conversation.id, requestId)) === undefined
      ) {
        const hold = (await holdNow(tx, now)) ?? (await proactiveHold(tx, now));
        // A deployment that disables background runs can resume the replies when it is enabled again.
        if (hold !== undefined) {
          if (hold === "paused" || (await runsOff(tx))) return Infinity;
          return heldUntil(tx, hold, now, true);
        }
        await admitBotInput(
          tx,
          conversation,
          {
            requestId,
            sender: reply.name,
            text: reply.text,
            destination: { kind: BOT_TRANSCRIPT_KIND },
            hop: Math.min(reply.hop, BOT_HOP_LIMIT),
          },
          now,
        );
      }
      replies.pending = replies.pending.filter(({ id }) => id !== reply.id);
      return undefined;
    }, BACKGROUND_CONTEXT);
    if (next !== undefined) return next;
  }
  return undefined;
}
