/**
 * The extension contract (COD-209): composition, Pi's replacement rule, per-conversation selection, and the connectors
 * the built-ins use (untrusted content, input origin).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  defineExtension,
  Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { composeMipi } from "../src/agent/composition.ts";
import { setProfile, syncProfileTools } from "../src/agent/conversations.ts";
import { type MipiExtension, resolveExtensions } from "../src/agent/extensions.ts";
import { coreExtensions } from "../src/agent/harness.ts";
import { Origins, UNKNOWN_ORIGIN } from "../src/agent/origin.ts";
import { connectorsOf, createConnectors } from "../src/agent/connectors.ts";
import type { DeliveryDestination } from "../src/agent/delivery.ts";
import { AgentSettings } from "../src/agent/settings.ts";
import { untrustedToolNames } from "../src/agent/untrusted.ts";
import { BUILT_IN_EXTENSIONS } from "../src/extensions/builtins.ts";
import { ScheduledReminder } from "../src/extensions/builtin/reminders/reminder-task.ts";
import type { ReminderDestination } from "../src/extensions/builtin/reminders/reminder-task.ts";
import { addLesson, MemoryDoc } from "../src/extensions/builtin/memory/memory.ts";
import { MEMORY_IDLE_MS, MemoryPassRuntime } from "../src/extensions/builtin/memory/memory-pass.ts";

const ctx = BACKGROUND_CONTEXT;

const tool = (name: string): ToolRegistration => ({
  name,
  description: `${name} (test)`,
  parameters: obj({ text: str() }),
  replay: "safe",
  execute: async () => ({ output: [{ type: "text", text: name }] }),
});

const extension = (
  name: string,
  tools: string[],
  more: Partial<MipiExtension> = {},
): MipiExtension => ({
  name,
  tier: "optional",
  pi: defineExtension({ name, tools: tools.map(tool) }),
  ...more,
});

describe("resolveExtensions", () => {
  it("puts core first, then the rest by slot and name, and lets no conversation switch core off", () => {
    const resolved = resolveExtensions(coreExtensions(), BUILT_IN_EXTENSIONS);
    expect(resolved.selection.map(({ name }) => name)).toEqual([
      "chat",
      "proactive",
      "provider-limits",
      "history-search",
      "reminders",
      "web-fetch",
      "memory",
    ]);
    expect(resolved.switchable).toEqual(["history-search", "reminders", "web-fetch", "memory"]);
    // The search subagent's extension is installed, never selected by default.
    expect(resolved.installed.map(({ name }) => name)).toContain("conversation-search");
    expect(resolved.selection.map(({ name }) => name)).not.toContain("conversation-search");
    expect([...resolved.untrustedTools]).toEqual(["web_fetch"]);
    expect(resolved.replacements).toEqual([]);
  });

  it("drops a replaceable built-in whole when another extension registers its tool, whatever the order", () => {
    const fetcher = extension("my-fetch", ["web_fetch"]);
    for (const list of [
      [...BUILT_IN_EXTENSIONS, fetcher],
      [fetcher, ...BUILT_IN_EXTENSIONS],
    ]) {
      const resolved = resolveExtensions(coreExtensions(), list);
      expect(resolved.replacements).toEqual([
        { replaced: "web-fetch", by: "my-fetch", tool: "web_fetch" },
      ]);
      expect(resolved.active.map(({ name }) => name)).not.toContain("web-fetch");
      expect(resolved.tools.get("web_fetch")).toBe(fetcher.pi!.tools![0]);
      // Still installed, so what it stored keeps resolving.
      expect(resolved.installed.map(({ name }) => name)).toContain("web-fetch");
    }
  });

  it("keeps a replaced extension's tasks, and replaces memory's pass with it", () => {
    const remember = extension("my-memory", ["remember"]);
    const resolved = resolveExtensions(coreExtensions(), [...BUILT_IN_EXTENSIONS, remember]);
    expect(resolved.replacements).toEqual([
      { replaced: "memory", by: "my-memory", tool: "remember" },
    ]);
    // Its wake sources (the memory pass) are no longer active: only active extensions start background work.
    expect(resolved.active.some(({ wakeSources }) => wakeSources !== undefined)).toBe(false);

    const tasks = composeMipi({
      extensions: [...BUILT_IN_EXTENSIONS, extension("my-schedule", ["schedule"])],
    }).tasks.map(({ definition }) => definition.name);
    expect(tasks).toEqual(
      expect.arrayContaining(["app.reminder", "app.deliver-scheduled-instruction"]),
    );
  });

  it("fails to compose on a clash nothing resolves", () => {
    expect(() =>
      resolveExtensions(coreExtensions(), [extension("a", ["x"]), extension("b", ["x"])]),
    ).toThrow(/"x" is registered by both "a" and "b"/);
    expect(() =>
      resolveExtensions(coreExtensions(), [
        extension("a", ["x"], { replaceable: true }),
        extension("b", ["x"], { replaceable: true }),
      ]),
    ).toThrow(/"x" is registered by both/);
    expect(() => resolveExtensions(coreExtensions(), [extension("memory", [])])).not.toThrow();
    expect(() =>
      resolveExtensions(coreExtensions(), [...BUILT_IN_EXTENSIONS, extension("memory", [])]),
    ).toThrow(/"memory" is used twice/);
  });

  it("refuses an untrusted tool the extension doesn't register, and keeps a replaced one's untrusted", () => {
    expect(() =>
      resolveExtensions(coreExtensions(), [
        extension("f", ["web_fetch"], { untrustedTools: ["web-fetch"] }),
      ]),
    ).toThrow(/declares "web-fetch" untrusted but registers no such tool/);
    const resolved = resolveExtensions(coreExtensions(), [
      ...BUILT_IN_EXTENSIONS,
      extension("my-fetch", ["web_fetch"]),
    ]);
    // Pages the replaced built-in fetched are still in the stored entries.
    expect([...resolved.untrustedTools]).toEqual(["web_fetch"]);
  });

  it("refuses a replacement that reuses the replaced extension's task name", () => {
    const clash: MipiExtension = {
      ...extension("my-schedule", ["schedule"]),
      pi: defineExtension({
        name: "my-schedule",
        tools: [tool("schedule")],
        tasks: [ScheduledReminder],
      }),
    };
    expect(() => composeMipi({ extensions: [...BUILT_IN_EXTENSIONS, clash] })).toThrow(
      /app\.reminder/,
    );
  });
});

describe("input origin", () => {
  it("reads the door from the request id, a person's input before an automated one", () => {
    const { originOf } = composeMipi().connectors.origins;
    expect(originOf("web:abc")).toEqual({ source: "web", automated: false });
    expect(originOf("tg:42")).toEqual({ source: "telegram", automated: false });
    expect(originOf("tg:batch:42")).toEqual({ source: "telegram", automated: false });
    expect(originOf("relay:key")).toEqual({ source: "relay", automated: false });
    expect(originOf("sched:r1:0")).toEqual({ source: "reminder", automated: true });
    expect(originOf(undefined)).toBe(UNKNOWN_ORIGIN);
    expect(originOf("nope")).toBe(UNKNOWN_ORIGIN);
    expect(originOf("other:1")).toBe(UNKNOWN_ORIGIN);
    // Nothing inherited from Object counts as a prefix.
    for (const id of ["toString:1", "constructor:1", "__proto__:1", "hasOwnProperty:1"]) {
      expect(originOf(id), id).toBe(UNKNOWN_ORIGIN);
    }
  });

  it("registers bot origin in core and door and reminder origins from their registrations", () => {
    expect(createConnectors([], []).origins.prefixes()).toEqual(["bot"]);
    // Bare core still has the doors, but no reminders: `sched:` means nothing there.
    const bare = composeMipi({ extensions: [] }).connectors.origins;
    expect(bare.prefixes()).toEqual(["web", "tg", "relay", "bot"]);
    expect(bare.originOf("sched:r1:0")).toBe(UNKNOWN_ORIGIN);
    expect(composeMipi({ extensions: [], doors: [] }).connectors.origins.prefixes()).toEqual([
      "bot",
    ]);
    expect(
      () =>
        new Origins([
          { prefix: "tg", source: "a", automated: false },
          { prefix: "tg", source: "b", automated: false },
        ]),
    ).toThrow(/twice/);
    expect(() => new Origins([{ prefix: "t:g", source: "a", automated: false }])).toThrow(
      /letters/,
    );
  });

  it("reaches the agent's own connectors from its registry, per agent", () => {
    const full = composeMipi();
    const bare = composeMipi({ extensions: [] });
    expect(connectorsOf(full.options.registry.snapshot())).toBe(full.connectors);
    expect(connectorsOf(bare.options.registry.snapshot())).toBe(bare.connectors);
    expect(connectorsOf(full.options.registry.snapshot()).origins.prefixes()).toContain("sched");
  });

  it("keeps the stored reminder destination as a delivery destination", () => {
    const stored: ReminderDestination[] = [
      { kind: "telegram", chatId: 42 },
      { kind: "web", conversationId: 1 },
    ];
    const destinations: DeliveryDestination[] = stored;
    expect(destinations.map(({ kind }) => kind)).toEqual(["telegram", "web"]);
  });

  it("finds untrusted tools from any registry the extensions are installed in", () => {
    const { options } = composeMipi();
    expect([...untrustedToolNames(options.registry.snapshot())]).toEqual(["web_fetch"]);
    // Bound per agent: a bare one declares none, and composing it leaves the other as it was.
    const bare = composeMipi({ extensions: [] });
    expect([...untrustedToolNames(bare.options.registry.snapshot())]).toEqual([]);
    expect([...untrustedToolNames(options.registry.snapshot())]).toEqual(["web_fetch"]);
  });
});

/** What one request offered the model, replayed from its system messages: the tool names and the prompt text. */
function offered(messages: readonly Message[]): { tools: string[]; prompt: string } {
  const tools = new Set<string>();
  const text: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const added of message.toolsAdded ?? []) tools.add(added.name);
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
    text.push(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    text.push(
      ...Object.entries(message.sections ?? {}).map(([name, body]) => `${name}\n${body ?? ""}`),
    );
  }
  return { tools: [...tools].sort(), prompt: text.join("\n") };
}

