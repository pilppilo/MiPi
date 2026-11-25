import { defang } from "../lib/fence.ts";
import { isArchived } from "./archive.ts";
import { BOT_HOP_LIMIT, BOT_REPLY_KIND, BotHops } from "./bot-hops.ts";
import type { Delivery, DeliveryAdapter, DeliveryDestination } from "./delivery.ts";
import { heldUntil, measureToday, proactiveHold, runsOff } from "./gates.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type Tx,
} from "./pi/durable.ts";
import { expectProactive, Proactive } from "./proactive.ts";
import type { RunInput } from "./origin.ts";
import { BOT_ORIGIN } from "./bot-hops.ts";
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

type BotReply = {
  id: string;
  target: number;
  name: string;
  text: string;
  hop: number;
  ownerReply?: DeliveryDestination;
};

// pi-ledger L12: settlement queues replies durably. Each admission is a separate transaction.
export const BotReplies = defineDoc<{ pending: BotReply[] }>({
  kind: "app.bot-replies",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [] }),
  checkpointWhen: () => true,
});

/** Inherit the original owner route when a follow-up delegates again. */
export async function inheritedBotReply(tx: Tx, inputs: readonly RunInput[]) {
  const ids = new Set(
    inputs
      .filter(({ origin }) => origin.source === BOT_ORIGIN.source)
      .map(({ submissionId }) => submissionId),
  );
  if (ids.size === 0) return undefined;
  return (await tx.doc(Proactive)).pending.find(
    ({ submissionId, ownerReply }) => ids.has(submissionId) && ownerReply !== undefined,
  )?.ownerReply;
}

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
        ...(message.ownerReply === undefined ? {} : { ownerReply: { ...message.ownerReply } }),
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
    readonly ownerReply?: DeliveryDestination | undefined;
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
      ...(input.ownerReply === undefined ? {} : { ownerReply: input.ownerReply }),
    },
    now,
  );
  return submissionId;
}

/** Deliver pending replies, or return the next time their caps permit another try. */
export async function deliverBotReplies(
  harness: Harness,
  pending: readonly BotReply[],
  delivery: Delivery,
  now: number,
): Promise<number | undefined> {
  for (const reply of pending) {
    const conversation = await harness.conversation(
      reply.target as ConversationId,
      BACKGROUND_CONTEXT,
    );
    await harness.commit((tx) => measureToday(tx, now), BACKGROUND_CONTEXT);
    const next = await harness.commit(async (tx) => {
      const replies = await tx.doc(BotReplies);
      if (!replies.pending.some(({ id }) => id === reply.id)) return undefined;
      const requestId = `bot:reply:${reply.id}`;
      if (
        conversation !== undefined &&
        !(await isArchived(tx, conversation.id)) &&
        (await tx.submissionByRequest(conversation.id, requestId)) === undefined
      ) {
        const hold = await proactiveHold(tx, now);
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
            destination: reply.ownerReply ?? delivery.transcriptOf(conversation.id),
            ownerReply: reply.ownerReply,
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
