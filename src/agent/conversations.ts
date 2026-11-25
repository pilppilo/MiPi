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
import {
  DEFAULT_PROFILE,
  isProfileName,
  MAIN_PROFILE,
  PICKABLE_PROFILES,
  type ProfileName,
  RELAY_PROFILE,
  type Profiles,
} from "./profiles.ts";

type Tx = Parameters<typeof configure>[0];

/** What a conversation is since bots (COD-197): absent on a conversation older than bots. */
export type BotKind = "main" | "bot" | "cobot";

export type ConversationMetaState = {
  /** Shown in the conversation list. Unset until the first message. */
  title?: string;
  /** The tool profile the conversation runs with. Unset on conversations older than profiles: `default`. */
  profile?: ProfileName;
  // Bot fields (COD-197), all optional so the document stays version 1: an older build ignores them. The bot index
  // (names, the main bot) is the session's `app.bots` (`bots.ts`).
  /** `main` (MiPi), `bot` (a purpose bot) or `cobot`. Absent: a chat from before bots. */
  kind?: BotKind;
  /** A bot's name, as its owner wrote it. Unique among bots, ignoring case. */
  name?: string;
  /** A purpose bot's purpose: also its `instructions`, so it is fixed and its prompt prefix stays cached. */
  purpose?: string;
  /** A cobot's bot (its conversation id). */
  bot?: number;
  /** `owner`, or `bot:<name>` for a bot made by another bot. */
  createdBy?: string;
  /** When it was archived. A chat from before bots is archived when MiPi is made. */
  archivedAt?: number;
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

/**
 * The profile a channel starts a conversation on, where it still starts one (an agent without MiPi). Every door the
 * same since bots (COD-197): the relay reaches MiPi like the others, and `pidu` is only its chats from before.
 */
export function startingProfile(_channel: Channel, configured: ProfileName): ProfileName {
  return configured;
}

/**
 * A channel key (`web`, `tg:<chat_id>`, `relay:pidu`) mapped to the conversation it talks to. `bots` marks a binding
 * written since bots (COD-197): one without it, read once MiPi exists, still points where an older build left it and
 * moves to its bot (`resolveBinding`).
 */
export const ChannelBindings = defineDocFamily<{ conversationId?: number; bots?: true }, null>({
  family: true,
  kind: "app.channel-binding",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** Drops the bot fields from a conversation's meta: a fork is a chat of its own, not a copy of its bot. */
export function clearBotFields(meta: ConversationMetaState): void {
  delete meta.kind;
  delete meta.name;
  delete meta.purpose;
  delete meta.bot;
  delete meta.createdBy;
  delete meta.archivedAt;
}

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
  const meta = await tx.doc(ConversationMeta, conversationId);
  const refused = profileRefusal(meta, profile);
  if (refused !== undefined) throw new Error(refused);
  await configure(tx, conversationId, { tools: profiles.toolsFor(profile) });
  meta.profile = profile;
}

/**
 * Why a conversation can't switch to `profile` (COD-197): MiPi alone runs on `main`, and always does, and no
 * conversation newly takes `pidu`, kept only for the relay's chats from before bots. Its current profile can always be
 * applied again (the startup sync does).
 */
export function profileRefusal(
  meta: Readonly<Pick<ConversationMetaState, "kind" | "profile">>,
  profile: ProfileName,
): string | undefined {
  if (meta.kind === "main" && profile !== MAIN_PROFILE)
    return "MiPi always runs on the main profile.";
  if (meta.kind !== "main" && profile === MAIN_PROFILE)
    return "Only MiPi runs on the main profile.";
  if (profile === RELAY_PROFILE && meta.profile !== RELAY_PROFILE) {
    return `${RELAY_PROFILE} is kept for the relay's chats from before bots. Pick one of: ${PICKABLE_PROFILES.join(", ")}.`;
  }
  return undefined;
}

/**
 * The bots (COD-197): which conversation is MiPi, and every bot's name. A session document,
 * so finding a bot by name (and, later, counting the active ones) never scans conversations. Written once by
 * `ensureBots` (`bots.ts`), then as bots are made and renamed.
 */
export type BotsState = {
  /** MiPi, the main bot. Unset until the first start of a build with bots. */
  mainId?: number;
  /** Every bot's name, lowercased, to its conversation. */
  names?: Record<string, number>;
  /** When MiPi was made, and older chats archived. */
  madeAt?: number;
};

export const Bots = defineDoc<BotsState>({
  kind: "app.bots",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/**
 * The conversation a channel key is bound to.
 *
 * Once MiPi exists (`Bots.mainId`), a binding written before bots, or none at all, moves to its bot on its first read
 * and is marked `bots`: so every door, the relay's too, reaches MiPi without core having to list the doors' keys, which
 * Pi Durable can't do for a document family. A binding marked `bots` stays where it is (a `/bot` choice survives a
 * restart). `rebind` binds a new chat of its own, as Telegram's `/new` does until cobots (COD-200).
 *
 * Before MiPi exists (an agent opened without `ensureBots`), an unbound key gets a new conversation on `profile`.
 */
export async function boundConversation(
  tx: Tx,
  key: string,
  profile: ProfileName,
  profiles: Profiles,
  options: { readonly rebind?: boolean } = {},
): Promise<ConversationId> {
  const binding = await tx.doc(ChannelBindings, key, null);
  const bots = await tx.doc(Bots);
  if (options.rebind !== true) {
    // pi-ledger L10: an unmarked binding moves to MiPi here, on its first read, since bindings can't be listed.
    const target = binding.bots === true ? binding.conversationId : bots.mainId;
    const current = target ?? binding.conversationId;
    if (current !== undefined) {
      const bound = await tx.conversation(current as ConversationId);
      if (bound === undefined) {
        // MiPi or a bound bot gone means the data is broken: say so rather than quietly start another chat.
        if (target !== undefined) throw new Error(`Conversation ${current} for ${key} is missing`);
      } else {
        if (target !== undefined && binding.bots !== true) {
          binding.conversationId = bound.id;
          binding.bots = true;
        }
        return bound.id;
      }
    }
  }
  const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await setProfile(tx, id, profile, profiles);
  binding.conversationId = id;
  if (bots.mainId !== undefined) binding.bots = true;
  return id;
}

/** Binds a channel key to a conversation, marked as chosen since bots: it stays there across restarts (`/bot`). */
export async function bindChannel(
  tx: Tx,
  key: string,
  conversationId: ConversationId,
): Promise<void> {
  const binding = await tx.doc(ChannelBindings, key, null);
  binding.conversationId = conversationId;
  binding.bots = true;
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
