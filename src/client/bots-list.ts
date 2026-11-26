/**
 * The web list of bots (COD-197): which conversations it shows, what each is doing, and which have something unread.
 * Pure functions over the session's summaries and activity graph, so the sidebar only draws them.
 */
import type { TaskGraph, TaskGraphNode } from "../agent/pi/shared.ts";
import type { ConversationSummary } from "../protocol.ts";

/** MiPi first, then the live purpose bots in the order they were made. Archived chats and subagents aren't listed. */
export function listedBots(conversations: readonly ConversationSummary[]): {
  readonly main: ConversationSummary | undefined;
  readonly bots: readonly ConversationSummary[];
} {
  const live = conversations.filter(
    ({ archivedAt, owner }) => archivedAt === undefined && owner === undefined,
  );
  return {
    main: live.find(({ kind }) => kind === "main"),
    bots: live.filter(({ kind }) => kind === "bot").sort((left, right) => left.id - right.id),
  };
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
  const topOf = (conversationId: number): number => {
    const seen = new Set<number>();
    let current = conversationId;
    for (;;) {
      seen.add(current);
      const owner = summaries.get(current)?.owner?.conversationId;
      if (owner === undefined || seen.has(owner)) return current;
      current = owner;
    }
  };
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
    const bot = topOf(conversationOf(task));
    if (state === "running" || result.get(bot) === undefined) result.set(bot, state);
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