async function openRecording(replies: Array<string | (() => string)> = []) {
  const requests: Message[][] = [];
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 20 }, (_, index) => (context) => {
      requests.push(structuredClone(context.messages));
      const reply = replies[index];
      return fauxAssistantMessage([
        fauxText(typeof reply === "function" ? reply() : (reply ?? "ok")),
      ]);
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const composition = composeMipi({ models, model: { provider: "faux", modelId: "faux-1" } });
  const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
  const create = async () => {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      ctx,
    );
    return conversation;
  };
  return { harness, models, composition, requests, create };
}

describe("switching an extension off for one conversation", () => {
  it("removes its tools and section there only, and leaves every other prefix as it was", async () => {
    const { harness, composition, requests, create } = await openRecording();
    try {
      await harness.commit(
        async (tx) =>
          void addLesson(
            await tx.doc(MemoryDoc),
            "The owner drinks tea.",
            { source: "web", conversationId: 1 },
            1,
          ),
        ctx,
      );
      const before = await create();
      await (await before.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      const prefixBefore = offered(requests.at(-1)!);

      const off = await create();
      await harness.commit((tx) => composition.switchOff(tx, off.id, ["memory"]), ctx);
      await (await off.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      const offPrompt = offered(requests.at(-1)!);
      expect(offPrompt.tools).toEqual(["schedule", "search_history", "web_fetch"]);
      expect(offPrompt.prompt).not.toContain("The owner drinks tea.");

      const other = await create();
      await (await other.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      const otherPrompt = offered(requests.at(-1)!);
      expect(otherPrompt).toEqual(prefixBefore);
      expect(otherPrompt.prompt).toContain("The owner drinks tea.");
      expect(otherPrompt.tools).toEqual([
        "forget",
        "remember",
        "schedule",
        "search_history",
        "web_fetch",
      ]);

      // Switched back on: the default selection again.
      await harness.commit((tx) => composition.switchOff(tx, off.id, []), ctx);
      const again = (await off.agent(ctx)).tools.map(({ name }) => name).sort();
      expect(again).toEqual(otherPrompt.tools);
    } finally {
      await harness.close(ctx);
    }
  });

  it("can't switch off core's own extensions", async () => {
    const { harness, composition, create } = await openRecording();
    try {
      const conversation = await create();
      for (const name of ["chat", "proactive", "provider-limits", "conversation-search"]) {
        await expect(
          harness.commit((tx) => composition.switchOff(tx, conversation.id, [name]), ctx),
        ).rejects.toThrow(/can't be switched off/);
      }
    } finally {
      await harness.close(ctx);
    }
  });

  it("stays off through a profile change and the startup profile sync", async () => {
    const { harness, composition, create } = await openRecording();
    const { profiles } = composition;
    const toolsOf = async (id: Parameters<typeof harness.conversation>[0]) =>
      (await (await harness.conversation(id, ctx))!.agent(ctx)).tools
        .map(({ name }) => name)
        .sort();
    try {
      const conversation = await create();
      await harness.commit((tx) => composition.switchOff(tx, conversation.id, ["memory"]), ctx);
      await harness.commit((tx) => setProfile(tx, conversation.id, "empty", profiles), ctx);
      await harness.commit((tx) => setProfile(tx, conversation.id, "default", profiles), ctx);
      expect(await toolsOf(conversation.id)).toEqual(["schedule", "search_history", "web_fetch"]);

      // A boot after a profile change runs the sync over every conversation: it finds nothing to give back.
      await harness.commit(async (tx) => {
        delete (await tx.doc(AgentSettings)).profileTools;
      }, ctx);
      expect(await syncProfileTools(harness, profiles)).toEqual([]);
      expect(await toolsOf(conversation.id)).toEqual(["schedule", "search_history", "web_fetch"]);
    } finally {
      await harness.close(ctx);
    }
  });

  it("keeps the memory pass off that conversation", async () => {
    const { harness, models, composition, create } = await openRecording([
      "ok",
      "ok",
      JSON.stringify({ lessons: ["The owner likes juice."] }),
    ]);
    const clock = { now: Date.now() };
    const pass = new MemoryPassRuntime({
      harness,
      models,
      untrustedTools: composition.extensions.untrustedTools,
      onWakeChange: () => {},
      report: (message, error) => {
        throw new Error(`${message}: ${String(error)}`);
      },
      now: () => clock.now,
    });
    try {
      const off = await create();
      await harness.commit((tx) => composition.switchOff(tx, off.id, ["memory"]), ctx);
      await (
        await off.submit({ type: "input", content: "I like tea.", requestId: "web:1" }, ctx)
      ).wait(ctx);
      const on = await create();
      await (
        await on.submit({ type: "input", content: "I like juice.", requestId: "web:2" }, ctx)
      ).wait(ctx);
      clock.now = Date.now() + MEMORY_IDLE_MS + 1_000;

      expect(await pass.pass(off.id)).toBe(false);
      expect(await pass.pass(on.id)).toBe(true);
      const lessons = (await harness.snapshot(MemoryDoc, ctx))?.lessons ?? [];
      expect(lessons.map(({ text }) => text)).toEqual(["The owner likes juice."]);
    } finally {
      pass.close();
      await harness.close(ctx);
    }
  });
});

describe("a replacement in a running agent", () => {
  it("runs the replacement's tool while the replaced built-in stays installed", async () => {
    let calls = 0;
    const replacement: MipiExtension = {
      name: "my-fetch",
      tier: "optional",
      pi: defineExtension({
        name: "my-fetch",
        tools: [
          {
            ...tool("web_fetch"),
            execute: async () => {
              calls += 1;
              return { output: [{ type: "text", text: "from my-fetch" }] };
            },
          },
        ],
      }),
    };
    const seen: string[] = [];
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("web_fetch", { text: "https://example.com" })], {
        stopReason: "toolUse",
      }),
      (context) => {
        for (const message of context.messages) {
          if (message.role !== "toolResult") continue;
          for (const part of message.content) if (part.type === "text") seen.push(part.text);
        }
        return fauxAssistantMessage([fauxText("Done.")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const composition = composeMipi({
      extensions: [...BUILT_IN_EXTENSIONS, replacement],
      models,
      model: { provider: "faux", modelId: "faux-1" },
    });
    expect(composition.extensions.replacements).toEqual([
      { replaced: "web-fetch", by: "my-fetch", tool: "web_fetch" },
    ]);
    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      expect(composition.options.registry.snapshot().extension("web-fetch")).toBeDefined();
      const conversation = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        ctx,
      );
      await (await conversation.submit({ type: "input", content: "fetch it" }, ctx)).wait(ctx);
      expect(calls).toBe(1);
      expect(seen.join("\n")).toContain("from my-fetch");
      const agent = await conversation.agent(ctx);
      expect(agent.extensions.map(({ name }) => name)).not.toContain("web-fetch");
      expect(agent.tools.map(({ name }) => name)).toContain("web_fetch");
    } finally {
      await harness.close(ctx);
    }
  });
});

describe("the startup profile sync with an extension switched off", () => {
  it("gives a stale conversation its tools back, and keeps the switched-off extension off", async () => {
    const { harness, composition, create } = await openRecording();
    const { profiles } = composition;
    try {
      const conversation = await create();
      await harness.commit(async (tx) => {
        await composition.switchOff(tx, conversation.id, ["memory"]);
        // As an older build might leave it: no tools at all.
        await configure(tx, conversation.id, { tools: [] });
      }, ctx);
      await harness.commit(async (tx) => {
        delete (await tx.doc(AgentSettings)).profileTools;
      }, ctx);
      expect(await syncProfileTools(harness, profiles)).toEqual([conversation.id]);
      const agent = await (await harness.conversation(conversation.id, ctx))!.agent(ctx);
      expect(agent.tools.map(({ name }) => name).sort()).toEqual([
        "schedule",
        "search_history",
        "web_fetch",
      ]);
      expect(agent.extensions.map(({ name }) => name)).not.toContain("memory");
      // And it doesn't keep rewriting: the next run finds it as expected.
      await harness.commit(async (tx) => {
        delete (await tx.doc(AgentSettings)).profileTools;
      }, ctx);
      expect(await syncProfileTools(harness, profiles)).toEqual([]);
    } finally {
      await harness.close(ctx);
    }
  });
});
