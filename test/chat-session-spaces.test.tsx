import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";

/** COD-249: the page's spaces follow the agent's capabilities, and `?space=workbench` opens Workbench. */
const mocked = vi.hoisted(() => ({ capabilities: new Set<string>() }));

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
    capabilities: mocked.capabilities,
    conversations: [
      { id: 4, kind: "main", name: "MiPi", latestEntryId: 12 },
      { id: 6, kind: "bot", name: "Planner" },
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
    },
    activity: { tasks: {} },
  }),
}));

const render = (
  capabilities: readonly string[],
  search = "",
  stored: Record<string, string> = {},
): string => {
  mocked.capabilities = new Set(capabilities);
  vi.stubGlobal("window", {
    location: { search },
    localStorage: { getItem: (key: string) => stored[key] ?? null, setItem: () => {} },
  });
  return renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spaces on the page (COD-249)", () => {
  it("shows Chat alone, with no Spaces list and no tabs, when the agent backs no other space", () => {
    const html = render([]);
    expect(html).not.toContain('id="spaces-heading"');
    expect(html).not.toContain('class="space-tabs"');
    expect(html).toContain('class="transcript"');
    // A link into Workbench lands on Chat when nothing backs it.
    expect(render([], "?space=workbench")).not.toContain('class="workbench"');
  });

  it("lists Chat and Workbench in the drawer and as tabs once the agent advertises activity", () => {
    const html = render(["activity"]);
    expect(html).toMatch(/<h2 id="spaces-heading" class="section-label">Spaces<\/h2>/);
    expect(html.match(/class="space-link"/g)).toHaveLength(2);
    expect(html).toMatch(
      /<nav class="space-tabs" aria-label="Spaces">.*>Chat<\/span>.*>Workbench<\/span>/,
    );
    expect(html).toMatch(
      /class="space-link" type="button" aria-current="page"[^>]*>.*Chat<\/button>/,
    );
    expect(html).toContain('class="transcript"');
  });

  it("opens Workbench from the page's link, in place of the transcript", () => {
    const html = render(["activity"], "?space=workbench");
    expect(html).toContain('class="workbench"');
    expect(html).not.toContain('class="transcript"');
    expect(html).toContain("Nothing running. MiPi is asleep.");
    expect(html).toMatch(/<strong>Planner<\/strong>/);
    expect(html).toMatch(/aria-current="page"[^>]*>.*Workbench<\/span><\/button><\/nav>/);
  });

  it("keeps the space in the drawer's bot links, so opening a bot stays in Workbench", () => {
    expect(render(["activity"], "?space=workbench")).toContain(
      'href="?conversation=6&amp;space=workbench"',
    );
    const chat = render(["activity"]);
    expect(chat).toContain('href="?conversation=6"');
    expect(chat).not.toContain('space=workbench"');
  });

  it("shows Vault only when advertised and takes bot links back to Chat", () => {
    const vault = render(["activity", "vault"], "?space=vault");
    expect(vault).toContain('class="vault-scroll"');
    expect(vault).not.toContain('class="prompt-bar"');
    expect(vault).not.toContain('class="approval-cards approval-cards--chat"');
    expect(vault).toContain('href="?conversation=4"');
    expect(vault).toContain('href="?conversation=6"');
    const older = render(["activity"], "?space=vault");
    expect(older).not.toContain('class="vault-scroll"');
    expect(older).toContain('class="prompt-bar"');
  });

  it("leaves the open bot's new messages unread while its Workbench shows", () => {
    // MiPi was read up to entry 10 on this device, and has 12.
    const stored = {
      "mipi:last-read:test": JSON.stringify({ seeded: true, entries: { "4": 10 } }),
    };
    expect(render(["activity"], "?space=workbench", stored)).toContain("bot-dot--unread");
    expect(render(["activity"], "", stored)).not.toContain("bot-dot--unread");
  });
});
