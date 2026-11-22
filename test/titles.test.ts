import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Harness, UsageDoc } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { ConversationMeta } from "../src/agent/conversations.ts";
import { createHarnessOptions } from "../src/agent/harness.ts";
import { nameFromFirstMessage, writeTitle } from "../src/agent/titles.ts";
import { cleanTitle, firstTitle, wantsTitle } from "../src/lib/titles.ts";

const ctx = BACKGROUND_CONTEXT;

describe("title text", () => {
  it("keeps short first messages as the title and asks for long ones", () => {
    expect(wantsTitle("Plan the week")).toBe(false);
    expect(wantsTitle("one two three four five six seven eight nine")).toBe(true);
    expect(wantsTitle("Two\nlines")).toBe(true);
    expect(firstTitle("  Plan the week\nwith details ")).toBe("Plan the week");
    expect(firstTitle("x".repeat(80))).toHaveLength(60);
  });

  it("cleans a model's reply into a title, or rejects it", () => {
    expect(cleanTitle('"Weekly Grocery Plan."')).toBe("Weekly Grocery Plan");
    expect(cleanTitle("Title: Trip to Austin")).toBe("Trip to Austin");
    expect(cleanTitle("<think>The user wants…</think>\nBudget Review")).toBe("Budget Review");
    expect(
      cleanTitle(
        "I think the user is asking about a lot of things here and I should consider each of them",
      ),
    ).toBe(undefined);
    expect(cleanTitle("   ")).toBe(undefined);
  });
});

async function openWithReply(reply: string, stopReason?: "length") {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxText(reply)], stopReason === undefined ? {} : { stopReason }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
    ctx,
  );
  return { harness, models };
}

const long = "Can you help me plan a three day trip to Austin with food and music";

describe("conversation titles", () => {
  it("names a conversation at once, then takes its own model's title and counts the cost", async () => {
    const { harness, models } = await openWithReply("Austin Food and Music Trip");
    try {
      const root = await harness.root(ctx);
      const provisional = await harness.commit(
        (tx) => nameFromFirstMessage(tx, root.id, long),
        ctx,
      );
      expect(provisional).toBe(firstTitle(long));
      // A second message never renames it.
      expect(await harness.commit((tx) => nameFromFirstMessage(tx, root.id, "again"), ctx)).toBe(
        undefined,
      );

      expect(await writeTitle(harness, models, root.id, long, provisional!)).toBe(true);
      expect((await harness.snapshot(ConversationMeta, root.id, ctx))?.title).toBe(
        "Austin Food and Music Trip",
      );
      expect(Object.keys((await harness.snapshot(UsageDoc, root.id, ctx))?.models ?? {})).toEqual([
        "faux/faux-1",
      ]);
    } finally {
      await harness.close(ctx);
    }
  });

  it("keeps the first title when the reply is cut off or the title changed meanwhile", async () => {
    const { harness, models } = await openWithReply("Austin Trip", "length");
    try {
      const root = await harness.root(ctx);
      const provisional = (await harness.commit(
        (tx) => nameFromFirstMessage(tx, root.id, long),
        ctx,
      ))!;
      expect(await writeTitle(harness, models, root.id, long, provisional)).toBe(false);
      expect((await harness.snapshot(ConversationMeta, root.id, ctx))?.title).toBe(provisional);
    } finally {
      await harness.close(ctx);
    }
  });

  it("asks nothing for a short first message", async () => {
    const { harness } = await openWithReply("unused");
    try {
      const root = await harness.root(ctx);
      expect(
        await harness.commit((tx) => nameFromFirstMessage(tx, root.id, "Plan the week"), ctx),
      ).toBe(undefined);
      expect((await harness.snapshot(ConversationMeta, root.id, ctx))?.title).toBe("Plan the week");
    } finally {
      await harness.close(ctx);
    }
  });
});
