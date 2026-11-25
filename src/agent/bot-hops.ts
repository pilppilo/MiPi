import { defineDoc, type Tx } from "./pi/durable.ts";

export const BOT_ORIGIN = { prefix: "bot", source: "bot", automated: true } as const;
export const BOT_HOP_LIMIT = 3;
export const BOT_REPLY_KIND = "bot";
export const BOT_TRANSCRIPT_KIND = "bot-transcript";

/** pi-ledger L12: hops belong to submitted inputs, including across restart and mixed runs. */
export const BotHops = defineDoc<Record<string, number>>({
  kind: "app.bot-hops",
  scope: "session",
  version: 1,
  initial: () => ({}),
  checkpointWhen: () => true,
});

export async function maxBotHop(
  tx: Tx,
  inputs: readonly { readonly submissionId: number }[],
): Promise<number> {
  const hops = await tx.doc(BotHops);
  return inputs.reduce(
    (highest, { submissionId }) => Math.max(highest, hops[submissionId] ?? 0),
    0,
  );
}
