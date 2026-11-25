/**
 * Archive and restore (COD-198): an archived bot stops working and keeps all its data; restoring brings it all back.
 * Core code. The session's `app.bots` holds the archive index (`archived`), the channel keys that fell back to MiPi
 * (`released`) and the one-time reminders held meanwhile (`held`), so visibility, the doors and the schedules each
 * answer from one session document, never by reading every conversation's.
 *
 * Schedules reach this through `routeSchedule` and `holdReminder`: the reminders ask before each occurrence, and core
 * never reads their tasks. Pi Durable 1.6 can't pause a task, so nothing here stops one: an archived bot's repeat skips
 * its times and a one-time reminder parks itself here and ends (pi-ledger L11).
 *
 * A chat from before bots, archived when MiPi was made (COD-197), is archived too, but its reminders are the owner's
 * and keep running: they run in MiPi instead, so an archived conversation never runs one itself. Restoring one makes it
 * a cobot under MiPi (COD-201), and its reminders run in it again.
 */
import { type Context } from "./pi/context.ts";
import {
  abortConversation,
  type ConversationId,
  type Cursor,
  type Harness,
  type Tx,
} from "./pi/durable.ts";
import {
  type BotKind,
  Bots,
  type BotsState,
  ChannelBindings,
  ConversationMeta,
  type ConversationMetaState,
  type HeldReminder,
  profileOf,
  setProfile,
} from "./conversations.ts";
import type { Delivery, DeliveryDestination } from "./delivery.ts";
import { isPaused } from "./gates.ts";
import { DEFAULT_PROFILE, RELAY_PROFILE, type Profiles } from "./profiles.ts";
import { expectProactive, recentProactiveSends } from "./proactive.ts";
import { AgentSettings } from "./settings.ts";
import { DEFAULT_TIME_ZONE, localTime } from "./stamp.ts";
import { formatReminder } from "../protocol.ts";

export type { HeldReminder };

/** What a door says to a message for an archived conversation. */
export const ARCHIVED_REPLY = "This bot is archived. Restore it to talk to it again.";

/** `BOT_NAME_MAX` (`bots.ts`), kept here because `bots.ts` imports this module. */
const NAME_MAX = 40;

/** The refusal for a message or change to an archived conversation, worded for what it is (COD-201). */
export function archivedReply(kind: BotKind | undefined): string {
  switch (kind) {
    case undefined:
      return "This chat is archived. Restore it to talk to it again.";
    case "cobot":
      return "This cobot is archived with its bot. Restore the bot to talk to it again.";
    case "main":
    case "bot":
      return ARCHIVED_REPLY;
    default: {
      const _: never = kind;
      return ARCHIVED_REPLY;
    }
  }
}

/** `archivedReply` for `id` when it is archived, in a commit; undefined when it is live. */
export async function archivedRefusal(tx: Tx, id: number): Promise<string | undefined> {
  if (!(await isArchived(tx, id))) return undefined;
  return archivedReply((await tx.doc(ConversationMeta, id as ConversationId)).kind);
}

/** Whether a conversation is archived, from the session index alone. */
export function archivedIn(bots: Readonly<BotsState>, id: number): boolean {
  return bots.archived?.[String(id)] !== undefined;
}

/** `archivedIn`, in a commit. */
export async function isArchived(tx: Tx, id: number): Promise<boolean> {
  return archivedIn(await tx.doc(Bots), id);
}

/** Where a schedule made in a conversation runs now. */
export type ScheduleRoute =
  | { readonly kind: "run"; readonly conversationId: ConversationId }
  | { readonly kind: "held" };

/**
 * Where a scheduled occurrence for `conversationId` runs: there, while it is live; in MiPi, for a chat from before bots
 * (archived when MiPi was made, its reminders kept); nowhere (`held`) for an archived bot or cobot.
 */
export async function routeSchedule(tx: Tx, conversationId: number): Promise<ScheduleRoute> {
  const bots = await tx.doc(Bots);
  if (!archivedIn(bots, conversationId)) {
    return { kind: "run", conversationId: conversationId as ConversationId };
  }
  const meta = await tx.doc(ConversationMeta, conversationId as ConversationId);
  if (meta.kind === undefined && bots.mainId !== undefined) {
    return { kind: "run", conversationId: bots.mainId as ConversationId };
  }
  return { kind: "held" };
}

