/**
 * The models a conversation may switch to: those in both OpenCode Go's live list and pi-ai's Go catalog. A model only
 * in the live list has no compat flags or prices in pi-ai yet, so it can't be used safely until a pi-ai bump adds it;
 * one only in the catalog is no longer served. Every door (the web picker now, Telegram's `/model` later) uses this.
 */
import { goModels, MODEL_PROVIDER } from "./pi/models.ts";

export interface ModelChoice {
  readonly id: string;
  readonly name: string;
}

/** OpenCode Go's model list (OpenAI-shaped: `{ data: [{ id }] }`). */
export const GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
const CACHE_MS = 10 * 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The ids OpenCode Go serves now. Throws with a short reason when the list can't be read. */
export async function fetchLiveGoModelIds(
  apiKey: string | undefined,
  fetcher: FetchLike = fetch,
): Promise<string[]> {
  const response = await fetcher(GO_MODELS_URL, {
    headers: apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenCode Go's model list answered ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data))
    throw new Error("OpenCode Go's model list has an unexpected shape");
  return body.data.flatMap((item: unknown) =>
    typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
      ? [(item as { id: string }).id]
      : [],
  );
}

/** pi-ai's Go catalog narrowed to the ids `live` lists, in catalog order. */
export function pickableModels(live: Iterable<string>): ModelChoice[] {
  const served = new Set(live);
  return goModels()
    .filter((model) => served.has(model.id))
    .map((model) => ({ id: model.id, name: model.name }));
}

/** The pickable models, fetched at most every 10 minutes. A failed fetch is not cached. */
export class ModelList {
  #cached: { readonly at: number; readonly models: readonly ModelChoice[] } | undefined;
  readonly #load: () => Promise<string[]>;

  constructor(load: () => Promise<string[]>) {
    this.#load = load;
  }

  async models(now: number = Date.now()): Promise<readonly ModelChoice[]> {
    if (this.#cached !== undefined && now - this.#cached.at < CACHE_MS) return this.#cached.models;
    const models = pickableModels(await this.#load());
    this.#cached = { at: now, models };
    return models;
  }

  /** The model ref for `id`, or a clear error when it isn't one of the pickable models. */
  async require(id: string): Promise<{ provider: string; modelId: string }> {
    const models = await this.models();
    if (!models.some((model) => model.id === id)) {
      throw new Error(
        `${id} is not available: pick one of ${models.map((model) => model.id).join(", ") || "(none)"}`,
      );
    }
    return { provider: MODEL_PROVIDER, modelId: id };
  }
}
