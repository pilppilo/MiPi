import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import { DRAWER_CLOSED, drawerReducer, type DrawerState } from "../src/client/drawer.ts";
import type { PiSession } from "../src/client/usePiSession.ts";

/**
 * COD-244: the spaces drawer as the page draws it, closed and open. Its rules are in `drawer.test.ts`; that a bot pick,
 * Settings and Escape reach them was checked in a browser (the PR's preview).
 */
const mocked = vi.hoisted(() => ({ drawer: undefined as DrawerState | undefined, waiting: false }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useReducer: ((reducer: unknown, initial: unknown) =>
      reducer === drawerReducer
        ? [mocked.drawer ?? initial, () => {}]
        : react.useReducer(reducer as never, initial as never)) as typeof react.useReducer,
  };
});

vi.mock("../src/client/usePiSession.ts", () => ({
  usePiSession: (): Pick<
    PiSession,
    | "status"
    | "capabilities"
    | "conversations"
    | "activeConversationId"
    | "activeConversation"
    | "approvals"
    | "decideApproval"
  > => ({
    status: "connected",
    capabilities: new Set(["activity", "approvals", "diagnostics", "usage"]),
    conversations: [
      { id: 4, kind: "main", name: "MiPi", latestEntryId: 2 },
      { id: 6, kind: "bot", name: "Groceries", purpose: "Keep the list.", profile: "default" },
    ],
    approvals: mocked.waiting
      ? [
          {
            id: "52",
            conversationId: 6,
            tool: "remember",
            summary: "Save the lesson",
            reason: "This turn read a web page.",
            arguments: "{}",
          },
        ]
      : [],
    decideApproval: async () => ({ ok: true }),
    activeConversationId: 4,
    activeConversation: {
      id: 4,
      entries: [],
      earlier: false,
      gaps: [],
      live: null,
      tools: [],
      compactions: [],
      queued: [],
      typing: [],
    },
  }),
}));

const render = (drawer: DrawerState): string => {
  mocked.drawer = drawer;
  vi.stubGlobal("window", { location: { search: "" } });
  return renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
};

afterEach(() => {
  mocked.drawer = undefined;
  mocked.waiting = false;
  vi.unstubAllGlobals();
});

describe("the spaces drawer on the page (COD-244)", () => {
  it("starts closed: its toggle says so and the conversation takes input", () => {
    const html = render(DRAWER_CLOSED);
    expect(html).toMatch(/^<div class="session-workspace">/);
    expect(html).toMatch(
      /<button[^>]*class="round-button drawer-toggle"[^>]*aria-controls="spaces-drawer" aria-expanded="false"/,
    );
    expect(html).not.toMatch(/<main class="conversation-view" inert/);
  });

  it("marks the closed toggle and links to a waiting bot in the drawer", () => {
    mocked.waiting = true;
    const html = render(DRAWER_CLOSED);
    expect(html).toMatch(
      /aria-label="Bots and settings, approval waiting"[^>]*aria-expanded="false"[^>]*>.*?drawer-approval-dot.*?<\/button>/,
    );
    expect(html).toMatch(
      /class="approval-banner".*?<a href="\?conversation=6">Groceries<\/a>.*?Save the lesson/,
    );
  });

  it("open: the drawer shows, the conversation behind it is inert, and the scrim can close it", () => {
    const html = render({ open: true, focus: "drawer" });
    expect(html).toContain('class="session-workspace session-workspace--drawer-open"');
    expect(html).toMatch(/aria-controls="spaces-drawer" aria-expanded="true"/);
    expect(html).toMatch(/<main class="conversation-view" inert="">/);
    expect(html).toMatch(
      /<button class="drawer-scrim" type="button" tabindex="-1" aria-hidden="true">/,
    );
    // The drawer holds the bots, each with its mark and what it is doing, and Settings and New bot at its foot.
    expect(html).toMatch(/<aside[^>]*id="spaces-drawer"[^>]*tabindex="-1"/);
    expect(html).toMatch(
      /class="bot-mark bot-mark--small bot-mark--asleep"[^>]*style="--bot-hue:246"/,
    );
    expect(html).toMatch(/>Groceries<.*class="bot-status">Asleep</);
    expect(html).toMatch(/class="drawer-footer">.*aria-label="Settings".*>New bot<\/button>/);
  });

  it("puts the bot's mark top centre, with its details behind it, and leaves the voice slot empty", () => {
    const html = render(DRAWER_CLOSED);
    expect(html).toMatch(
      /<details class="bot-profile"><summary aria-label="Bot details"><span class="bot-mark bot-mark--large/,
    );
    expect(html).toMatch(/<h2[^>]*id="transcript-heading"[^>]*>MiPi<\/h2>/);
    expect(html).toContain('<span class="titlebar-slot" aria-hidden="true"></span>');
    expect(html).not.toMatch(/voice|Voice/);
  });
});
