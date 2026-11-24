/**
 * Side model calls (COD-209): a request a part of the agent makes outside Pi Durable's runs, such as a title or the
 * memory pass. It goes to the conversation's own model (never another model picked on the side, since nobody chose
 * that one and it may cost what nobody agreed to), with the conversation's provider identity and no cache retention,
 * and its spend counts as the conversation's, in `pi.usage`, like Pi Durable's own requests.
 *
 */
import { observeSideResponse } from "./limits.ts";
import type { AssistantMessage, MutableModels, Usage } from "./pi/ai.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import { type ConversationId, type Harness, ProviderDoc, UsageDoc } from "./pi/durable.ts";

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

/** Adds a request's spend to the conversation's `pi.usage`, in the caller's commit, as Pi Durable's own requests do. */
export async function recordUsage(
  tx: Parameters<Parameters<Harness["commit"]>[0]>[0],
  conversationId: ConversationId,
  model: { readonly provider: string; readonly id: string },
  usage: Usage,
): Promise<void> {
  const ledger = await tx.doc(UsageDoc, conversationId);
  const key = `${model.provider}/${model.id}`;
  ledger.models[key] ??= zeroUsage();
  addUsage(ledger.models[key] as Usage, usage);
}

/** The conversation's identity with the provider (OpenCode Go refuses a request without one), given if it has none. */
export async function providerSession(
  harness: Harness,
  conversationId: ConversationId,
): Promise<string> {
  return (
    (await harness.snapshot(ProviderDoc, conversationId, context))?.sessionId ??
    (await harness.commit(
      async (tx) => (await tx.doc(ProviderDoc, conversationId)).sessionId,
      context,
    ))
  );
}

/** The model a side call used, as `recordUsage` keys it. */
export type SideCallModel = { readonly provider: string; readonly id: string };

/**
 * Asks the conversation's model one user message. Resolves undefined when the conversation or its model is gone;
 * throws what the provider throws. The caller records `reply.usage` with `recordUsage`, in the commit that uses the
 * reply, so the spend and what it bought are stored together.
 */
export async function sideCall(
  harness: Harness,
  models: MutableModels,
  conversationId: ConversationId,
  request: { readonly text: string; readonly maxTokens: number },
): Promise<
  | {
      readonly model: SideCallModel;
      readonly reply: AssistantMessage;
      readonly planLimited: boolean;
    }
  | undefined
> {
  const conversation = await harness.conversation(conversationId, context);
  const ref = (await conversation?.agent(context))?.model;
  const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
  if (model === undefined) return undefined;
  // The conversation's own identity with the provider, as Pi Durable sends with its requests: OpenCode Go refuses a
  // request without one. A conversation that has none yet gets it, as Pi Durable gives it before its next request.
  const sessionId = await providerSession(harness, conversationId);
  const reply = await models.completeSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.text }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: request.maxTokens, cacheRetention: "none", sessionId },
  );
  const planLimited = (await observeSideResponse(harness, reply, Date.now())) !== undefined;
  return { model, reply, planLimited };
}
