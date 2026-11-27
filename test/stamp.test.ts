/** The message stamp (COD-248): one format for the agent and the web door, hidden from the owner by default. */
import { describe, expect, it } from "vitest";
import { stampInput } from "../src/agent/stamp.ts";
import { formatStamp, parseStamp, queuedInputs } from "../src/protocol.ts";
import { conversationSnapshot, type TranscriptEntry } from "../src/client/session/session-state.ts";
import { formatScheduledInstruction, type TranscriptView } from "../src/protocol.ts";

const CHICAGO = "America/Chicago";
const AT = Date.UTC(2026, 10, 27, 22, 32);

describe("the message stamp", () => {
  it("is what stampInput writes, byte for byte, so the prompt cache doesn't move", () => {
    expect(stampInput("jerome", "Test", CHICAGO, AT)).toBe(
      "[jerome · Fri, Nov 27, 2026, 16:32 CST]\nTest",
    );
    expect(formatStamp("jerome", "Fri, Nov 27, 2026, 16:32 CST")).toBe(
      "[jerome · Fri, Nov 27, 2026, 16:32 CST]\n",
    );
  });

  it("reads back every door's stamp: the owner, a bot, the relay, another zone", () => {
    for (const [speaker, zone] of [
      ["jerome", CHICAGO],
      ["bot:Planner", CHICAGO],
      ["PiDu", "Europe/Helsinki"],
      ["Jérôme · home", "Asia/Kolkata"],
    ] as const) {
      const written = stampInput(speaker, "Hello\nthere", zone, AT);
      const { text, stamp } = parseStamp(written);
      expect(text).toBe("Hello\nthere");
      expect(stamp?.speaker).toBe(speaker);
      expect(written.startsWith(formatStamp(stamp!.speaker, stamp!.time))).toBe(true);
    }
  });

  it("leaves a message without a stamp, or one only like it, exactly as written", () => {
    for (const content of [
      "Test",
      "[note · remember this]\nmilk",
      "[jerome · Fri, Nov 27, 2026, 16:32 CST] on one line",
      " [jerome · Fri, Nov 27, 2026, 16:32 CST]\nindented",
      "Look: [jerome · Fri, Nov 27, 2026, 16:32 CST]\nlater",
      "",
    ]) {
      expect(parseStamp(content)).toEqual({ text: content });
    }
    // Only the first line is a stamp: one quoted in the message stays.
    const twice = stampInput("jerome", stampInput("jerome", "quoted", CHICAGO, AT), CHICAGO, AT);
    expect(parseStamp(twice).text).toBe("[jerome · Fri, Nov 27, 2026, 16:32 CST]\nquoted");
  });

  it("is taken off queued messages too", () => {
    const queued = queuedInputs({
      items: [
        { id: 7, mode: "followUp", content: stampInput("jerome", "Also this", CHICAGO, AT) },
        { id: 8, mode: "steer", content: "No stamp" },
      ],
    } as never);
    expect(queued).toEqual([
      {
        submissionId: 7,
        mode: "followUp",
        text: "Also this",
        stamp: { speaker: "jerome", time: "Fri, Nov 27, 2026, 16:32 CST" },
      },
      { submissionId: 8, mode: "steer", text: "No stamp" },
    ]);
  });
});

const view = (entries: readonly object[]): TranscriptView =>
  ({
    items: entries.map((entry) => ({ kind: "entry", entry })),
    docs: {},
  }) as unknown as TranscriptView;

const user = (id: number, content: string) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content, timestamp: 1 }],
});

describe("a stamped message in the transcript", () => {
  it("keeps the text and the stamp apart, and still knows a scheduled delivery", () => {
    const entries = conversationSnapshot(
      1,
      view([
        user(1, stampInput("jerome", "Test", CHICAGO, AT)),
        user(2, stampInput("bot:Planner", "<bot_message>\nDone\n</bot_message>", CHICAGO, AT)),
        user(3, "Unstamped"),
        user(4, formatScheduledInstruction({ id: "schedule:4", instruction: "Stretch" })),
      ]),
    ).entries;
    const pick = ({ role, text, stamp }: TranscriptEntry) => ({ role, text, stamp });
    expect(entries.map(pick)).toEqual([
      {
        role: "user",
        text: "Test",
        stamp: { speaker: "jerome", time: "Fri, Nov 27, 2026, 16:32 CST" },
      },
      {
        role: "user",
        text: "<bot_message>\nDone\n</bot_message>",
        stamp: { speaker: "bot:Planner", time: "Fri, Nov 27, 2026, 16:32 CST" },
      },
      { role: "user", text: "Unstamped", stamp: undefined },
      { role: "scheduled", text: "Stretch", stamp: undefined },
    ]);
  });
});
