/**
 * The web list of bots (COD-197): which conversations it shows, what each is doing, and which have something unread.
 * Pure functions over the session's summaries and activity graph, so the sidebar only draws them.
 */
import type { TaskGraph, TaskGraphNode } from "../agent/pi/shared.ts";
import type { ConversationSummary } from "../protocol.ts";

/** MiPi first, then purpose bots. Cobots and subagents hang from their parent conversations. */
export function listedBots(conversations: readonly ConversationSummary[]): {
  readonly main: ConversationSummary | undefined;
  readonly bots: readonly ConversationSummary[];
  readonly children: ReadonlyMap<number, readonly ConversationSummary[]>;
} {
  const live = conversations.filter(({ archivedAt }) => archivedAt === undefined);
  const roots = live.filter(({ owner }) => owner === undefined);
  const children = new Map<number, ConversationSummary[]>();
  for (const summary of live) {
    const parent = sidebarParent(summary);
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [summary]);
    else siblings.push(summary);
  }
  return {
    main: roots.find(({ kind }) => kind === "main"),
    bots: roots.filter(({ kind }) => kind === "bot").sort((left, right) => left.id - right.id),
    children,
  };
}

function sidebarParent(summary: ConversationSummary | undefined): number | undefined {
  return summary?.owner?.conversationId ?? (summary?.kind === "cobot" ? summary.bot : undefined);
}

/** The row itself and each parent that should indicate its activity or unread entries. */
function branchOf(
  summaries: ReadonlyMap<number, ConversationSummary>,
  id: number,
): ReadonlySet<number> {
  const branch = new Set([id]);
  let parent = sidebarParent(summaries.get(id));
  while (parent !== undefined) {
    if (branch.has(parent)) return new Set([id]);
    branch.add(parent);
    parent = sidebarParent(summaries.get(parent));
  }
  return branch;
}

export function unreadByBot(
  conversations: readonly ConversationSummary[],
  unread: ReadonlySet<number>,
): ReadonlySet<number> {
  const summaries = new Map(conversations.map((summary) => [summary.id, summary]));
  const result = new Set<number>();
  for (const id of unread) {
    const branch = branchOf(summaries, id);
    if ([...branch].some((parent) => summaries.get(parent)?.archivedAt !== undefined)) continue;
    for (const parent of branch) result.add(parent);
  }
  return result;
}

/** What a bot is doing: working (a task pending, running or finishing), or waiting on others. */
export type BotActivity = "running" | "waiting";

/**
 * Each bot's activity, its subagents' and their tasks' rolled up to it. A sleeping task (a reminder waiting for its
 * time) isn't activity, and working outranks waiting. Owner chains are followed with a guard, so a malformed graph
 * can't loop.
 */
export function activityByBot(
  conversations: readonly ConversationSummary[],
  activity: TaskGraph | undefined,
): ReadonlyMap<number, BotActivity> {
  const summaries = new Map(conversations.map((summary) => [summary.id, summary]));
  const tasks = activity?.tasks ?? {};
  /** The conversation a task works for: its own, or (for one whose conversation the list hasn't got) its owner's. */
  const conversationOf = (task: TaskGraphNode): number => {
    const seen = new Set<string>();
    let current: TaskGraphNode | undefined = task;
    while (current !== undefined && !summaries.has(current.conversationId)) {
      seen.add(String(current.id));
      const owner: string | undefined =
        current.owner === undefined ? undefined : String(current.owner);
      current = owner === undefined || seen.has(owner) ? undefined : tasks[owner];
    }
    return (current ?? task).conversationId;
  };
  const result = new Map<number, BotActivity>();
  for (const task of Object.values(tasks)) {
    const state = taskActivity(task);
    if (state === undefined) continue;
    for (const id of branchOf(summaries, conversationOf(task))) {
      if (state === "running" || result.get(id) === undefined) result.set(id, state);
    }
  }
  return result;
}

function taskActivity(task: TaskGraphNode): BotActivity | undefined {
  switch (task.state.status) {
    case "pending":
    case "running":
    case "completing":
      return "running";
    case "waiting":
      return "waiting";
    case "sleeping":
      return undefined;
    default: {
      const _: never = task.state;
      return undefined;
    }
  }
}

/**
 * What this browser has read: each conversation's newest entry read, and whether it has seen a session yet (`seeded`).
 */
export type LastRead = {
  readonly seeded: boolean;
  readonly entries: Readonly<Record<string, number>>;
};

export const NOTHING_READ: LastRead = { seeded: false, entries: {} };

/**
 * `lastRead` brought up to date. The first time a browser sees the session's conversations, it takes them all as
 * read to their newest entry, so a new browser starts with no dots and only what arrives after shows one. After that, a
 * conversation it never read (a bot made since) is unread from its first entry. The open conversation is always read
 * to its newest. Returns `lastRead` itself when nothing changes.
 */
export function advanceLastRead(
  lastRead: LastRead,
  conversations: readonly ConversationSummary[],
  activeConversationId: number | undefined,
): LastRead {
  if (conversations.length === 0) return lastRead;
  let entries: Record<string, number> | undefined;
  for (const { id, latestEntryId } of conversations) {
    if (latestEntryId === undefined) continue;
    const known = lastRead.entries[String(id)];
    const read = id === activeConversationId || !lastRead.seeded;
    if (read && known !== latestEntryId) {
      entries ??= { ...lastRead.entries };
      entries[String(id)] = latestEntryId;
    }
  }
  if (entries === undefined && lastRead.seeded) return lastRead;
  return { seeded: true, entries: entries ?? lastRead.entries };
}

