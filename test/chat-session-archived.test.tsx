import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import { SettingsPanel } from "../src/client/SettingsPanel.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";
import type { ConversationSummary } from "../src/protocol.ts";

const conversations: ConversationSummary[] = [
  { id: 4, kind: "main", name: "MiPi", profile: "main" },
  { id: 20, kind: "bot", name: "Garden", purpose: "Look after it.", archivedAt: 30 },
  { id: 21, kind: "cobot", bot: 20, name: "Seedlings", archivedAt: 30 },
  { id: 1, title: "Plan the trip", archivedAt: 10 },
];

vi.mock("../src/client/usePiSession.ts", () => ({
  usePiSession: (): Pick<
    PiSession,
    "status" | "conversations" | "activeConversationId" | "activeConversation"
  > => ({
    status: "connected",
    conversations,
    activeConversationId: 21,
    activeConversation: {
      id: 21,
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

it("opens an archived cobot read-only, with Restore off until its bot is back (COD-201)", () => {
  vi.stubGlobal("window", { location: { search: "" } });
  try {
    const html = renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
    expect(html).toMatch(/<button[^>]*aria-controls="settings-panel"[^>]*>.*Settings<\/button>/);
    expect(html).toContain("Archived: read-only.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Restore Garden first.">Restore</);
    expect(html).toMatch(
      /<textarea[^>]*placeholder="Archived: restore it to send a message."[^>]*disabled=""/,
    );
    // No rename for an archived cobot, and the sidebar doesn't list archived bots.
    expect(html).not.toContain("Rename cobot");
    expect(html).not.toContain('class="bot-name">Garden');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("lists archived bots, cobots and earlier chats in Settings, each to open or restore", () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPanel, {
      conversations,
      disabled: false,
      onOpen: () => {},
      onRestore: () => {},
      onClose: () => {},
    }),
  );
  expect(html).toContain(">Settings</h2>");
  expect(html).toMatch(/aria-current="page"[^>]*>Archived</);
  expect(html.indexOf(">Garden<")).toBeLessThan(html.indexOf(">Seedlings<"));
  expect(html.indexOf(">Seedlings<")).toBeLessThan(html.indexOf(">Plan the trip<"));
  expect(html).toContain("Chat from before bots");
  expect(html).toContain('aria-label="Open Plan the trip read-only"');
  expect(html).toMatch(/<button type="button" aria-label="Restore Plan the trip">Restore</);
  expect(html).toMatch(
    /disabled=""[^>]*aria-label="Restore Seedlings" title="Restore Garden first."/,
  );
  expect(html).not.toContain(">Delete<");
  expect(html).not.toContain(">MiPi<");
});