/**
 * The destination a schedule's answer goes to when it runs in `to` instead of `from`: a conversation's own transcript
 * follows it to `to`; any other place (a Telegram chat) stays.
 */
export function routedDestination(
  delivery: Delivery,
  destination: DeliveryDestination,
  from: number,
  to: number,
): DeliveryDestination {
  if (from === to) return destination;
  return delivery.identity(destination) === delivery.identity(delivery.transcriptOf(from))
    ? delivery.transcriptOf(to)
    : destination;
}

/** Parks a one-time reminder that came due while its bot was archived, in the caller's commit. Once per id. */
export async function holdReminder(tx: Tx, held: HeldReminder): Promise<void> {
  // pi-ledger L11: parked here because Pi Durable can't pause the reminder's task.
  const bots = await tx.doc(Bots);
  if (bots.held?.some(({ id }) => id === held.id) === true) return;
  bots.held = [...(bots.held ?? []), { ...held, destination: { ...held.destination } }];
}

/** A bot's cobots (COD-200), by scanning: archive and restore are the owner's, and rare. */
async function cobotsOf(
  tx: Tx,
  botId: ConversationId,
  keep: (archivedAt: number | undefined) => boolean,
): Promise<ConversationId[]> {
  const found: ConversationId[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const record of page.items) {
      if (record.owner !== undefined || record.id === botId) continue;
      const meta = await tx.doc(ConversationMeta, record.id);
      if (meta.kind === "cobot" && meta.bot === botId && keep(meta.archivedAt)) {
        found.push(record.id);
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** Why a conversation can't be archived, or undefined. Only a purpose bot is: its cobots go with it. */
function archiveRefusal(kind: BotKind | undefined): string | undefined {
  switch (kind) {
    case "main":
      return "MiPi can't be archived.";
    case "bot":
      return undefined;
    case "cobot":
    case undefined:
      return "Only a bot can be archived.";
    default: {
      const _: never = kind;
      return "Only a bot can be archived.";
    }
  }
}

/**
 * Archives a bot and its cobots in the caller's commit: each gets `archivedAt` and joins the index, so from this
 * commit on nothing lists it, no door reaches it and its schedules hold. Returns the conversations archived now (none
 * when it already was), whose in-flight work the caller then aborts (`abortArchived`).
 */
export async function archiveBot(
  tx: Tx,
  id: ConversationId,
  now: number,
): Promise<ConversationId[]> {
  const meta = await tx.doc(ConversationMeta, id);
  const refused = archiveRefusal(meta.kind);
  if (refused !== undefined) throw new Error(refused);
  if (meta.archivedAt !== undefined) return [];
  const ids = [id, ...(await cobotsOf(tx, id, (archivedAt) => archivedAt === undefined))];
  const bots = await tx.doc(Bots);
  const archived = { ...bots.archived };
  for (const conversationId of ids) {
    (await tx.doc(ConversationMeta, conversationId)).archivedAt = now;
    archived[String(conversationId)] = now;
  }
  bots.archived = archived;
  return ids;
}

/**
 * Stops what archived conversations are doing: queued inputs withdrawn, runs aborted, then idle. Their reminders are
 * background tasks and survive: they hold on their own (`routeSchedule`).
 */
export async function abortArchived(
  harness: Harness,
  ids: readonly ConversationId[],
  context: Context,
): Promise<void> {
  for (const id of ids) {
    const conversation = await harness.conversation(id, context);
    if (conversation !== undefined) await abortConversation(conversation, context);
  }
}

/** What `restoreBot` did: the conversations restored now, and those whose held reminders to send (`replayHeld`). */
export type Restored = {
  readonly restored: ConversationId[];
  readonly conversations: ConversationId[];
};

/**
 * Restores an archived conversation in the caller's commit (COD-201 widened it from bots):
 * - a purpose bot, with the cobots archived with it (`restoreBotTree`);
 * - a cobot only while its bot is live: one archived with its bot comes back with it, never on its own under another
 *   bot, whose purpose would contradict its history and break its cached prompt;
 * - a chat from before bots becomes a cobot under MiPi (`restoreEarlierChat`).
 * MiPi is never archived, so never restored.
 */
export async function restoreBot(
  tx: Tx,
  id: ConversationId,
  profiles: Profiles,
): Promise<Restored> {
  const meta = await tx.doc(ConversationMeta, id);
  const kind = meta.kind;
  switch (kind) {
    case "main":
      throw new Error("MiPi can't be restored.");
    case "bot":
      return restoreBotTree(tx, id, meta);
    case "cobot":
      return restoreCobot(tx, id, meta);
    case undefined:
      return restoreEarlierChat(tx, id, meta, profiles);
    default: {
      const _: never = kind;
      throw new Error("Only a bot can be restored.");
    }
  }
}

/**
 * Restores a bot and the cobots archived with it (the same `archivedAt`), and binds back each channel key that fell
 * back to MiPi from one of them and wasn't bound elsewhere since. Returns the conversations restored now, and every
 * conversation of the bot whose held reminders are due (`replayHeld`), the bot's included when it was live already, so
 * a restore cut short sends what it left.
 */
async function restoreBotTree(
  tx: Tx,
  id: ConversationId,
  meta: ConversationMetaState,
): Promise<Restored> {
  const at = meta.archivedAt;
  // Live already: its live cobots, whose held reminders a restore cut short may have left.
  const cobots = await cobotsOf(tx, id, (archivedAt) => archivedAt === at);
  if (at === undefined) return { restored: [], conversations: [id, ...cobots] };
  const ids = [id, ...cobots];
  await unarchive(tx, ids);
  return { restored: ids, conversations: ids };
}

/** A cobot alone, only under a live bot: archived with its bot, it waits for the bot's restore. */
async function restoreCobot(
  tx: Tx,
  id: ConversationId,
  meta: ConversationMetaState,
): Promise<Restored> {
  const parentId = meta.bot as ConversationId | undefined;
  const parent = parentId === undefined ? undefined : await tx.doc(ConversationMeta, parentId);
  if (parentId === undefined || parent === undefined || parent.kind === undefined) {
    throw new Error("This cobot has no bot to restore it under.");
  }
  if (parent.archivedAt !== undefined || archivedIn(await tx.doc(Bots), parentId)) {
    throw new Error(`Restore ${parent.name ?? "its bot"} first.`);
  }
  if (meta.archivedAt === undefined) return { restored: [], conversations: [id] };
  await unarchive(tx, [id]);
  return { restored: [id], conversations: [id] };
}

/**
 * A chat from before bots, restored: a cobot under MiPi, named from its title, on its own profile, or `default` for
 * the relay's old `pidu`, which no live chat newly keeps. It stays out of the bot name index and the active bot limit.
 * Its reminders, which ran in MiPi while it was archived (`routeSchedule`), run in it again from this commit.
 */
async function restoreEarlierChat(
  tx: Tx,
  id: ConversationId,
  meta: ConversationMetaState,
  profiles: Profiles,
): Promise<Restored> {
  const bots = await tx.doc(Bots);
  if (bots.mainId === undefined) throw new Error("MiPi isn't set up yet.");
  if (meta.archivedAt === undefined && !archivedIn(bots, id)) {
    throw new Error("Only an archived chat can be restored.");
  }
  meta.kind = "cobot";
  meta.bot = bots.mainId;
  meta.name = earlierChatName(meta.title);
  meta.createdBy ??= "owner";
  if (profileOf(meta) === RELAY_PROFILE) await setProfile(tx, id, DEFAULT_PROFILE, profiles);
  await unarchive(tx, [id]);
  return { restored: [id], conversations: [id] };
}

/** A restored earlier chat's cobot name: its title, cut to a name's length. */
function earlierChatName(title: string | undefined): string {
  const line = title?.split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return "Earlier chat";
  const chars = [...line];
  return chars.length <= NAME_MAX
    ? line
    : `${chars
        .slice(0, NAME_MAX - 1)
        .join("")
        .trimEnd()}…`;
}

/** Clears `archivedAt` and the index entry of each, and binds back the channel keys that fell back from them. */
async function unarchive(tx: Tx, ids: readonly ConversationId[]): Promise<void> {
  const bots = await tx.doc(Bots);
  const archived = { ...bots.archived };
  for (const conversationId of ids) {
    delete (await tx.doc(ConversationMeta, conversationId)).archivedAt;
    delete archived[String(conversationId)];
  }
  bots.archived = archived;
  const restoredIds = new Set<number>(ids);
  const released = { ...bots.released };
  for (const [key, botId] of Object.entries(bots.released ?? {})) {
    if (!restoredIds.has(botId)) continue;
    // Still released means bound nowhere else since (`bindChannel` drops the key).
    const binding = await tx.doc(ChannelBindings, key, null);
    binding.conversationId = botId;
    binding.bots = true;
    delete released[key];
  }
  bots.released = released;
}

/**
 * Sends the reminders held for `conversations` (every live conversation's, when undefined: what a start finds left),
 * marked late, each in a commit of its own (an admit must be its commit's first table write), and drops each from the
 * hold in the commit that sends it. A reminder sent before (its `held:` request id admitted) is only dropped.
 *
 * Nothing goes while MiPi is paused (`MIPI_PAUSED` holds every model call): the reminders stay held, and the next start
 * without the pause sends them. Nor into a conversation archived again meanwhile: it stays held for the next restore.
 * Returns how many it sent.
 */
export async function replayHeld(
  harness: Harness,
  conversations: readonly ConversationId[] | undefined,
  now: number,
  context: Context,
  /** Arms the alarm before the first admit: an early alarm is harmless, a missing one strands the turn. */
  arm: () => Promise<void> = async () => {},
): Promise<number> {
  const wanted = conversations === undefined ? undefined : new Set<number>(conversations);
  const held = await harness.commit(async (tx) => {
    if (await isPaused(tx)) return [];
    const bots = await tx.doc(Bots);
    return (
      (bots.held ?? [])
        .filter(({ conversationId }) =>
          wanted === undefined ? !archivedIn(bots, conversationId) : wanted.has(conversationId),
        )
        // Copies, destination included: the drafts end with this commit.
        .map((entry) => ({ ...entry, destination: { ...entry.destination } }))
    );
  }, context);
  let sent = 0;
  if (held.length > 0) await arm();
  for (const reminder of held) {
    const conversation = await harness.conversation(
      reminder.conversationId as ConversationId,
      context,
    );
    if (conversation === undefined) {
      throw new Error(`Held reminder ${reminder.id}'s conversation is missing`);
    }
    const admitted = await harness.commit(async (tx) => {
      // Reads first; the admit is this commit's first table write.
      // The reminder's own id for it (its extension registers the prefix): core names none.
      const { requestId } = reminder;
      const existing = await tx.submissionByRequest(conversation.id, requestId);
      const bots = await tx.doc(Bots);
      if (bots.held?.some(({ id }) => id === reminder.id) !== true) return false;
      // Archived again, or paused, since the list was read: it stays held.
      if (archivedIn(bots, conversation.id) || (await isPaused(tx))) return false;
      let admittedNow = false;
      if (existing === undefined) {
        const zone = reminder.zone ?? (await tx.doc(AgentSettings)).timeZone ?? DEFAULT_TIME_ZONE;
        const content = formatReminder(
          reminder,
          localTime(now, zone),
          undefined,
          (await recentProactiveSends(tx)).map(({ sentAt, snippet }) => ({
            at: localTime(sentAt, zone),
            snippet,
          })),
          localTime(reminder.dueAt, zone),
        );
        const submissionId = await conversation.admit(tx, {
          type: "input",
          content,
          requestId,
          whenBusy: "followUp",
        });
        // Judged and delivered where the reminder would have answered, as any occurrence (core).
        await expectProactive(
          tx,
          {
            submissionId,
            sourceId: reminder.id,
            instruction: reminder.instruction,
            conversationId: conversation.id,
            destination: reminder.destination,
          },
          now,
        );
        admittedNow = true;
      }
      bots.held = (bots.held ?? []).filter(({ id }) => id !== reminder.id);
      return admittedNow;
    }, context);
    if (admitted) sent += 1;
  }
  return sent;
}

/** The archive index as stored before archive: built once from each archived conversation's `archivedAt`. */
export async function backfillArchived(tx: Tx, bots: BotsState): Promise<void> {
  if (bots.archived !== undefined) return;
  const archived: Record<string, number> = {};
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const record of page.items) {
      if (record.owner !== undefined) continue;
      const at = (await tx.doc(ConversationMeta, record.id)).archivedAt;
      if (at !== undefined) archived[String(record.id)] = at;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  bots.archived = archived;
}