/** The conversations with an entry newer than the one last read. */
export function unreadIds(
  lastRead: LastRead,
  conversations: readonly ConversationSummary[],
): ReadonlySet<number> {
  const unread = new Set<number>();
  if (!lastRead.seeded) return unread;
  for (const { id, latestEntryId } of conversations) {
    if (latestEntryId !== undefined && latestEntryId > (lastRead.entries[String(id)] ?? 0)) {
      unread.add(id);
    }
  }
  return unread;
}

/** Where a session's `LastRead` is kept: this browser only, so it can come back empty, and storage can throw. */
export const lastReadKey = (sessionId: string): string => `mipi:last-read:${sessionId}`;

export function loadLastRead(
  storage: Pick<Storage, "getItem"> | undefined,
  sessionId: string,
): LastRead {
  try {
    const raw = storage?.getItem(lastReadKey(sessionId));
    if (raw === null || raw === undefined) return NOTHING_READ;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return NOTHING_READ;
    const { seeded, entries } = parsed as { seeded?: unknown; entries?: unknown };
    if (seeded !== true || typeof entries !== "object" || entries === null) return NOTHING_READ;
    return {
      seeded: true,
      entries: Object.fromEntries(
        Object.entries(entries).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isSafeInteger(entry[1]),
        ),
      ),
    };
  } catch {
    return NOTHING_READ;
  }
}

export function saveLastRead(
  storage: Pick<Storage, "setItem"> | undefined,
  sessionId: string,
  lastRead: LastRead,
): void {
  try {
    storage?.setItem(lastReadKey(sessionId), JSON.stringify(lastRead));
  } catch {
    // Storage full or off: the dots just don't survive a reload.
  }
}

/** One row of Settings → Archived (COD-201). */
export type ArchivedEntry = {
  readonly summary: ConversationSummary;
  /** What it is: a purpose bot, one of its cobots, or a chat from before bots. */
  readonly kind: "bot" | "cobot" | "earlier";
  /** What the row shows under its name: a bot's purpose, or a chat's first line (its title). */
  readonly detail: string | undefined;
  /** Why Restore is off, when it is: a cobot comes back only with its bot. */
  readonly restoreHint: string | undefined;
};

/** The archived bots, each with its archived cobots, newest first, then the chats from before bots, newest first. */
export function archivedEntries(
  conversations: readonly ConversationSummary[],
): readonly ArchivedEntry[] {
  const archived = conversations.filter(
    ({ archivedAt, owner }) => archivedAt !== undefined && owner === undefined,
  );
  const newest = (left: ConversationSummary, right: ConversationSummary): number =>
    (right.archivedAt ?? 0) - (left.archivedAt ?? 0) || right.id - left.id;
  const cobotsOf = (bot: number) =>
    archived.filter(({ kind, bot: parent }) => kind === "cobot" && parent === bot).sort(newest);
  const cobotEntry = (summary: ConversationSummary): ArchivedEntry => ({
    summary,
    kind: "cobot",
    detail: summary.title,
    restoreHint: restoreHintFor(summary, conversations),
  });
  const entries: ArchivedEntry[] = [];
  const listed = new Set<number>();
  for (const bot of archived.filter(({ kind }) => kind === "bot").sort(newest)) {
    entries.push({ summary: bot, kind: "bot", detail: bot.purpose, restoreHint: undefined });
    listed.add(bot.id);
    for (const cobot of cobotsOf(bot.id)) {
      entries.push(cobotEntry(cobot));
      listed.add(cobot.id);
    }
  }
  // A cobot archived on its own (COD-233), under a live bot or one archived after it.
  for (const cobot of archived
    .filter(({ kind, id }) => kind === "cobot" && !listed.has(id))
    .sort(newest)) {
    entries.push(cobotEntry(cobot));
  }
  for (const chat of archived.filter(({ kind }) => kind === undefined).sort(newest)) {
    entries.push({ summary: chat, kind: "earlier", detail: chat.title, restoreHint: undefined });
  }
  return entries;
}

/**
 * Why an archived conversation can't be restored from here, or undefined when it can: a cobot archived with its bot
 * comes back with the bot, never alone (the agent refuses the same way).
 */
export function restoreHintFor(
  summary: ConversationSummary | undefined,
  conversations: readonly ConversationSummary[],
): string | undefined {
  if (summary?.archivedAt === undefined || summary.kind !== "cobot") return undefined;
  const parent = conversations.find(({ id }) => id === summary.bot);
  // The agent refuses a cobot with no bot to come back under, too.
  if (parent === undefined) return "Its bot is missing.";
  return parent.archivedAt === undefined ? undefined : `Restore ${parent.name ?? "its bot"} first.`;
}

/**
 * What the web asks before archiving a live bot or cobot (COD-233), or undefined for one it can't archive: MiPi, an
 * archived one, a chat from before bots, a subagent. A bot's live cobots go with it; a cobot goes alone.
 */
export function archivePrompt(
  summary: ConversationSummary | undefined,
  conversations: readonly ConversationSummary[],
): string | undefined {
  if (summary === undefined || summary.archivedAt !== undefined || summary.owner !== undefined) {
    return undefined;
  }
  const name = summary.name ?? "this bot";
  switch (summary.kind) {
    case "bot": {
      const cobots = conversations.filter(
        ({ kind, bot, archivedAt }) =>
          kind === "cobot" && bot === summary.id && archivedAt === undefined,
      ).length;
      const withCobots =
        cobots === 0 ? "" : ` and its ${cobots === 1 ? "cobot" : `${cobots} cobots`}`;
      return `Archive ${name}${withCobots}? It stops working and keeps everything; restore it from Settings → Archived.`;
    }
    case "cobot":
      return `Archive the cobot ${name}? Its bot keeps working; restore it from Settings → Archived.`;
    case "main":
    case undefined:
      return undefined;
    default: {
      const _: never = summary.kind;
      return undefined;
    }
  }
}
