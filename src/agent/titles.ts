// Adapted from pi-pocket src/server/titles.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
/**
 * Titles for every conversation, whichever door its first message came through. The first message names the
 * conversation at once; a long one is then renamed by the conversation's own model: never another model picked on the
 * side, since nobody chose that one and it may cost what nobody agreed to. What the title costs counts as the
 * conversation's spend, in `pi.usage`, like Pi Durable's own requests.
 */
import type { MutableModels } from "./pi/ai.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import type { ConversationId, Harness } from "./pi/durable.ts";
import { ConversationMeta } from "./conversations.ts";
import { recordUsage, sideCall } from "./side-calls.ts";
import {
  cleanTitle,
  firstTitle,
  TITLE_PROMPT,
  TITLE_READ_CHARS,
  wantsTitle,
} from "../lib/titles.ts";

const context = BACKGROUND_CONTEXT;

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
    const call = await sideCall(harness, models, conversationId, {
      text: `${TITLE_PROMPT}\n\n<message>\n${text.slice(0, TITLE_READ_CHARS)}\n</message>`,
      maxTokens: 1024,
    });
    if (call === undefined) return false;
    const { model, reply } = call;
    const title = cleanTitle(
      reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    );
    return await harness.commit(async (tx) => {
      await recordUsage(tx, conversationId, model, reply.usage);
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
