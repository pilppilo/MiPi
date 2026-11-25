import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, Harness, type Storage } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { botNameRefusal, createBot, ensureBots, MAIN_BOT_NAME } from "../src/agent/bots.ts";
import {
  Bots,
  boundConversation,
  ChannelBindings,
  ConversationMeta,
  profileRefusal,
} from "../src/agent/conversations.ts";
import { createHarnessOptions } from "../src/agent/composition.ts";
import { PROFILE_TABLE } from "../src/extensions/profiles.ts";
import { PROFILES } from "./mipi.ts";

const ctx = BACKGROUND_CONTEXT;
const NOW = Date.UTC(2026, 10, 25, 12);

async function open(storage: Storage = new MemoryStorage()): Promise<Harness> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return Harness.open(
    storage,
    createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
    ctx,
  );
}

const meta = (harness: Harness, id: number) =>
  harness.snapshot(ConversationMeta, id as ConversationId, ctx);

const bound = (harness: Harness, key: string) =>
  harness.commit((tx) => boundConversation(tx, key, "default", PROFILES), ctx);

describe("the main bot (COD-197)", () => {
  it("makes MiPi on main once, and never again", async () => {
    const harness = await open();
    try {
      expect(await ensureBots(harness, PROFILES, NOW)).toBe(true);
      const bots = (await harness.snapshot(Bots, ctx))!;
      expect(bots.madeAt).toBe(NOW);
      expect(await meta(harness, bots.mainId!)).toEqual({
        kind: "main",
        name: MAIN_BOT_NAME,
        profile: "main",
        createdBy: "owner",
      });
      // The only bot: the relay reaches MiPi too, until the owner points it at a bot of its own (COD-199).
      expect(bots.names).toEqual({ mipi: bots.mainId });

      // MiPi has its profile's tools and no instructions: its prompt is the one MiPi had before bots.
      const mipi = await (await harness.conversation(bots.mainId! as ConversationId, ctx))!.agent(
        ctx,
      );
      expect(mipi.tools.map(({ name }) => name)).toEqual([...PROFILE_TABLE.main.tools]);
      expect(mipi.instructions).toBeUndefined();

      // A later start finds it and makes nothing.
      expect(await ensureBots(harness, PROFILES, NOW + 1)).toBe(false);
      expect(await harness.snapshot(Bots, ctx)).toEqual(bots);
    } finally {
      await harness.close(ctx);
    }
  });

  it("archives every chat from before bots in the same commit, and never a bot", async () => {
    const harness = await open();
    try {
      const older = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      const titled = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      await harness.commit(async (tx) => {
        (await tx.doc(ConversationMeta, titled.id)).title = "Plan the week";
      }, ctx);
      await ensureBots(harness, PROFILES, NOW);
      expect((await meta(harness, older.id))?.archivedAt).toBe(NOW);
      expect(await meta(harness, titled.id)).toMatchObject({
        title: "Plan the week",
        archivedAt: NOW,
      });
      const { mainId } = (await harness.snapshot(Bots, ctx))!;
      expect((await meta(harness, mainId!))?.archivedAt).toBeUndefined();
    } finally {
      await harness.close(ctx);
    }
  });

  it("moves each door's older binding to its bot on first read, and keeps a binding chosen since", async () => {
    const harness = await open();
    try {
      // As 0.1.0 left them: every door on the one chat.
      const chat = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      await harness.commit(async (tx) => {
        for (const key of ["web", "tg:4242", "relay:pidu"]) {
          (await tx.doc(ChannelBindings, key, null)).conversationId = chat.id;
        }
      }, ctx);
      // Before MiPi exists, a binding reads as it was.
      expect(await bound(harness, "tg:4242")).toBe(chat.id);

      await ensureBots(harness, PROFILES, NOW);
      const { mainId } = (await harness.snapshot(Bots, ctx))!;
      // Every door, the relay's too, reaches MiPi.
      expect(await bound(harness, "web")).toBe(mainId);
      expect(await bound(harness, "tg:4242")).toBe(mainId);
      expect(await bound(harness, "relay:pidu")).toBe(mainId);
      // A chat that never wrote before reaches MiPi too.
      expect(await bound(harness, "tg:777")).toBe(mainId);
      for (const key of ["web", "tg:4242", "relay:pidu", "tg:777"]) {
        expect(await harness.snapshot(ChannelBindings, key, ctx)).toMatchObject({ bots: true });
      }

      // A binding written since bots (as `/bot <name>` will) stays where it is, across a restart.
      const groceries = await harness.commit(
        (tx) =>
          createBot(
            tx,
            {
              kind: "bot",
              name: "Groceries",
              purpose: "Keep the shopping list.",
              profile: "default",
              createdBy: "owner",
            },
            PROFILES,
          ),
        ctx,
      );
      await harness.commit(async (tx) => {
        const binding = await tx.doc(ChannelBindings, "tg:4242", null);
        binding.conversationId = groceries;
        binding.bots = true;
      }, ctx);
      expect(await ensureBots(harness, PROFILES, NOW + 1)).toBe(false);
      expect(await bound(harness, "tg:4242")).toBe(groceries);
      // A purpose bot's purpose is its instructions.
      const agent = await (await harness.conversation(groceries, ctx))!.agent(ctx);
      expect(agent.instructions).toBe("Keep the shopping list.");
    } finally {
      await harness.close(ctx);
    }
  });

  it("fails clearly when a bound bot is gone, rather than start another chat", async () => {
    const harness = await open();
    try {
      await harness.commit(async (tx) => {
        (await tx.doc(Bots)).mainId = 999_999;
      }, ctx);
      await expect(bound(harness, "web")).rejects.toThrow("Conversation 999999 for web is missing");
    } finally {
      await harness.close(ctx);
    }
  });

  it("keeps main for MiPi alone, and pidu for the relay's chats from before bots", () => {
    expect(profileRefusal({ kind: "main", profile: "main" }, "main")).toBeUndefined();
    expect(profileRefusal({ kind: "main" }, "main")).toBeUndefined();
    expect(profileRefusal({ kind: "main", profile: "main" }, "default")).toBe(
      "MiPi always runs on the main profile.",
    );
    expect(profileRefusal({ kind: "bot" }, "main")).toBe("Only MiPi runs on the main profile.");
    expect(profileRefusal({}, "main")).toBe("Only MiPi runs on the main profile.");
    expect(profileRefusal({}, "empty")).toBeUndefined();
    // An older relay chat keeps `pidu` (the startup sync applies it again); nothing newly takes it.
    expect(profileRefusal({ profile: "pidu" }, "pidu")).toBeUndefined();
    expect(profileRefusal({ profile: "default" }, "pidu")).toBe(
      "pidu is kept for the relay's chats from before bots. Pick one of: default, empty.",
    );
    expect(profileRefusal({ kind: "bot" }, "pidu")).toBeDefined();
  });

  it("names bots uniquely, ignoring case, in 1 to 40 characters", () => {
    const bots = { names: { mipi: 1, groceries: 2 } };
    expect(botNameRefusal(bots, "PiDu")).toBeUndefined();
    expect(botNameRefusal(bots, "  mipi ")).toBe("There is already a bot named mipi.");
    expect(botNameRefusal(bots, "GROCERIES", 2)).toBeUndefined();
    expect(botNameRefusal(bots, "   ")).toBe("A bot needs a name.");
    expect(botNameRefusal(bots, "x".repeat(40))).toBeUndefined();
    expect(botNameRefusal(bots, "x".repeat(41))).toBe("A bot's name is at most 40 characters.");
  });
});
