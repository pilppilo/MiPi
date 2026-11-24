/**
 * The models a conversation may switch to: for each provider with a model list (`providers.ts`), those in both its live
 * list and pi-ai's catalog. A model only in the live list has no compat flags or prices in pi-ai yet, so it can't be
 * used safely until a pi-ai bump adds it; one only in the catalog is no longer served. Every door (the web picker,
 * Telegram's `/model`) uses this.
 *
 * Core code: it names no provider.
 */
import type { FetchLike, ModelListSource } from "./providers.ts";

export interface ModelChoice {
  readonly id: string;
  readonly name: string;
}

const CACHE_MS = 10 * 60_000;

/** `source`'s catalog narrowed to the ids `live` lists, in catalog order. */
export function pickableModels(source: ModelListSource, live: Iterable<string>): ModelChoice[] {
  const served = new Set(live);
  return source
    .catalog()
    .filter((model) => served.has(model.id))
    .map((model) => ({ id: model.id, name: model.name }));
}

type Listed = { readonly provider: string; readonly model: ModelChoice };

/** The pickable models of every source, in source order, fetched at most every 10 minutes. A failed fetch is not cached. */
export class ModelList {
  #cached: { readonly at: number; readonly listed: readonly Listed[] } | undefined;
  readonly #sources: readonly ModelListSource[];
  readonly #fetcher: FetchLike;

  constructor(sources: readonly ModelListSource[], fetcher: FetchLike = fetch) {
    this.#sources = sources;
    this.#fetcher = fetcher;
  }

  async #listed(now: number): Promise<readonly Listed[]> {
    if (this.#cached !== undefined && now - this.#cached.at < CACHE_MS) return this.#cached.listed;
    const perSource = await Promise.all(
      this.#sources.map(async (source) =>
        pickableModels(source, await source.liveIds(this.#fetcher)).map((model) => ({
          provider: source.provider,
          model,
        })),
      ),
    );
    const listed = perSource.flat();
    this.#cached = { at: now, listed };
    return listed;
  }

  async models(now: number = Date.now()): Promise<readonly ModelChoice[]> {
    return (await this.#listed(now)).map(({ model }) => model);
  }

  /**
   * The model ref for `id`, from the first source that lists it, or a clear error when none does. An id two providers
   * both serve goes to the first; that needs a decision once there is a second provider.
   */
  async require(id: string): Promise<{ provider: string; modelId: string }> {
    if (this.#sources.length === 0) throw new Error("No provider lists models in this build.");
    const listed = await this.#listed(Date.now());
    const found = listed.find(({ model }) => model.id === id);
    if (found === undefined) {
      throw new Error(
        `${id} is not available: pick one of ${listed.map(({ model }) => model.id).join(", ") || "(none)"}`,
      );
    }
    return { provider: found.provider, modelId: id };
  }
}
