import { applyImmutable } from "@earendil-works/chord/delta";
import { ConversationTranscript, type ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  conversationAfterSnapshot,
  initialSessionState,
  sessionReducer,
  type SessionState,
} from "../src/client/session-state.ts";
import {
  formatScheduledInstruction,
  MAX_BOT_NAME_CHARACTERS,
  MAX_BOT_PURPOSE_CHARACTERS,
  parseClientCommand,
  parseServerEventEnvelope,
  type ConversationSummary,
} from "../src/protocol.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

const event = (value: unknown) => parseServerEventEnvelope(JSON.stringify(value));

const user = (id: number, content: string) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content, timestamp: 1 }],
});

const viewOf = (
  entries: readonly object[],
  docs: Record<string, object> = {},
  before?: number,
): ConversationView =>
  ({
    conversation: { id: 1 },
    entries,
    docs,
    ...(before === undefined ? {} : { before }),
  }) as unknown as ConversationView;

/** A client transcript that never pages: the tests below only merge views. */
const transcript = () => new ConversationTranscript(async () => ({ items: [] }));

/** Merges `view` into `client` and shows it, as the session hook does. */
const show = (
  state: SessionState,
  view: ConversationView,
  client: ConversationTranscript = transcript(),
): SessionState =>
  sessionReducer(state, { type: "view", conversationId: 1, view: client.merge(view) });

