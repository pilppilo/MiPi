import { describe, expect, it } from "vitest";
import {
  activityByBot,
  advanceLastRead,
  archivedEntries,
  lastReadKey,
  listedBots,
  loadLastRead,
  NOTHING_READ,
  saveLastRead,
  unreadByBot,
  unreadIds,
  restoreHintFor,
} from "../src/client/bots-list.ts";
import type { TaskGraph } from "../src/agent/pi/shared.ts";
import type { ConversationSummary } from "../src/protocol.ts";

const MIPI: ConversationSummary = { id: 4, kind: "main", name: "MiPi", profile: "main" };
const GROCERIES: ConversationSummary = {
  id: 9,
  kind: "bot",
  name: "Groceries",
  purpose: "Keep the list.",
};
const TRAVEL: ConversationSummary = { id: 7, kind: "bot", name: "Travel", purpose: "Plan trips." };

type State = TaskGraph["tasks"][string]["state"];
const task = (id: number, conversationId: number, state: State, owner?: number) => ({
  id,
  kind: "pi.generation",
  conversationId,
  ...(owner === undefined ? {} : { owner }),
  background: false,
  abortRequested: false,
  state,
  conversations: [],
});
const graph = (...tasks: ReturnType<typeof task>[]): TaskGraph =>
  ({ tasks: Object.fromEntries(tasks.map((node) => [String(node.id), node])) }) as never;

describe("the bots list (COD-197)", () => {
  it("lists MiPi first, then live purpose bots as made, never an archived chat or a subagent", () => {
    const listed = listedBots([
      { id: 1, archivedAt: 5, title: "Old chat" },
      GROCERIES,
      { id: 12, owner: { conversationId: 9 } },
      TRAVEL,
      { id: 13, kind: "bot", name: "Gone", archivedAt: 8 },
      { id: 14, title: "A plain chat" },
      MIPI,
    ]);
    expect(listed.main).toBe(MIPI);
    expect(listed.bots).toEqual([TRAVEL, GROCERIES]);
  });

  it("rolls each task up to its bot, ignores sleeping ones, and lets working outrank waiting", () => {
    const conversations = [MIPI, GROCERIES, TRAVEL, { id: 20, owner: { conversationId: 9 } }];
    const activity = activityByBot(
      conversations,
      graph(
        // A reminder asleep until its time: no dot.
        task(1, 4, { status: "sleeping", phase: "wait", until: 1 }),
        // Groceries waits on its subagent, whose generation runs: working.
        task(2, 9, { status: "waiting", phase: "tools", on: [3] as never, policy: "all" as never }),
        task(3, 20, { status: "running", phase: "generate" }),
        // Travel only waits.
        task(4, 7, { status: "waiting", phase: "tools", on: [] as never, policy: "all" as never }),
        // A task in a conversation the list hasn't got finds its bot through its owner task.
        task(5, 99, { status: "completing", outcome: "completed" }, 4),
      ),
    );
    expect(activity).toEqual(
      new Map([
        [9, "running"],
        [20, "running"],
        [7, "running"],
      ]),
    );
  });

  it("nests a cobot and successive task-owned conversations and rolls their indicators up", () => {
    const cobot: ConversationSummary = { id: 14, kind: "cobot", bot: GROCERIES.id, name: "Dinner" };
    const helper: ConversationSummary = { id: 16, owner: { conversationId: cobot.id } };
    const child: ConversationSummary = { id: 17, owner: { conversationId: helper.id } };
    const conversations = [MIPI, GROCERIES, TRAVEL, cobot, helper, child];
    const listed = listedBots(conversations);
    expect(listed.bots).toEqual([TRAVEL, GROCERIES]);
    expect(listed.children.get(GROCERIES.id)).toEqual([cobot]);
    expect(listed.children.get(cobot.id)).toEqual([helper]);
    expect(listed.children.get(helper.id)).toEqual([child]);
    const activity = activityByBot(
      conversations,
      graph(task(1, child.id, { status: "waiting", phase: "tools", on: [], policy: "allSettled" })),
    );
    expect(activity).toEqual(
      new Map([
        [child.id, "waiting"],
        [helper.id, "waiting"],
        [cobot.id, "waiting"],
        [GROCERIES.id, "waiting"],
      ]),
    );
    expect(unreadByBot(conversations, new Set([child.id]))).toEqual(new Set(activity.keys()));
    const archived = conversations.map((item) =>
      item.id === GROCERIES.id ? { ...item, archivedAt: 1 } : item,
    );
    expect(listedBots(archived).bots).toEqual([TRAVEL]);
    expect(unreadByBot(archived, new Set([child.id])).size).toBe(0);
  });

  it("guards owner loops", () => {
    const looped = [
      { id: 30, owner: { conversationId: 31 } },
      { id: 31, owner: { conversationId: 30 } },
    ];
    const activity = activityByBot(looped, graph(task(1, 30, { status: "pending", phase: "" })));
    expect([...activity.values()]).toEqual(["running"]);
    const taskLoop = graph(
      task(1, 98, { status: "running", phase: "" }, 2),
      task(2, 97, { status: "running", phase: "" }, 1),
    );
    expect(activityByBot([], taskLoop).size).toBe(2);
  });

  it("starts a new browser with nothing unread, then dots what arrives, never the open bot", () => {
    const at = (mipi: number, groceries?: number): ConversationSummary[] => [
      { ...MIPI, latestEntryId: mipi },
      { ...GROCERIES, ...(groceries === undefined ? {} : { latestEntryId: groceries }) },
    ];
    // Before the snapshot, nothing to seed.
    expect(advanceLastRead(NOTHING_READ, [], undefined)).toBe(NOTHING_READ);
    // The first snapshot: everything there is read.
    let read = advanceLastRead(NOTHING_READ, at(10, 3), 4);
    expect(read).toEqual({ seeded: true, entries: { "4": 10, "9": 3 } });
    expect(unreadIds(read, at(10, 3)).size).toBe(0);
    // New entries on both while MiPi is open: only Groceries gets a dot.
    read = advanceLastRead(read, at(12, 5), 4);
    expect(read.entries).toEqual({ "4": 12, "9": 3 });
    expect(unreadIds(read, at(12, 5))).toEqual(new Set([9]));
    // Opening Groceries reads it.
    read = advanceLastRead(read, at(12, 5), 9);
    expect(unreadIds(read, at(12, 5)).size).toBe(0);
    // Unchanged: the same object back, so nothing is written.
    expect(advanceLastRead(read, at(12, 5), 9)).toBe(read);
  });

  it("dots a bot made after the first snapshot from its first entry", () => {
    const seeded = advanceLastRead(NOTHING_READ, [{ ...MIPI, latestEntryId: 10 }], 4);
    const later = [
      { ...MIPI, latestEntryId: 10 },
      { ...GROCERIES, latestEntryId: 11 },
    ];
    expect(unreadIds(advanceLastRead(seeded, later, 4), later)).toEqual(new Set([9]));
  });

  it("keeps what was read in this browser, and survives storage that fails or holds junk", () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    saveLastRead(storage, "jerome", { seeded: true, entries: { "4": 10 } });
    expect(loadLastRead(storage, "jerome")).toEqual({ seeded: true, entries: { "4": 10 } });
    expect(loadLastRead(storage, "someone-else")).toEqual(NOTHING_READ);
    items.set(lastReadKey("jerome"), "{not json");
    expect(loadLastRead(storage, "jerome")).toEqual(NOTHING_READ);
    items.set(
      lastReadKey("jerome"),
      JSON.stringify({ seeded: true, entries: { "4": "x", "9": 3 } }),
    );
    expect(loadLastRead(storage, "jerome")).toEqual({ seeded: true, entries: { "9": 3 } });
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadLastRead(throwing, "jerome")).toEqual(NOTHING_READ);
    expect(() => saveLastRead(throwing, "jerome", NOTHING_READ)).not.toThrow();
    expect(loadLastRead(undefined, "jerome")).toEqual(NOTHING_READ);
  });
});

