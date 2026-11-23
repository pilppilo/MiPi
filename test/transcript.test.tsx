import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { quietAnswers, TranscriptList } from "../src/client/Transcript.tsx";
import type { TranscriptEntry, ToolProgress } from "../src/client/session-state.ts";

const toolRequest: TranscriptEntry = {
  id: 2,
  conversationId: 1,
  kind: "pi.assistant",
  role: "assistant",
  text: "I will check.",
  timestamp: 1,
  canFork: true,
  toolCalls: [
    {
      callId: "call-1",
      name: "get_weather",
      args: { location: "Vienna" },
    },
  ],
};

const runningTool: ToolProgress = {
  callId: "call-1",
  name: "get_weather",
  status: "running",
  output: "Checking conditions",
};

function render(
  entries: readonly TranscriptEntry[],
  tools: readonly ToolProgress[],
  onFork?: (entryId: number) => void,
): string {
  return renderToStaticMarkup(
    createElement(TranscriptList, {
      entries,
      tools,
      runActive: true,
      onFork,
    }),
  );
}

const entry = (
  id: number,
  role: TranscriptEntry["role"],
  text: string,
  more: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({ id, conversationId: 1, kind: "x", role, text, canFork: false, ...more });

describe("NO_SEND answers", () => {
  it("are quiet only after scheduled inputs with no failed tool", () => {
    const failed: Partial<TranscriptEntry> = {
      toolResult: { callId: "c", name: "t", isError: true },
    };
    const entries = [
      entry(1, "scheduled", "Check the oven"),
      entry(2, "assistant", "NO_SEND"),
      entry(3, "user", "Hi"),
      entry(4, "scheduled", "Check the door"),
      entry(5, "assistant", "NO_SEND"),
      entry(6, "scheduled", "Check the feed"),
      entry(7, "assistant", "", { toolCalls: [{ callId: "c", name: "t", args: {} }] }),
      entry(8, "tool", "broken", failed),
      entry(9, "assistant", "NO_SEND"),
      entry(10, "scheduled", "Check the mail"),
      entry(11, "assistant", "<think>none</think>NO_SEND"),
    ];
    expect([...quietAnswers(entries)]).toEqual([2, 11]);
    // An unanswered message before a compaction doesn't count against the checks after it.
    expect([
      ...quietAnswers([
        entry(20, "user", "Hi"),
        entry(21, "compaction", "Summary"),
        entry(22, "scheduled", "Check"),
        entry(23, "assistant", "NO_SEND"),
      ]),
    ]).toEqual([23]);
    const html = renderToStaticMarkup(
      createElement(TranscriptList, { entries: entries.slice(0, 2), tools: [], runActive: false }),
    );
    expect(html).toContain("Nothing to report");
    expect(html).not.toContain(">NO_SEND<");
  });
});

describe("transcript rendering", () => {
  it("hides system entries when asked, and shows them otherwise", () => {
    const system: TranscriptEntry = {
      id: 1,
      conversationId: 1,
      kind: "pi.system",
      role: "system",
      text: "You are MiPi, a concise personal assistant.",
      canFork: false,
    };
    const reply: TranscriptEntry = {
      ...system,
      id: 2,
      kind: "pi.assistant",
      role: "assistant",
      text: "Hi",
    };
    const markup = (hideSystem: boolean) =>
      renderToStaticMarkup(
        createElement(TranscriptList, {
          entries: [system, reply],
          tools: [],
          runActive: false,
          hideSystem,
        }),
      );
    expect(markup(true)).not.toContain("concise personal assistant");
    expect(markup(true)).toContain("Hi");
    expect(markup(false)).toContain("concise personal assistant");
  });

  it("keeps the fork action inside the entry header", () => {
    const userEntry: TranscriptEntry = {
      id: 1,
      conversationId: 1,
      kind: "pi.user",
      role: "user",
      text: "Hello",
      timestamp: 1,
      canFork: true,
    };
    const transcript = render([userEntry], [], () => undefined);
    const fork = transcript.indexOf(">Fork</button>");
    const headerEnd = transcript.indexOf("</header>");

    expect(fork).toBeGreaterThan(0);
    expect(fork).toBeLessThan(headerEnd);
    expect(transcript).toContain('aria-label="Fork from this entry"');
    expect(transcript).toContain('title="Entry (id: 1)"');
    expect(transcript).not.toContain("<footer");
  });

  it("replaces inline progress with the committed result for the same tool call", () => {
    const running = render([toolRequest], [runningTool]);

    expect(running).toContain("get_weather");
    expect(running).toContain("Running");
    expect(running).toContain("Checking conditions");
    expect(running).toContain("Vienna");
    expect(running).not.toContain("Tool activity");
    expect(running).not.toContain("Tool call:");

    const result: TranscriptEntry = {
      id: 3,
      conversationId: 1,
      kind: "pi.tool-result",
      role: "tool",
      text: "Sunny, 21°C",
      timestamp: 2,
      canFork: false,
      toolResult: {
        callId: "call-1",
        name: "get_weather",
        isError: false,
        details: { source: "forecast" },
      },
    };
    const completed = render([toolRequest, result], [{ ...runningTool, status: "done" }]);

    expect(completed.match(/get_weather/g)).toHaveLength(1);
    expect(completed).toContain("Completed");
    expect(completed).toContain("Sunny, 21°C");
    expect(completed).toContain("forecast");
    expect(completed).not.toContain("Running");
    expect(completed).not.toContain("Checking conditions");
  });
  it("pairs reused provider call IDs with results in transcript order", () => {
    const secondRequest: TranscriptEntry = {
      ...toolRequest,
      id: 4,
      text: "I will check again.",
      toolCalls: [
        {
          callId: "call-1",
          name: "get_weather",
          args: { location: "Graz" },
        },
      ],
    };
    const result = (id: number, text: string): TranscriptEntry => ({
      id,
      conversationId: 1,
      kind: "pi.tool-result",
      role: "tool",
      text,
      canFork: false,
      toolResult: {
        callId: "call-1",
        name: "get_weather",
        isError: false,
      },
    });

    const transcript = render(
      [toolRequest, result(3, "Vienna result"), secondRequest, result(5, "Graz result")],
      [],
    );

    expect(transcript.match(/Vienna result/g)).toHaveLength(1);
    expect(transcript.match(/Graz result/g)).toHaveLength(1);
    expect(transcript.indexOf("Vienna result")).toBeLessThan(transcript.indexOf("Graz result"));
  });
});
