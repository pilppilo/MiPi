import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ChatSession } from "../src/client/ChatSession.tsx";
import type { PiSession } from "../src/client/usePiSession.ts";

/** COD-244: a bot's details and the New bot sheet speak in plain names, not tool and profile ids. */

// Every panel that starts closed starts open here, so New bot and the details render server-side.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: <T,>(initial: T | (() => T)) =>
      react.useState(initial === false ? (true as T) : initial),
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
    | "options"
  > => ({
    status: "connected",
    capabilities: new Set(),
    conversations: [
      { id: 4, kind: "main", name: "MiPi" },
      { id: 6, kind: "bot", name: "Planner", purpose: "Plan my week.", profile: "default" },
    ],
    activeConversationId: 6,
    activeConversation: {
      id: 6,
      entries: [],
      earlier: false,
      gaps: [],
      live: null,
      tools: [],
      compactions: [],
      queued: [],
      typing: [],
      agent: {
        model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
        thinkingLevel: "low",
        tools: ["schedule", "web_fetch", "brand_new_tool"],
      } as never,
    },
    options: {
      models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
      profiles: [
        { id: "default", name: "Everyday tools: scheduling, history search, memory and web pages" },
        { id: "empty", name: "Plain chat, no tools" },
      ],
      defaultModel: "deepseek-v4.1-flash",
    },
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const render = (): string => {
  vi.stubGlobal("window", { location: { search: "" } });
  return renderToStaticMarkup(createElement(ChatSession, { sessionId: "test" }));
};

it("shows a bot's tools and toolkit by plain name, with the ids only in titles", () => {
  const html = render();
  const details = html.match(/<section class="runtime-information"[^>]*>(.*?)<\/section>/)?.[1];
  expect(details).toBeDefined();
  expect(details).toMatch(/<li title="Set reminders and repeating tasks">Reminders<\/li>/);
  expect(details).toMatch(/<li title="Open and read a web page">Web pages<\/li>/);
  // A tool this client has no name for reads as words, with its id as the title.
  expect(details).toMatch(/<li title="brand_new_tool">Brand new tool<\/li>/);
  expect(details).toMatch(/<option value="default" title="[^"]*" selected="">Everyday<\/option>/);
  expect(details).toMatch(/<option value="empty"[^>]*>Just chat<\/option>/);
  expect(details).toContain("Everyday tools: scheduling, history search, memory and web pages");
  expect(details).toMatch(/<option value="deepseek-v4.1-flash" selected="">DeepSeek V4.1 Flash/);
  expect(details).toContain("Thinking: Light");
  // No raw ids as visible text.
  expect(details).not.toMatch(/>[^<]*(web_fetch|schedule|brand_new_tool)[^<]*</);
});

it("offers toolkits as plain-named choices in a New bot sheet", () => {
  const html = render();
  const sheet = html.match(/<form id="new-bot-form"[^>]*>(.*?)<\/form>/)?.[0];
  expect(sheet).toBeDefined();
  expect(sheet).toMatch(/role="dialog" aria-modal="true" aria-labelledby="new-bot-heading"/);
  expect(sheet).toMatch(/<h2 id="new-bot-heading">New bot<\/h2>/);
  expect(sheet).toMatch(/<legend class="field-label">What it can use<\/legend>/);
  expect(sheet).toMatch(
    /<input type="radio" name="toolkit" checked="" value="default"\/><span class="toolkit-choice-text"><strong>Everyday<\/strong><span>Everyday tools/,
  );
  expect(sheet).toMatch(
    /value="empty"\/><span class="toolkit-choice-text"><strong>Just chat<\/strong>/,
  );
  expect(sheet).not.toMatch(/>(default|empty)</);
  // Nothing behind the sheet takes input while it is open.
  expect(html).toMatch(/<aside[^>]*id="spaces-drawer"[^>]*inert=""/);
  expect(html).toMatch(/<main class="conversation-view" inert="">/);
});