describe("Settings → Archived (COD-201)", () => {
  const conversations: ConversationSummary[] = [
    MIPI,
    GROCERIES,
    { id: 1, title: "First chat", archivedAt: 10 },
    { id: 2, title: "Second chat", archivedAt: 10 },
    { id: 3, owner: { conversationId: 1 }, archivedAt: 10 },
    { id: 20, kind: "bot", name: "Garden", purpose: "Look after it.", archivedAt: 30 },
    { id: 21, kind: "cobot", bot: 20, name: "Seedlings", title: "Tomatoes", archivedAt: 30 },
    { id: 22, kind: "bot", name: "Travel", purpose: "Plan trips.", archivedAt: 50 },
    { id: 23, kind: "cobot", bot: 9, name: "Dinner", archivedAt: 40 },
    { id: 24, kind: "cobot", bot: 9, name: "Lunch" },
  ];

  it("lists archived bots with their cobots, newest first, then chats from before bots", () => {
    const entries = archivedEntries(conversations);
    expect(entries.map(({ summary, kind }) => [summary.id, kind])).toEqual([
      [22, "bot"],
      [20, "bot"],
      [21, "cobot"],
      [23, "cobot"],
      [2, "earlier"],
      [1, "earlier"],
    ]);
    expect(entries.find(({ summary }) => summary.id === 20)?.detail).toBe("Look after it.");
    expect(entries.find(({ summary }) => summary.id === 1)?.detail).toBe("First chat");
  });

  it("offers Restore for a cobot only once its bot is live", () => {
    const entries = archivedEntries(conversations);
    expect(entries.find(({ summary }) => summary.id === 21)?.restoreHint).toBe(
      "Restore Garden first.",
    );
    expect(entries.find(({ summary }) => summary.id === 23)?.restoreHint).toBeUndefined();
    expect(entries.find(({ summary }) => summary.id === 20)?.restoreHint).toBeUndefined();
    expect(
      restoreHintFor(
        conversations.find(({ id }) => id === 24),
        conversations,
      ),
    ).toBe(undefined);
  });
});
