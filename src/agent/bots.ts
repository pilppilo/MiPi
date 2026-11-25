/**
 * Bots (COD-197): MiPi is the main bot, and every other bot is a conversation with a name and a purpose. A bot *is*
 * its conversation: its record is the bot fields on `app.conversation`, and the session's `app.bots` indexes them
 * (`conversations.ts`). Core code: the doors reach bots through their bindings (`boundConversation`).
 *
 * The first start of a build with bots makes MiPi and archives every chat from before bots, in one commit
 * (`ensureBots`). Every door's binding follows to MiPi on its first read, the relay's included, since Pi Durable can't
 * list a document family. The relay can be pointed at a purpose bot of its own later (COD-199).
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  configure,
  type ConversationId,
  type Cursor,
  type Harness,
  type Tx,
} from "./pi/durable.ts";
import { archivedIn, backfillArchived } from "./archive.ts";
import { Bots, type BotsState, ConversationMeta, profileOf, setProfile } from "./conversations.ts";
import {
  DEFAULT_PROFILE,
  MAIN_PROFILE,
  PICKABLE_PROFILES,
  type ProfileName,
  type Profiles,
} from "./profiles.ts";

export const ACTIVE_BOT_LIMIT = 20;

/** The main bot's name. */
export const MAIN_BOT_NAME = "MiPi";

/** Bot names are 1 to 40 characters. */
export const BOT_NAME_MAX = 40;

/** A name as the index compares it: trimmed, lowercased. */
export const botNameKey = (name: string): string => name.trim().toLowerCase();

/** A cobot's display name is independent of the top-level bot name index. */
export function cobotNameRefusal(name: string): string | undefined {
  return nameRefusal(name, "cobot");
}

function nameRefusal(name: string, kind: "bot" | "cobot"): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return `A ${kind} needs a name.`;
  if ([...trimmed].length > BOT_NAME_MAX)
    return `A ${kind}'s name is at most ${BOT_NAME_MAX} characters.`;
  return undefined;
}

/** Why `name` can't name a new bot (or a renamed one, other than `self`), or undefined when it can. */
export function botNameRefusal(
  bots: Readonly<BotsState>,
  name: string,
  self?: number,
): string | undefined {
  const refused = nameRefusal(name, "bot");
  if (refused !== undefined) return refused;
  const trimmed = name.trim();
  const taken = bots.names?.[botNameKey(trimmed)];
  if (taken !== undefined && taken !== self) {
    // An archived bot keeps its name (COD-198), so restoring it never collides: say why, since it isn't listed.
    return archivedIn(bots, taken)
      ? `There is already an archived bot named ${trimmed}. Restore it or pick another name.`
      : `There is already a bot named ${trimmed}.`;
  }
  return undefined;
}

/** Creates a bot's conversation and records it: in the caller's commit. `purpose` becomes its instructions. */
export async function createBot(
  tx: Tx,
  bot: {
    readonly kind: "main" | "bot";
    readonly name: string;
    readonly purpose?: string;
    readonly profile: ProfileName;
    readonly createdBy: string;
  },
  profiles: Profiles,
): Promise<ConversationId> {
  const bots = await tx.doc(Bots);
  const refused = botNameRefusal(bots, bot.name);
  if (refused !== undefined) throw new Error(refused);
  if (bot.kind === "bot") {
    if (!PICKABLE_PROFILES.includes(bot.profile)) {
      throw new Error(
        `${bot.profile} can't be a bot's profile: pick one of ${PICKABLE_PROFILES.join(", ")}.`,
      );
    }
    const active = Object.values(bots.names ?? {}).filter(
      (id) => id !== bots.mainId && !archivedIn(bots, id),
    );
    if (active.length >= ACTIVE_BOT_LIMIT)
      throw new Error(`There are already ${ACTIVE_BOT_LIMIT} active purpose bots.`);
  }
  const id = await createBotConversation(tx, bot, profiles);
  bots.names = { ...bots.names, [botNameKey(bot.name)]: id };
  return id;
}

/** Opens an independent side chat on the bot's purpose and profile as they are now. */
export async function createCobot(
  tx: Tx,
  bot: ConversationId,
  name: string,
  profiles: Profiles,
): Promise<ConversationId> {
  return (await prepareCobot(tx, bot, name, profiles))();
}

/** Read the parent before a caller admits an input or makes another table write in the same commit. */
export async function prepareCobot(
  tx: Tx,
  bot: ConversationId,
  name: string,
  profiles: Profiles,
): Promise<() => Promise<ConversationId>> {
  const refused = cobotNameRefusal(name);
  if (refused !== undefined) throw new Error(refused);
  const record = await tx.conversation(bot);
  if (record === undefined || record.owner !== undefined) {
    throw new Error("A cobot needs a live parent bot.");
  }
  const parent = await tx.doc(ConversationMeta, bot);
  if (
    (parent.kind !== "main" && parent.kind !== "bot") ||
    parent.archivedAt !== undefined ||
    archivedIn(await tx.doc(Bots), bot)
  ) {
    throw new Error("A cobot needs a live parent bot.");
  }
  const purpose = parent.purpose;
  const profile = parent.kind === "main" ? DEFAULT_PROFILE : profileOf(parent);
  return () =>
    createBotConversation(
      tx,
      { kind: "cobot", bot, name, purpose, profile, createdBy: "owner" },
      profiles,
    );
}

