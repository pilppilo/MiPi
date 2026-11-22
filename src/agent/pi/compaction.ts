// Adapted from pi-pocket src/server/compaction.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
import type { Model } from "@earendil-works/pi-ai";
import { type CompactionSettings, DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

/** What `summaryReserve` reads of a model. */
export type ReserveModel = Pick<Model<never>, "provider" | "id" | "contextWindow" | "maxTokens">;

/**
 * The most free context kept by default. Pi Durable's summary budget is then 26,214 tokens: room for a long
 * conversation's summary without compacting much earlier than before.
 */
export const RESERVE_LIMIT = 32_768;

/**
 * The free context kept for a model. Pi Durable writes a summary in at most 80% of it (`maxTokens = 0.8 ×
 * reserveTokens`), and that budget holds the model's thinking as well as the summary. Its default, 16,384, gives
 * 13,107 tokens, and a long conversation's summary grows past that: each one folds in the one before, so a
 * conversation whose summary hits the limit can no longer compact, and every run after fails. MiPi's Telegram
 * conversation is exactly that kind of long-lived conversation. This keeps room for all the output the model can
 * write, up to `RESERVE_LIMIT` and a quarter of its context window, and never less than Pi Durable's default.
 */
// pi-ledger L4: larger reserve than Pi Durable's default.
export function summaryReserve(model: ReserveModel): number {
  const fallback = DEFAULT_COMPACTION_POLICY.reserveTokens;
  const output = model.maxTokens > 0 ? Math.ceil(model.maxTokens / 0.8) : RESERVE_LIMIT;
  const quarter = model.contextWindow > 0 ? Math.floor(model.contextWindow / 4) : fallback;

  return Math.max(fallback, Math.min(output, RESERVE_LIMIT, quarter));
}

/** Harness compaction settings that give every listed model room for its summary, keyed `provider/modelId`. */
export function compactionSettings(models: readonly ReserveModel[]): CompactionSettings {
  return {
    modelOverrides: Object.fromEntries(
      models.map((model) => [
        `${model.provider}/${model.id}`,
        { reserveTokens: summaryReserve(model) },
      ]),
    ),
  };
}
