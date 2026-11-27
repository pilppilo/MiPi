import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";

/** Which conversation the mocked session has open. */
const open = vi.hoisted(() => ({ id: 4 }));

vi.mock("../src/client/usePiSession.ts", () => ({
  usePiSession: (): Pick<
    PiSession,
    | "status"
    | "capabilities"
    | "conversations"
    | "activeConversationId"
    | "activeConversation"
    | "activity"
  > => ({
    status: "connected",
    capabilities: new Set(["activity", "diagnostics", "usage"]),
    conversations: [
      { id: 1, archivedAt: 5, title: "Old chat" },
      { id: 4, kind: "main", name: "Mia", profile: "main", latestEntryId: 3 },
      {
        id: 6,
        kind: "bot",
        name: "Groceries",
        purpose: "Keep the shopping list.",
        profile: "default",
      },
      { id: 7, kind: "cobot", bot: 6, name: "Dinner" },
      { id: 8, owner: { conversationId: 7 } },
      { id: 10, owner: { conversationId: 1 } },
    ],
    activeConversationId: open.id,
    activeConversation: {
      id: open.id,
      entries: [],
      earlier: false,
      gaps: [],
      live: null,
      tools: [],
      compactions: [],
      queued: [],
      typing: [],
      agent: { model: { provider: "opencode-go", modelId: "x" }, tools: ["schedule"] } as never,
    },
    activity: {
      tasks: {
        "9": {
          id: 9,
          kind: "pi.generation",
          conversationId: 8,
          background: false,
          abortRequested: false,
          state: { status: "running", phase: "generate" },
          conversations: [],
        },
      },
    } as never,
  }),
}));

it("lists the main bot by its own name first, then purpose bots with their dots, and no older chat (COD-197)", () => {
  vi.stubGlobal("window", { location: { search: "" } });
  try {
    const html = renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
    expect(html).toContain(">Bots</h2>");
    expect(html).toContain(">New bot</button>");
    expect(html).not.toContain("New conversation");
    // MiPi renamed to Mia: its stored name, pinned first.
    expect(html.indexOf(">Mia<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Mia<")).toBeLessThan(html.indexOf(">Groceries<"));
    expect(html).toContain('<span class="bot-purpose">Keep the shopping list.</span>');
    expect(html.match(/aria-label="Working"/g)).toHaveLength(3);
    expect(html.match(/>New cobot<\/button>/g)).toHaveLength(2);
    expect(html).toMatch(
      /Groceries.*<details[^>]*>.*<ul class="bot-children">.*Dinner.*<ul class="bot-children">.*Subagent \(id: 8, owner: 7\)/,
    );
    expect(html).not.toContain("Subagent (id: 10");
    // The archived chat from before bots isn't listed.
    expect(html).not.toContain("Old chat");
    // MiPi can't be archived, so it offers no Archive (COD-233).
    expect(html).not.toContain(">Archive bot</button>");
    // MiPi's profile is shown as text: no picker that would fall back to another profile.
    expect(html).toMatch(/<output id="profile-picker"[^>]*>main<\/output>/);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  [6, "Archive bot"],
  [7, "Archive cobot"],
])("offers Archive on an open purpose bot or cobot (COD-233)", (id, label) => {
  vi.stubGlobal("window", { location: { search: "" } });
  open.id = id;
  try {
    const html = renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
    expect(html).toMatch(new RegExp(`<button class="text-button" type="button">${label}</button>`));
  } finally {
    open.id = 4;
    vi.unstubAllGlobals();
  }
});
