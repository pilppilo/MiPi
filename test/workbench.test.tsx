/** Workbench (COD-249): one bot's running and waiting work by plain name, its steps, and the other bots. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Workbench } from "../src/client/Workbench.tsx";
import { tasksOfBot } from "../src/client/session/bots-list.ts";
import type { ConversationSummary, TaskGraph } from "../src/protocol.ts";

const conversations: ConversationSummary[] = [
  { id: 4, kind: "main", name: "MiPi" },
  { id: 6, kind: "bot", name: "Planner" },
  { id: 7, kind: "cobot", bot: 6, name: "Trips" },
  { id: 8, owner: { conversationId: 6 } },
  { id: 9, kind: "bot", name: "Reader" },
];

const task = (id: number, kind: string, conversationId: number, state: object, owner?: number) => ({
  id,
  kind,
  conversationId,
  ...(owner === undefined ? {} : { owner }),
  background: false,
  abortRequested: false,
  state,
  conversations: [],
});

const graph = {
  tasks: {
    "1": task(1, "pi.generation", 6, { status: "running", phase: "generate" }),
    "2": task(2, "app.reminder", 6, {
      status: "sleeping",
      phase: "wait",
      until: Date.UTC(2026, 10, 28, 15, 0),
    }),
    "3": task(3, "pi.generation", 7, { status: "running", phase: "generate" }),
    "4": task(4, "pi.generation", 8, { status: "pending", phase: "start" }),
    "5": task(5, "pi.generation", 9, { status: "running", phase: "generate" }),
  },
} as unknown as TaskGraph;

describe("a bot's tasks", () => {
  it("are its own, its cobots' and its subagents', never another bot's", () => {
    expect(tasksOfBot(conversations, graph, 6).map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(tasksOfBot(conversations, graph, 9).map(({ id }) => id)).toEqual([5]);
    expect(tasksOfBot(conversations, graph, 4)).toEqual([]);
    expect(tasksOfBot(conversations, undefined, 6)).toEqual([]);
  });
});

const label = (summary: ConversationSummary): string => summary.name ?? `Chat ${summary.id}`;

const render = (bot: number, overrides: Partial<Parameters<typeof Workbench>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(Workbench, {
      bot: conversations.find(({ id }) => id === bot)!,
      label,
      bots: [conversations[0]!, conversations[1]!, conversations[4]!],
      conversations,
      graph,
      tools: [
        { callId: "a", name: "search_history", status: "done" },
        { callId: "b", name: "web_fetch", status: "running" },
      ],
      activity: new Map([
        [6, "running"],
        [9, "running"],
      ]),
      unread: new Set([9]),
      onOpenBot: () => {},
      ...overrides,
    }),
  );

describe("Workbench", () => {
  it("shows what the bot is running, with the open conversation's steps by plain name", () => {
    const html = render(6);
    const running = html.match(/aria-labelledby="workbench-running">(.*?)<\/section>/)?.[1] ?? "";
    expect(running.match(/class="workbench-card workbench-card--running"/g)).toHaveLength(3);
    expect(running).toContain("Answering");
    expect(running).toMatch(
      /workbench-step--done.*Past chats<span class="visually-hidden"> · Done</,
    );
    expect(running).toMatch(
      /workbench-step--running.*Web pages<span class="visually-hidden"> · Running</,
    );
    // A side chat's or subagent's run is noted, and has no steps of the open conversation.
    expect(running.match(/for a side chat/g)).toHaveLength(2);
    expect(running.match(/aria-label="Steps"/g)).toHaveLength(1);
    expect(running).not.toMatch(/search_history|web_fetch|pi\.generation/);
  });

  it("shows what it waits on, with when it wakes", () => {
    const html = render(6);
    const waiting = html.match(/aria-labelledby="workbench-waiting">(.*?)<\/section>/)?.[1] ?? "";
    expect(waiting).toContain(">Reminder<");
    expect(waiting).toMatch(/Wakes /);
    expect(waiting).not.toContain("app.reminder");
  });

  it("lists the other bots with their state, and links each to its own Workbench", () => {
    const html = render(6);
    const others = html.match(/aria-labelledby="workbench-others">(.*?)<\/section>/)?.[1] ?? "";
    expect(others).toMatch(
      /href="\?conversation=4&amp;space=workbench".*<strong>MiPi<\/strong><span>Asleep<\/span>/,
    );
    expect(others).toMatch(/<strong>Reader<\/strong><span>Working · new messages<\/span>/);
    expect(others).not.toContain("Planner");
  });

  it("says plainly when nothing runs, and leaves out an empty Waiting", () => {
    const html = render(4, { tools: [] });
    expect(html).toContain("Nothing running. MiPi is asleep.");
    expect(html).not.toContain("workbench-waiting");
  });
});
