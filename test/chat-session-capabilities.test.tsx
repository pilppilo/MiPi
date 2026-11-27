import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";
import { CORE_CAPABILITIES } from "../src/protocol.ts";

/**
 * COD-246: the web door shows an optional panel only when the agent advertises its capability. Chat itself (the bots
 * list, the transcript, the composer) is always there.
 */
const mocked = vi.hoisted(() => ({ capabilities: new Set<string>() }));

// Every panel that starts closed starts open here, so Settings and Activity render server-side.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: <T,>(initial: T | (() => T)) =>
      react.useState(initial === false ? (true as T) : initial),
  };
});

// Settings itself is tested on its own (`settings-diagnostics.test.tsx`): here, only whether it gets Diagnostics.
vi.mock("../src/client/SettingsPanel.tsx", () => ({
  SettingsPanel: ({ diagnostics }: { readonly diagnostics?: unknown }) =>
    createElement("section", {
      id: "settings-panel",
      "data-diagnostics": diagnostics === undefined ? "off" : "on",
    }),
}));

vi.mock("../src/client/usePiSession.ts", () => ({
  usePiSession: (): Pick<
    PiSession,
    | "status"
    | "capabilities"
    | "conversations"
    | "activeConversationId"
    | "activeConversation"
    | "activity"
    | "usage"
  > => ({
    status: "connected",
    capabilities: mocked.capabilities,
    conversations: [{ id: 1, kind: "main", name: "MiPi" }],
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
    },
    activity: { tasks: {} },
    usage: { day: "2026-11-27", spent: 0.5, runs: { used: 1, cap: 50 }, providers: [] },
  }),
}));

const render = (capabilities: readonly string[]): string => {
  mocked.capabilities = new Set(capabilities);
  vi.stubGlobal("window", { location: { search: "" } });
  return renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
};

/** What the page shows of each optional panel. */
const panels = (html: string) => ({
  usage: html.includes("Today ~$0.50"),
  activity: html.includes('class="activity-toggle"') && html.includes('id="activity-panel"'),
  diagnostics: html.includes('data-diagnostics="on"'),
});

/** Chat works whatever is advertised. */
const expectChat = (html: string) => {
  expect(html).toContain('id="conversations-heading"');
  expect(html).toContain('id="transcript-heading"');
  expect(html).toContain("<textarea");
  expect(html).toContain('id="settings-panel"');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("capability-gated panels (COD-246)", () => {
  it("shows every panel the agent advertises", () => {
    const html = render(CORE_CAPABILITIES);
    expectChat(html);
    expect(panels(html)).toEqual({ usage: true, activity: true, diagnostics: true });
  });

  it("shows chat alone with no capabilities, as from an older agent", () => {
    const html = render([]);
    expectChat(html);
    expect(panels(html)).toEqual({ usage: false, activity: false, diagnostics: false });
    expect(html).not.toContain("session-workspace--activity-open");
  });

  for (const off of CORE_CAPABILITIES) {
    it(`leaves out only ${off} when it is off`, () => {
      const html = render(CORE_CAPABILITIES.filter((id) => id !== off));
      expectChat(html);
      expect(panels(html)).toEqual({
        usage: off !== "usage",
        activity: off !== "activity",
        diagnostics: off !== "diagnostics",
      });
    });
  }

  it("ignores a capability it has no panel for", () => {
    expect(panels(render(["future.thing"]))).toEqual({
      usage: false,
      activity: false,
      diagnostics: false,
    });
  });
});
