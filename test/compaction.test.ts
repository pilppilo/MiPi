// Adapted from pi-pocket test/compaction-budget.test.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createHarnessOptions } from "../src/agent/harness.ts";
import { compactionSettings, summaryReserve } from "../src/agent/pi/compaction.ts";
import { DEFAULT_MODEL_ID, goModels, MODEL_PROVIDER } from "../src/agent/pi/models.ts";

const model = (id: string, contextWindow: number, maxTokens: number) => ({
  provider: "test",
  id,
  contextWindow,
  maxTokens,
});

describe("summary reserve", () => {
  it("keeps room for each model's summary, within a quarter of its window and 32,768", () => {
    // Pi Pocket's session that could no longer compact: 13,107 tokens was too few, 26,214 is enough.
    expect(summaryReserve(model("claude-opus-5-5", 200_000, 32_768))).toBe(32_768);
    expect(summaryReserve(model("claude-sonnet-4", 128_000, 16_384))).toBe(20_480);
    expect(summaryReserve(model("gpt-6-sol", 272_000, 128_000))).toBe(32_768);
    // A small window keeps most of itself for the conversation, and never less than Pi Durable's default.
    expect(summaryReserve(model("small", 80_000, 32_768))).toBe(20_000);
    expect(summaryReserve(model("tiny", 32_000, 8_192))).toBe(
      DEFAULT_COMPACTION_POLICY.reserveTokens,
    );
    expect(summaryReserve(model("unknown", 0, 0))).toBe(DEFAULT_COMPACTION_POLICY.reserveTokens);
  });

  it("gives MiPi's default model the 32,768 cap", () => {
    const deepseek = goModels().find(({ id }) => id === DEFAULT_MODEL_ID);
    expect(deepseek).toMatchObject({ provider: MODEL_PROVIDER, contextWindow: 1_000_000 });
    expect(summaryReserve(deepseek!)).toBe(32_768);
  });

  it("keys the overrides by provider/modelId and applies them to the harness", () => {
    expect(compactionSettings([model("a", 200_000, 32_768)])).toEqual({
      modelOverrides: { "test/a": { reserveTokens: 32_768 } },
    });

    const options = createHarnessOptions().settings;
    const harnessSettings = typeof options === "function" ? options() : options;
    const harness = harnessSettings?.compaction?.modelOverrides;
    expect(harness?.[`${MODEL_PROVIDER}/${DEFAULT_MODEL_ID}`]).toEqual({ reserveTokens: 32_768 });
    expect(Object.keys(harness ?? {})).toHaveLength(goModels().length);
  });
});
