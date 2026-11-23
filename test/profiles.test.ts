import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { configure, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import {
  boundConversation,
  ConversationMeta,
  profileOf,
  setProfile,
  startingProfile,
  syncProfileTools,
} from "../src/agent/conversations.ts";
import { createHarnessOptions } from "../src/agent/harness.ts";
import { PROFILE_NAMES, PROFILES, type ProfileName } from "../src/agent/profiles.ts";

const ctx = BACKGROUND_CONTEXT;

/** What one request offered the model, replayed from its system messages: the tool names and the prompt text. */
function offered(messages: readonly Message[]): { tools: string[]; prompt: string } {
  const tools = new Set<string>();
  const text: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    text.push(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    text.push(
      ...Object.entries(message.sections ?? {}).map(([name, body]) => `${name}\n${body ?? ""}`),
    );
  }
  return { tools: [...tools].sort(), prompt: text.join("\n") };
}

async function openRecording(profile?: ProfileName) {
  const requests: Message[][] = [];
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 10 }, () => (context) => {
      requests.push(structuredClone(context.messages));
      return fauxAssistantMessage([fauxText("ok")]);
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" }, profile }),
    ctx,
  );
  return { harness, requests };
}

describe("tool profiles", () => {
  it.each(PROFILE_NAMES)("offers a %s conversation exactly its profile's tools", async (name) => {
    const { harness, requests } = await openRecording();
    try {
      const conversation = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        ctx,
      );
      await harness.commit((tx) => setProfile(tx, conversation.id, name), ctx);
      await (await conversation.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);

      const { tools, prompt } = offered(requests.at(-1)!);
      expect(tools).toEqual([...PROFILES[name].tools].sort());
      // Pi Durable's optional extras never come in on their own.
      expect(tools).not.toEqual(expect.arrayContaining(["codemode"]));
      for (const builtIn of ["read", "write", "edit", "bash", "search_tools"]) {
        expect(tools).not.toContain(builtIn);
      }
      expect(prompt).not.toMatch(/codemode|searchTools|tool search/i);
      expect(profileOf(await harness.snapshot(ConversationMeta, conversation.id, ctx))).toBe(name);
    } finally {
      await harness.close(ctx);
    }
  });

  it("offers an empty conversation no tools", async () => {
    const { harness, requests } = await openRecording("empty");
    try {
      const root = await harness.root(ctx);
      await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      expect(offered(requests[0]!).tools).toEqual([]);
      expect(profileOf(await harness.snapshot(ConversationMeta, root.id, ctx))).toBe("empty");
    } finally {
      await harness.close(ctx);
    }
  });

  it("starts new conversations on the configured profile and switches from the next request", async () => {
    const { harness, requests } = await openRecording();
    try {
      const root = await harness.root(ctx);
      await (await root.submit({ type: "input", content: "one" }, ctx)).wait(ctx);
      expect(offered(requests[0]!).tools).toEqual(["schedule", "search_history"]);

      await harness.commit((tx) => setProfile(tx, root.id, "empty"), ctx);
      await (await root.submit({ type: "input", content: "two" }, ctx)).wait(ctx);
      expect(offered(requests[1]!).tools).toEqual([]);
    } finally {
      await harness.close(ctx);
    }
  });

  it("binds a channel key to one conversation on its starting profile", async () => {
    const { harness } = await openRecording();
    try {
      const relay = startingProfile("relay", "default");
      expect(relay).toBe("pidu");
      const first = await harness.commit((tx) => boundConversation(tx, "relay:pidu", relay), ctx);
      const again = await harness.commit((tx) => boundConversation(tx, "relay:pidu", relay), ctx);
      expect(again).toBe(first);
      expect(profileOf(await harness.snapshot(ConversationMeta, first, ctx))).toBe("pidu");

      const fresh = await harness.commit(
        (tx) => boundConversation(tx, "relay:pidu", relay, { rebind: true }),
        ctx,
      );
      expect(fresh).not.toBe(first);
      expect(await harness.commit((tx) => boundConversation(tx, "relay:pidu", relay), ctx)).toBe(
        fresh,
      );
    } finally {
      await harness.close(ctx);
    }
  });
});

describe("profile tools at startup", () => {
  it("gives a conversation older than profiles its profile's tools, keeps its model, and then writes nothing", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
      ctx,
    );
    try {
      // As an older build left it: named `default`, created with no tools, and a model of its own.
      const old = await harness.commit(async (tx) => {
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, id, { tools: [], model: { provider: "faux", modelId: "faux-2" } });
        (await tx.doc(ConversationMeta, id)).profile = "default";
        return id;
      }, ctx);
      // A plain chat stays plain: `empty` offers nothing, and nothing changes there.
      const plain = await harness.commit(async (tx) => {
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await setProfile(tx, id, "empty");
        return id;
      }, ctx);
      expect(await syncProfileTools(harness)).toEqual([old]);
      const agent = await (await harness.conversation(old, ctx))!.agent(ctx);
      expect(agent.tools.map(({ name }) => name).sort()).toEqual(["schedule", "search_history"]);
      expect(agent.model).toEqual({ provider: "faux", modelId: "faux-2" });
      expect((await (await harness.conversation(plain, ctx))!.agent(ctx)).tools).toEqual([]);
      expect(await syncProfileTools(harness)).toEqual([]);
    } finally {
      await harness.close(ctx);
    }
  });
});
