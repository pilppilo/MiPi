/**
 * Bots (COD-197): MiPi is the main bot, and every other bot is a conversation with a name and a purpose. A bot *is*
 * its conversation: its record is the bot fields on `app.conversation`, and the session's `app.bots` indexes them
 * (`conversations.ts`). Core code: the doors reach bots through their bindings (`boundConversation`).
 *
 * The first start of a build with bots makes MiPi and PiDu and archives every chat from before bots, in one commit
 * (`ensureBots`). The doors' bindings follow on their first read, since Pi Durable can't list a document family.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  configure,
  type ConversationId,
  type Cursor,
  type Harness,
  type Tx,
} from "./pi/durable.ts";
import { Bots, type BotsState, ConversationMeta, setProfile } from "./conversations.ts";
import { MAIN_PROFILE, type ProfileName, type Profiles } from "./profiles.ts";

/** The main bot's name. */
export const MAIN_BOT_NAME = "MiPi";

/** The relay's bot: relay input never runs with the main bot's tools (spec decision 5). */
export const RELAY_BOT_NAME = "PiDu";
export const RELAY_BOT_PURPOSE =
  "Answer messages relayed from PiDu, the owner's other assistant. Each one is the owner's own request, passed on.";

/** Bot names are 1 to 40 characters. */
export const BOT_NAME_MAX = 40;

/** A name as the index compares it: trimmed, lowercased. */
export const botNameKey = (name: string): string => name.trim().toLowerCase();

/** Why `name` can't name a new bot (or a renamed one, other than `self`), or undefined when it can. */
export function botNameRefusal(
  bots: Readonly<BotsState>,
  name: string,
  self?: number,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A bot needs a name.";
  if ([...trimmed].length > BOT_NAME_MAX)
    return `A bot's name is at most ${BOT_NAME_MAX} characters.`;
  const taken = bots.names?.[botNameKey(trimmed)];
  if (taken !== undefined && taken !== self) return `There is already a bot named ${trimmed}.`;
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
  const name = bot.name.trim();
  const purpose = bot.purpose?.trim();
  const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
  const meta = await tx.doc(ConversationMeta, id);
  // The kind first: only MiPi may run on `main` (`profileRefusal`).
  meta.kind = bot.kind;
  meta.name = name;
  meta.createdBy = bot.createdBy;
  if (purpose !== undefined && purpose.length > 0) {
    meta.purpose = purpose;
    // Its own section after every extension section: the preamble and its stamp rule stay, and it is fixed.
    await configure(tx, id, { instructions: purpose });
  }
  await setProfile(tx, id, bot.profile, profiles);
  bots.names = { ...bots.names, [botNameKey(name)]: id };
  return id;
}

/**
 * Makes MiPi (and PiDu) once: on the first start of a build with bots, and never again. In the same commit, every
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
    if (bots.mainId !== undefined) return false;
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
    const mainId = await createBot(
      tx,
      { kind: "main", name: MAIN_BOT_NAME, profile: MAIN_PROFILE, createdBy: "owner" },
      profiles,
    );
    const piduId = await createBot(
      tx,
      {
        kind: "bot",
        name: RELAY_BOT_NAME,
        purpose: RELAY_BOT_PURPOSE,
        profile: "pidu",
        createdBy: "owner",
      },
      profiles,
    );
    bots.mainId = mainId;
    bots.piduId = piduId;
    bots.madeAt = now;
    return true;
  }, BACKGROUND_CONTEXT);
}
