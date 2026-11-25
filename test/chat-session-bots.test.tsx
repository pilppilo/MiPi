import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";

vi.mock("../src/client/usePiSession.ts", () => ({
  usePiSession: (): Pick<
    PiSession,
    "status" | "conversations" | "activeConversationId" | "activeConversation" | "activity"
  > => ({
    status: "connected",
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
    ],
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
      agent: { model: { provider: "opencode-go", modelId: "x" }, tools: ["schedule"] } as never,
    },
    activity: {
      tasks: {
        "9": {
          id: 9,
          kind: "pi.generation",
          conversationId: 6,
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
    expect(html).toContain('aria-label="Working"');
    // The archived chat from before bots isn't listed.
    expect(html).not.toContain("Old chat");
    // MiPi's profile is shown as text: no picker that would fall back to another profile.
    expect(html).toMatch(/<output id="profile-picker"[^>]*>main<\/output>/);
  } finally {
    vi.unstubAllGlobals();
  }
});
