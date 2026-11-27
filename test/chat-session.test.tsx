import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";

vi.mock("../src/client/usePiSession.ts", () => ({
  usePiSession: (): Pick<
    PiSession,
    | "status"
    | "capabilities"
    | "conversations"
    | "activeConversationId"
    | "activeConversation"
    | "usage"
  > => ({
    status: "connected",
    capabilities: new Set(["activity", "diagnostics", "usage"]),
    conversations: [{ id: 1 }],
    activeConversationId: 1,
    activeConversation: {
      id: 1,
      entries: [],
      earlier: false,
      gaps: [],
      live: null,
      tools: [],
      compactions: [],
      queued: [],
      typing: [],
      failure: { taskId: 9, kind: "Run", message: "The model request failed: 401 Unauthorized" },
    },
    usage: {
      day: "2026-11-24",
      spent: 0,
      runs: { used: 0, cap: 50 },
      providers: [],
      held: "provider-limit",
      limits: [{ provider: "faux", label: "OpenCode Go", text: "OpenCode Go usage limit reached" }],
    },
  }),
}));

it("renders the provider hold alongside the original turn failure", () => {
  vi.stubGlobal("window", { location: { search: "" } });
  try {
    const html = renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
    expect(html).toContain('role="status">OpenCode Go usage limit reached</p>');
    expect(html).toContain(
      'role="alert">Run failed: The model request failed: 401 Unauthorized</p>',
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