describe("session state", () => {
  it("renders a late join and the streamed answer from view operations", () => {
    const frame = event({
      type: "conversation.view",
      conversationId: 1,
      view: viewOf([user(2, "Hello")], {
        "pi.live": {
          run: { taskId: 5, inputs: [3], turns: 0 },
          generation: { attempt: 1, message: assistant("Hel") },
        },
        "pi.agent": { thinkingLevel: "off", tools: [] },
        "pi.usage": { models: {}, tools: {} },
      }),
    });
    if (frame.type !== "conversation.view") throw new Error("Expected a view frame");
    const client = transcript();
    let view = frame.view;
    let state = show(initialSessionState, view, client);
    expect(state.snapshots[1]).toMatchObject({
      entries: [{ role: "user", text: "Hello" }],
      live: { active: true, text: "Hel" },
      agent: { thinkingLevel: "off", tools: [] },
      usage: { models: {}, tools: {} },
    });

    const apply = (ops: unknown[]) => {
      const update = event({ type: "conversation.ops", conversationId: 1, ops });
      if (update.type !== "conversation.ops") throw new Error("Expected an operations frame");
      view = applyImmutable(view, update.ops);
      state = show(state, view, client);
    };

    apply([["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"], "lo"]]);
    expect(state.snapshots[1]?.live).toEqual({ active: true, text: "Hello" });

    apply([
      [
        "p",
        ["entries"],
        1,
        0,
        [{ id: 4, conversationId: 1, kind: "pi.assistant", model: [assistant("Hello")] }],
      ],
      ["d", ["docs", "pi.live", "generation"]],
      ["d", ["docs", "pi.live", "run"]],
    ]);
    expect(state.snapshots[1]).toMatchObject({
      entries: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hello" },
      ],
      live: null,
    });
  });

  it("rejects malformed view operations", () => {
    expect(() =>
      event({ type: "conversation.ops", conversationId: 1, ops: [["s", [], 1]] }),
    ).toThrow();
    expect(() => event({ type: "conversation.view", conversationId: 1, view: {} })).toThrow(
      "Conversation view payload is invalid",
    );
  });

  it("labels scheduled deliveries rather than user messages", () => {
    const state = show(
      initialSessionState,
      viewOf([
        user(
          2,
          formatScheduledInstruction({ id: "schedule:2", instruction: "Look outside the window" }),
        ),
        user(
          3,
          formatScheduledInstruction({
            id: "schedule:3",
            instruction: "Check again tomorrow",
            recurrence: { cadence: { unit: "day", interval: 1 }, timezone: "Europe/Vienna" },
          }),
        ),
      ]),
    );
    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({
        role: "scheduled",
        text: "Look outside the window",
        canFork: false,
      }),
      expect.objectContaining({ role: "scheduled", text: "Check again tomorrow", canFork: false }),
    ]);
  });

  it("labels compaction and reset entries in place and strips the summary wrapper", () => {
    const state = show(
      initialSessionState,
      viewOf([
        user(2, "Before the summary"),
        {
          id: 5,
          conversationId: 1,
          kind: "pi.compaction",
          head: 3,
          model: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser asked about weather.\n</summary>",
                },
              ],
              timestamp: 1,
            },
          ],
          data: { reason: "threshold" },
        },
        { id: 6, conversationId: 1, kind: "pi.reset", head: 6 },
        {
          id: 7,
          conversationId: 1,
          kind: "pi.reset",
          head: 7,
          model: [{ role: "user", content: "Continue from the handoff.", timestamp: 2 }],
        },
      ]),
    );
    // The view keeps the history; head markers sit where they were written.
    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({ role: "user", text: "Before the summary" }),
      expect.objectContaining({
        role: "compaction",
        text: "User asked about weather.",
        canFork: false,
      }),
      expect.objectContaining({ role: "reset", text: "Context reset", canFork: false }),
      expect.objectContaining({
        role: "reset",
        text: "Continue from the handoff.",
        canFork: false,
      }),
    ]);
  });

  it("omits the rendered diagnostics block from tool result text", () => {
    const diagnostics = [{ severity: "warn", code: "truncated", message: "Output truncated" }];
    const state = show(
      initialSessionState,
      viewOf([
        {
          id: 4,
          conversationId: 1,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "get_weather",
              content: [
                { type: "text", text: "Sunny" },
                { type: "text", text: "<harness>\n[warn] Output truncated\n</harness>" },
              ],
              details: { source: "cache" },
              isError: false,
              timestamp: 1,
            },
          ],
          data: { diagnostics },
        },
      ]),
    );
    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({
        role: "tool",
        text: "Sunny",
        diagnostics,
        toolResult: {
          callId: "call-1",
          name: "get_weather",
          isError: false,
          details: { source: "cache" },
        },
      }),
    ]);
  });

  it("keeps assistant tool calls structured instead of repeating them as transcript text", () => {
    const state = show(
      initialSessionState,
      viewOf([
        {
          id: 3,
          conversationId: 1,
          kind: "pi.assistant",
          model: [
            {
              ...assistant("I will check."),
              content: [
                { type: "text", text: "I will check." },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "get_weather",
                  arguments: { location: "Vienna" },
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "I will check.",
        toolCalls: [{ callId: "call-1", name: "get_weather", args: { location: "Vienna" } }],
      }),
    ]);
  });

  it("shows tool progress, compactions, the agent, and usage from the view's documents", () => {
    const state = show(
      initialSessionState,
      viewOf([], {
        "pi.live": {
          run: { taskId: 5, inputs: [3], turns: 1 },
          tools: [
            {
              callId: "call-1",
              name: "search",
              status: "running",
              taskId: 8,
              output: "searching",
              details: { matches: 2 },
              diagnostics: [{ severity: "info", message: "Using cached index" }],
            },
          ],
          compactions: [{ taskId: 9, trigger: "threshold", blocking: true, attempt: 1 }],
        },
        "pi.agent": {
          model: { provider: "openai", modelId: "gpt-test" },
          thinkingLevel: "high",
          tools: ["search"],
        },
        "pi.usage": {
          models: {
            "openai/gpt-test": { ...usage, input: 10, output: 5, totalTokens: 15 },
          },
          tools: {},
        },
      }),
    );
    expect(state.snapshots[1]).toMatchObject({
      live: { active: true, text: "" },
      tools: [
        {
          callId: "call-1",
          name: "search",
          status: "running",
          output: "searching",
          details: { matches: 2 },
          diagnostics: [{ severity: "info", message: "Using cached index" }],
        },
      ],
      compactions: [{ taskId: 9, reason: "threshold", blocking: true }],
      agent: {
        model: { provider: "openai", modelId: "gpt-test" },
        thinkingLevel: "high",
        tools: ["search"],
      },
      usage: { models: { "openai/gpt-test": { input: 10, output: 5, totalTokens: 15 } } },
    });
  });

  it("explains a run or compaction that ended without a result", () => {
    let state = show(
      initialSessionState,
      viewOf([], {
        "pi.live": {
          runFailure: { taskId: 9, inputs: [3], reason: "model_error", detail: "401 Unauthorized" },
          compactionFailure: { taskId: 10, trigger: "manual", error: "summary failed" },
        },
      }),
    );
    expect(state.snapshots[1]?.failure).toEqual({
      taskId: 9,
      kind: "Run",
      message: "The model request failed: 401 Unauthorized",
    });

    state = show(
      state,
      viewOf([], {
        "pi.live": {
          compactionFailure: { taskId: 10, trigger: "manual", error: "summary failed" },
        },
      }),
    );
    expect(state.snapshots[1]?.failure).toEqual({
      taskId: 10,
      kind: "Compaction",
      message: "summary failed",
    });

    state = show(state, viewOf([], { "pi.live": { run: { taskId: 11, inputs: [12], turns: 0 } } }));
    expect(state.snapshots[1]?.failure).toBeUndefined();
  });

  it("lists queued inputs from the inbox document, without passive writes", () => {
    const state = show(
      initialSessionState,
      viewOf([], {
        "pi.inbox": {
          items: [
            { id: 5, mode: "followUp", content: "Next question" },
            {
              id: 6,
              mode: "steer",
              content: [{ type: "text", text: "Faster" }, { type: "image" }],
            },
            { id: 7, mode: "write", content: "context only" },
          ],
        },
      }),
    );
    expect(state.snapshots[1]?.queued).toEqual([
      { submissionId: 5, mode: "followUp", text: "Next question" },
      { submissionId: 6, mode: "steer", text: "Faster\n[Image]" },
    ]);
  });

  it("offers earlier entries and missing ranges the client has not loaded", () => {
    const client = transcript();
    let state = show(
      initialSessionState,
      viewOf([user(11, "Eleven"), user(12, "Twelve")], {}, 10),
      client,
    );
    expect(state.snapshots[1]).toMatchObject({ earlier: true, gaps: [] });

    // A reconnect whose window starts past what the client holds leaves a gap between them.
    state = show(state, viewOf([user(20, "Twenty")], {}, 15), client);
    expect(state.snapshots[1]?.entries.map(({ id }) => id)).toEqual([11, 12, 20]);
    expect(state.snapshots[1]?.gaps).toEqual([{ kind: "gap", after: 12, upTo: 20 }]);
  });

  it("keeps typing presence when the view changes", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({ type: "presence.typing", conversationId: 1, usernames: ["Bob"] }),
    });
    state = show(state, viewOf([user(2, "Hi")]));
    expect(state.snapshots[1]?.typing).toEqual(["Bob"]);
  });

  it("does not change the selected conversation for prompt acknowledgements", () => {
    let state = sessionReducer(initialSessionState, { type: "select", conversationId: 2 });
    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "command.result",
        command: "prompt.submit",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
        submissionId: 3,
      }),
    });
    expect(state.activeConversationId).toBe(2);

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "command.result",
        command: "bot.create",
        requestId: "create-1",
        ok: true,
        conversationId: 4,
      }),
    });
    expect(state.activeConversationId).toBe(4);
  });

  it("tracks the session activity graph from snapshots and updates", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: {
          conversations: [{ id: 1 }],
          activity: {
            tasks: {
              "4": {
                id: 4,
                kind: "pi.generation",
                conversationId: 1,
                background: false,
                abortRequested: false,
                state: { status: "running", phase: "stream" },
                conversations: [],
              },
            },
          },
        },
      }),
    });

    expect(state.activity?.tasks["4"]).toMatchObject({
      kind: "pi.generation",
      state: { status: "running", phase: "stream" },
    });

    const sleeping = {
      id: 6,
      kind: "app.deliver-scheduled-instruction",
      conversationId: 1,
      background: true,
      abortRequested: false,
      state: { status: "sleeping", phase: "wait", until: 1_800_000_000_000 },
      conversations: [],
    };
    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "session.activity", activity: { tasks: { "6": sleeping } } }),
    });
    expect(state.activity).toEqual({ tasks: { "6": sleeping } });
    expect(() =>
      event({
        type: "session.activity",
        activity: {
          tasks: { "6": { ...sleeping, state: { status: "sleeping", phase: "wait" } } },
        },
      }),
    ).toThrow("Activity sleeping task state is invalid");
    expect(
      event({
        type: "session.activity",
        activity: { tasks: { "6": { ...sleeping, blocked: "missing_task" } } },
      }),
    ).toMatchObject({ activity: { tasks: { "6": { blocked: "missing_task" } } } });
    // Pi Durable 1.5 ends tasks at the restart limit instead of parking them.
    expect(() =>
      event({
        type: "session.activity",
        activity: { tasks: { "6": { ...sleeping, blocked: "restart_limit" } } },
      }),
    ).toThrow("Activity task blocked reason is invalid");

    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "session.activity", activity: { tasks: {} } }),
    });
    expect(state.activity).toEqual({ tasks: {} });

    expect(() =>
      event({
        type: "session.activity",
        activity: {
          tasks: {
            "4": {
              id: 5,
              kind: "pi.generation",
              conversationId: 1,
              background: false,
              abortRequested: false,
              state: { status: "running", phase: "stream" },
              conversations: [],
            },
          },
        },
      }),
    ).toThrow("Activity task key does not match its id");
  });

  it("keeps conversation owners in the session snapshot", () => {
    const state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: { conversations: [{ id: 1 }, { id: 7, owner: { conversationId: 1 } }] },
      }),
    });
    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
    expect(() =>
      event({
        type: "session.snapshot",
        session: { conversations: [{ id: 7, owner: { conversationId: "1" } }] },
      }),
    ).toThrow("conversation.owner.conversationId must be a positive integer");
  });

  it("follows the agent to MiPi when the open bot is archived, but keeps an archived one opened read-only (COD-233)", () => {
    const main = { id: 4, kind: "main", name: "MiPi", profile: "main" } as const;
    const garden = { id: 6, kind: "bot", name: "Garden", profile: "default" } as const;
    const seedlings = { id: 7, kind: "cobot", bot: 6, name: "Seedlings" } as const;
    const snapshot = (conversations: ConversationSummary[]) =>
      event({ type: "session.snapshot", session: { conversations } });
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: snapshot([main, garden, seedlings]),
    });
    state = sessionReducer(state, { type: "select", conversationId: 7 });
    // The cobot archived alone, from this tab or another: the tab leaves it, as the agent moved its watch.
    state = sessionReducer(state, {
      type: "event",
      event: snapshot([main, garden, { ...seedlings, archivedAt: 9 }]),
    });
    expect(state.activeConversationId).toBe(4);
    // Opened from Settings → Archived while archived: read-only, and it stays.
    state = sessionReducer(state, { type: "select", conversationId: 7 });
    state = sessionReducer(state, {
      type: "event",
      event: snapshot([main, { ...garden, profile: "empty" }, { ...seedlings, archivedAt: 9 }]),
    });
    expect(state.activeConversationId).toBe(7);
    // A live bot that stays live stays; one that's gone goes to MiPi.
    expect(conversationAfterSnapshot([main, garden], [main, garden], 6)).toBe(6);
    expect(conversationAfterSnapshot([main, garden], [main], 6)).toBe(4);
    expect(conversationAfterSnapshot([main, garden], [main, { ...garden, archivedAt: 3 }], 6)).toBe(
      4,
    );
  });

  it("opens MiPi first and keeps each bot's newest entry from head events (COD-197)", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: {
          conversations: [
            { id: 1, archivedAt: 5, latestEntryId: 3 },
            { id: 4, kind: "main", name: "MiPi", profile: "main", latestEntryId: 9 },
            {
              id: 6,
              kind: "bot",
              name: "Groceries",
              purpose: "Keep the list.",
              profile: "default",
            },
          ],
        },
      }),
    });
    // MiPi, not the root conversation, though both are listed.
    expect(state.activeConversationId).toBe(4);
    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "conversation.head", conversationId: 6, latestEntryId: 12 }),
    });
    expect(state.conversations.find(({ id }) => id === 6)?.latestEntryId).toBe(12);
    // An older head changes nothing; one for a conversation the list doesn't have adds nothing.
    const before = state;
    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "conversation.head", conversationId: 4, latestEntryId: 2 }),
    });
    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "conversation.head", conversationId: 99, latestEntryId: 50 }),
    });
    expect(state).toBe(before);
    expect(() =>
      event({ type: "session.snapshot", session: { conversations: [{ id: 2, kind: "robot" }] } }),
    ).toThrow("Conversation kind is invalid");
  });

  it("checks bot commands at the door (COD-197)", () => {
    const command = (value: unknown) => parseClientCommand(JSON.stringify(value));
    expect(
      command({
        type: "bot.create",
        requestId: "r1",
        name: "  Groceries ",
        purpose: " Keep the list. ",
        profile: "default",
      }),
    ).toEqual({
      type: "bot.create",
      requestId: "r1",
      name: "Groceries",
      purpose: "Keep the list.",
      profile: "default",
    });
    expect(() =>
      command({ type: "bot.create", requestId: "r2", name: " ", purpose: "x", profile: "default" }),
    ).toThrow("name must contain text");
    expect(() =>
      command({
        type: "bot.create",
        requestId: "r3",
        name: "x".repeat(MAX_BOT_NAME_CHARACTERS + 1),
        purpose: "x",
        profile: "default",
      }),
    ).toThrow(`name cannot exceed ${MAX_BOT_NAME_CHARACTERS} characters`);
    expect(() =>
      command({
        type: "bot.create",
        requestId: "r4",
        name: "Groceries",
        purpose: "x".repeat(MAX_BOT_PURPOSE_CHARACTERS + 1),
        profile: "default",
      }),
    ).toThrow(`purpose cannot exceed ${MAX_BOT_PURPOSE_CHARACTERS} characters`);
    expect(() =>
      command({ type: "bot.create", requestId: "r5", name: "Groceries", purpose: "x" }),
    ).toThrow("profile is required");
    expect(
      command({ type: "bot.rename", requestId: "r6", conversationId: 6, name: "Shopping" }),
    ).toEqual({ type: "bot.rename", requestId: "r6", conversationId: 6, name: "Shopping" });
    // The command bots replaced is gone.
    expect(() => command({ type: "conversation.create", requestId: "r7" })).toThrow();
  });

  it("adds a committed subagent conversation without replacing the session snapshot", () => {
    const initial = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: { conversations: [{ id: 1 }] },
      }),
    });
    const state = sessionReducer(initial, {
      type: "event",
      event: event({
        type: "conversation.created",
        conversation: { id: 7, owner: { conversationId: 1 } },
      }),
    });

    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
  });

  it("rejects command results without a valid command discriminator", () => {
    expect(() =>
      event({
        type: "command.result",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
      }),
    ).toThrow("Command result command is invalid");
  });

  it("tracks typing presence per conversation", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "presence.typing",
        conversationId: 2,
        usernames: ["Anne", "John"],
      }),
    });
    expect(state.snapshots[2]?.typing).toEqual(["Anne", "John"]);

    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "presence.typing", conversationId: 2, usernames: [] }),
    });
    expect(state.snapshots[2]?.typing).toEqual([]);
  });

  it("validates entry pages in command results", () => {
    expect(
      event({
        type: "command.result",
        command: "conversation.entries",
        requestId: "page-1",
        ok: true,
        conversationId: 1,
        page: { items: [user(2, "Hi")], next: { id: 1 } },
      }),
    ).toMatchObject({ page: { items: [{ id: 2 }], next: { id: 1 } } });
    expect(() =>
      event({
        type: "command.result",
        command: "conversation.entries",
        requestId: "page-1",
        ok: true,
        page: { items: "nope" },
      }),
    ).toThrow("Entries page is invalid");
  });
});
