// Adapted from pi-pocket src/server/titles.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
/**
 * Titles for every conversation, whichever door its first message came through. The first message names the
 * conversation at once; a long one is then renamed by the conversation's own model: never another model picked on the
 * side, since nobody chose that one and it may cost what nobody agreed to. What the title costs counts as the
 * conversation's spend, in `pi.usage`, like Pi Durable's own requests.
 */
import type { MutableModels, Usage } from "./pi/ai.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import { type ConversationId, type Harness, ProviderDoc, UsageDoc } from "./pi/durable.ts";
import { ConversationMeta } from "./conversations.ts";
import {
  cleanTitle,
  firstTitle,
  TITLE_PROMPT,
  TITLE_READ_CHARS,
  wantsTitle,
} from "../lib/titles.ts";

const context = BACKGROUND_CONTEXT;

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    total.cost[key] += usage.cost[key];
  }
}

/**
 * Names an untitled conversation after its first message, in the caller's commit. Returns the title it gave when the
 * model should be asked for a better one (`writeTitle`), otherwise undefined.
 */
export async function nameFromFirstMessage(
  tx: Parameters<Parameters<Harness["commit"]>[0]>[0],
  conversationId: ConversationId,
  text: string,
): Promise<string | undefined> {
  const meta = await tx.doc(ConversationMeta, conversationId);
  if (meta.title !== undefined) return undefined;
  const provisional = firstTitle(text);
  meta.title = provisional;
  return wantsTitle(text) ? provisional : undefined;
}

/**
 * Asks the conversation's model for a title and uses it if the conversation still has `provisional`. Failures, and
 * replies that are no title or were cut off, keep the first title. Resolves true when the title changed.
 */
export async function writeTitle(
  harness: Harness,
  models: MutableModels,
  conversationId: ConversationId,
  text: string,
  provisional: string,
  report: (error: unknown) => void = () => {},
): Promise<boolean> {
  try {
    const conversation = await harness.conversation(conversationId, context);
    const ref = (await conversation?.agent(context))?.model;
    const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
    if (model === undefined) return false;
    // The conversation's own identity with the provider, as Pi Durable sends with its requests: OpenCode Go refuses a
    // request without one. A conversation that has none yet gets it, as Pi Durable gives it before its next request.
    const sessionId =
      (await harness.snapshot(ProviderDoc, conversationId, context))?.sessionId ??
      (await harness.commit(
        async (tx) => (await tx.doc(ProviderDoc, conversationId)).sessionId,
        context,
      ));
    const reply = await models.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${TITLE_PROMPT}\n\n<message>\n${text.slice(0, TITLE_READ_CHARS)}\n</message>`,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 1024, cacheRetention: "none", sessionId },
    );
    const title = cleanTitle(
      reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    );
    return await harness.commit(async (tx) => {
      const usage = await tx.doc(UsageDoc, conversationId);
      const key = `${model.provider}/${model.id}`;
      usage.models[key] ??= zeroUsage();
      addUsage(usage.models[key] as Usage, reply.usage);
      // Only a reply that ended by itself: one cut off at the token limit is a model that went on, not a title.
      if (title === undefined || reply.stopReason !== "stop") return false;
      const meta = await tx.doc(ConversationMeta, conversationId);
      if (meta.title !== provisional) return false;
      meta.title = title;
      return true;
    }, context);
  } catch (error) {
    report(error);
    return false;
  }
}