async function createBotConversation(
  tx: Tx,
  bot: {
    readonly name: string;
    readonly purpose?: string | undefined;
    readonly profile: ProfileName;
    readonly createdBy: string;
  } & (
    | { readonly kind: "main" | "bot" }
    | { readonly kind: "cobot"; readonly bot: ConversationId }
  ),
  profiles: Profiles,
): Promise<ConversationId> {
  const name = bot.name.trim();
  const purpose = bot.purpose?.trim();
  const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
  const meta = await tx.doc(ConversationMeta, id);
  // The kind first: only MiPi may run on `main` (`profileRefusal`).
  meta.kind = bot.kind;
  if (bot.kind === "cobot") meta.bot = bot.bot;
  meta.name = name;
  meta.createdBy = bot.createdBy;
  if (purpose !== undefined && purpose.length > 0) {
    meta.purpose = purpose;
    // Its own section after every extension section: the preamble and its stamp rule stay, and it is fixed.
    await configure(tx, id, { instructions: purpose });
  }
  await setProfile(tx, id, bot.profile, profiles);
  return id;
}

/**
 * Makes MiPi once: on the first start of a build with bots, and never again. In the same commit, every
 * ownerless chat from before bots is archived (`archivedAt`), to wait for Settings → Archived (COD-201) rather than
 * fill the bots list. Their transcripts, reminders and relay receipts are untouched. Returns whether it made them.
 */
export async function ensureBots(
  harness: Harness,
  profiles: Profiles,
  now: number,
): Promise<boolean> {
  return harness.commit(async (tx) => {
    const bots = await tx.doc(Bots);
    if (bots.mainId !== undefined) {
      // Made by a build before archive (COD-198): its archived chats join the index once.
      await backfillArchived(tx, bots);
      return false;
    }
    // Reads first: the older chats, before this commit creates anything.
    const older: ConversationId[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({}, 100, cursor);
      for (const record of page.items) {
        if (record.owner !== undefined) continue;
        const meta = await tx.doc(ConversationMeta, record.id);
        if (meta.kind === undefined && meta.archivedAt === undefined) older.push(record.id);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    for (const id of older) (await tx.doc(ConversationMeta, id)).archivedAt = now;
    bots.archived = Object.fromEntries(older.map((id) => [String(id), now]));
    const mainId = await createBot(
      tx,
      { kind: "main", name: MAIN_BOT_NAME, profile: MAIN_PROFILE, createdBy: "owner" },
      profiles,
    );
    bots.mainId = mainId;
    bots.madeAt = now;
    return true;
  }, BACKGROUND_CONTEXT);
}

/** Renames a bot or cobot in the caller’s commit. Only top-level bot names are indexed. */
export async function renameBot(tx: Tx, id: ConversationId, name: string): Promise<void> {
  const meta = await tx.doc(ConversationMeta, id);
  if (meta.kind === undefined || meta.archivedAt !== undefined) {
    throw new Error("Only a bot can be renamed.");
  }
  if (meta.kind === "cobot") {
    const refused = cobotNameRefusal(name);
    if (refused !== undefined) throw new Error(refused);
    meta.name = name.trim();
    return;
  }
  const bots = await tx.doc(Bots);
  const refused = botNameRefusal(bots, name, id);
  if (refused !== undefined) throw new Error(refused);
  const trimmed = name.trim();
  const names = { ...bots.names };
  if (meta.name !== undefined && names[botNameKey(meta.name)] === id) {
    delete names[botNameKey(meta.name)];
  }
  names[botNameKey(trimmed)] = id;
  bots.names = names;
  meta.name = trimmed;
}

/** A live bot, as a door lists it. */
export type LiveBot = {
  readonly id: ConversationId;
  readonly kind: "main" | "bot";
  readonly name: string;
  readonly purpose?: string;
};

/**
 * The live bots in the web list's order: MiPi first, then the purpose bots as they were made. From the name index, so
 * it never scans conversations; an archived bot (COD-198) drops out.
 */
export async function liveBots(tx: Tx): Promise<LiveBot[]> {
  const bots = await tx.doc(Bots);
  const ids = [...new Set(Object.values(bots.names ?? {}))].sort((left, right) => left - right);
  const found: LiveBot[] = [];
  for (const id of ids) {
    const meta = await tx.doc(ConversationMeta, id as ConversationId);
    if (meta.archivedAt !== undefined || meta.name === undefined) continue;
    if (meta.kind !== "main" && meta.kind !== "bot") continue;
    found.push({
      id: id as ConversationId,
      kind: meta.kind,
      name: meta.name,
      ...(meta.purpose === undefined ? {} : { purpose: meta.purpose }),
    });
  }
  return found.sort((left, right) =>
    left.kind === right.kind ? left.id - right.id : left.kind === "main" ? -1 : 1,
  );
}

/** The live bot named `name` (the whole name, ignoring case and surrounding space), if there is one. */
export async function findLiveBot(tx: Tx, name: string): Promise<LiveBot | undefined> {
  const id = (await tx.doc(Bots)).names?.[botNameKey(name)];
  return id === undefined ? undefined : (await liveBots(tx)).find((bot) => bot.id === id);
}
