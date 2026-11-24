/**
 * MiPi's own per-conversation state, and which conversation each channel talks to. Every door goes through here, so
 * the profile, model and title of a conversation never depend on the door a message came through.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  configure,
  type ConversationId,
  type Cursor,
  defineDoc,
  defineDocFamily,
  type Extension,
  type Harness,
} from "./pi/durable.ts";
import { AgentSettings } from "./settings.ts";
import { DEFAULT_PROFILE, isProfileName, type ProfileName, type Profiles } from "./profiles.ts";

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

/**
 * Switches a conversation's profile: what it is offered changes from its next request. Only the tools change, never the
 * extensions it has switched off: Pi Durable offers a tool only while its extension is selected.
 */
export async function setProfile(
  tx: Tx,
  conversationId: ConversationId,
  profile: ProfileName,
  profiles: Profiles,
): Promise<void> {
  await configure(tx, conversationId, { tools: profiles.toolsFor(profile) });
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
  profiles: Profiles,
  options: { readonly rebind?: boolean; readonly existing?: ConversationId } = {},
): Promise<ConversationId> {
  const binding = await tx.doc(ChannelBindings, key, null);
  if (options.rebind !== true && binding.conversationId !== undefined) {
    const bound = await tx.conversation(binding.conversationId as ConversationId);
    if (bound !== undefined) return bound.id;
  }
  if (options.existing !== undefined) {
    // An existing conversation keeps its agent, model included. One older than profiles gets the profile, tools and
    // all: recording only the name left it showing a profile whose tools it didn't offer.
    const meta = await tx.doc(ConversationMeta, options.existing);
    if (meta.profile === undefined) await setProfile(tx, options.existing, profile, profiles);
    binding.conversationId = options.existing;
    return options.existing;
  }
  const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await setProfile(tx, id, profile, profiles);
  binding.conversationId = id;
  return id;
}

/**
 * Gives every conversation the tools its profile names, where they differ: a conversation older than profiles got its
 * profile's name but kept the tools it was created with, so it could show `default` and offer no `schedule`. Every
 * ownerless conversation counts, forks included; a subagent's conversation belongs to the tool that made it. Writes
 * nothing when all match. Returns the conversations it changed.
 */
export async function syncProfileTools(
  harness: Harness,
  profiles: Profiles,
): Promise<ConversationId[]> {
  const context = BACKGROUND_CONTEXT;
  // Once every conversation has its tools, new ones get them when they're made: the pass is needed again only when a
  // profile's tools change. Steady-state starts stop here, after one read.
  const digest = profiles.digest();
  const synced = await harness.commit(
    async (tx) => (await tx.doc(AgentSettings)).profileTools === digest,
    context,
  );
  if (synced) return [];
  const conversations = await harness.commit(async (tx) => {
    const found: Array<{ id: ConversationId; profile: ProfileName }> = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({}, 100, cursor);
      for (const record of page.items) {
        if (record.owner !== undefined) continue;
        found.push({
          id: record.id,
          profile: profileOf(await tx.doc(ConversationMeta, record.id)),
        });
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return found;
  }, context);
  const changed: ConversationId[] = [];
  for (const { id, profile } of conversations) {
    const conversation = await harness.conversation(id, context);
    if (conversation === undefined) continue;
    const agent = await conversation.agent(context);
    const offered = agent.tools.map(({ name }) => name).sort();
    // Only what its selected extensions provide: a switched-off extension's tools stay off (COD-209).
    const provided = new Set(
      agent.extensions.flatMap(({ tools }) => (tools ?? []).map(({ name }) => name)),
    );
    const expected = profiles
      .toolsFor(profile)
      .map(({ name }) => name)
      .filter((name) => provided.has(name))
      .sort();
    if (offered.join("\n") === expected.join("\n")) continue;
    // Only the tools and the profile's name: the model and everything else stay as they are.
    await harness.commit((tx) => setProfile(tx, id, profile, profiles), context);
    changed.push(id);
  }
  await harness.commit(async (tx) => {
    (await tx.doc(AgentSettings)).profileTools = digest;
  }, context);
  return changed;
}

/**
 * Sets which extensions a conversation has switched off: the whole list, as a `{ remove }` edit of the default selection
 * (never an array, so what stays selected keeps the default's order and the prompt prefix stays cacheable). An empty
 * list selects the default again. Only extensions the composition says are switchable may be passed (`composeAgent`).
 */
export async function setExtensionsOff(
  tx: Tx,
  conversationId: ConversationId,
  off: readonly Extension[],
): Promise<void> {
  await configure(tx, conversationId, {
    extensions: off.length === 0 ? null : { remove: [...off] },
  });
}
