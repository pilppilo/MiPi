/**
 * MiPi's own per-conversation state, and which conversation each channel talks to. Every door goes through here, so
 * the profile, model and title of a conversation never depend on the door a message came through.
 */
import { configure, type ConversationId, defineDoc, defineDocFamily } from "./pi/durable.ts";
import { DEFAULT_PROFILE, isProfileName, type ProfileName, toolsFor } from "./profiles.ts";

type Tx = Parameters<typeof configure>[0];

export type ConversationMetaState = {
  /** Shown in the conversation list. Unset until the first message. */
  title?: string;
  /** The tool profile the conversation runs with. Unset on conversations older than profiles: `default`. */
  profile?: ProfileName;
};

export const ConversationMeta = defineDoc<ConversationMetaState>({
  kind: "app.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork keeps its parent's profile and title.
  fork: "current",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** Channels that open conversations, and the profile each starts them on. */
export type Channel = "web" | "telegram" | "relay";

export function startingProfile(channel: Channel, configured: ProfileName): ProfileName {
  return channel === "relay" ? "pidu" : configured;
}

/** A channel key (`web`, `tg:<chat_id>`, `relay:pidu`) mapped to the conversation it talks to. */
export const ChannelBindings = defineDocFamily<{ conversationId?: number }, null>({
  family: true,
  kind: "app.channel-binding",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
});

export function profileOf(meta: Readonly<ConversationMetaState> | undefined): ProfileName {
  return isProfileName(meta?.profile) ? meta.profile : DEFAULT_PROFILE;
}

/** Switches a conversation's profile: what it is offered changes from its next request. */
export async function setProfile(
  tx: Tx,
  conversationId: ConversationId,
  profile: ProfileName,
): Promise<void> {
  await configure(tx, conversationId, { tools: toolsFor(profile) });
  (await tx.doc(ConversationMeta, conversationId)).profile = profile;
}

/**
 * The conversation a channel key is bound to, creating and binding a new one on `profile` when there is none (or
 * when `rebind` asks for a fresh one, as Telegram's `/new` will).
 */
export async function boundConversation(
  tx: Tx,
  key: string,
  profile: ProfileName,
  options: { readonly rebind?: boolean; readonly existing?: ConversationId } = {},
): Promise<ConversationId> {
  const binding = await tx.doc(ChannelBindings, key, null);
  if (options.rebind !== true && binding.conversationId !== undefined) {
    const bound = await tx.conversation(binding.conversationId as ConversationId);
    if (bound !== undefined) return bound.id;
  }
  if (options.existing !== undefined) {
    // An existing conversation keeps its agent; one older than profiles only gets the name recorded.
    const meta = await tx.doc(ConversationMeta, options.existing);
    meta.profile ??= profile;
    binding.conversationId = options.existing;
    return options.existing;
  }
  const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await setProfile(tx, id, profile);
  binding.conversationId = id;
  return id;
}
