/**
 * The providers connector (COD-212): what a model provider adds beyond Pi's provider wiring (`pi/models.ts`), as
 * extensions register it. The pieces are optional per provider:
 *
 * - its own usage figures (M9), beside MiPi's own estimate. MiPi's estimate (`spend.ts`) works for every provider; a
 *   provider's figures show only where an extension can read them, with a key that has usage permission. A provider
 *   with no reader, or no key, shows nothing here, and the estimate stands alone. Reads are outside lookups: each is
 *   cached for five minutes, a failure too, and never stored.
 * - its live model list: which of the models pi-ai knows it serves now (`model-list.ts`).
 *
 * Core code: it names no provider. A provider's URLs, key names and response shapes live in its optional extension.
 */
import type { ProviderUsage } from "../protocol.ts";
import type { ReadEnv } from "./pi/models.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One provider's usage reader. */
export interface UsageSource {
  /** pi-ai's provider id, as in a model ref. */
  readonly provider: string;
  /** How the readout names it. */
  readonly label: string;
  read(fetcher: FetchLike): Promise<ProviderUsage>;
}

/** One provider's model list. */
export interface ModelListSource {
  /** pi-ai's provider id, as in a model ref. */
  readonly provider: string;
  /** How a failure names it. */
  readonly label: string;
  /** The models pi-ai knows for it (compat flags, prices): only these can be picked safely. */
  catalog(): readonly { readonly id: string; readonly name: string }[];
  /** The ids it serves now. Throws with a short reason when the list can't be read. */
  liveIds(fetcher: FetchLike): Promise<string[]>;
}

/**
 * What an extension registers for one provider. `provider` is static, so two registrations of the same piece are
 * caught when the agent composes, before any setting is read. The pieces are built from the settings when the agent
 * opens: `usage` returns undefined when there is no key to read with.
 */
export type LimitParser = {
  readonly label: string;
  readonly parse: (text: string, now: number) => { resetAt?: number } | undefined;
};

export interface ProviderRegistration {
  /** pi-ai's provider id; the pieces it builds must name the same. */
  readonly provider: string;
  readonly usage?: (readEnv: ReadEnv) => UsageSource | undefined;
  readonly models?: (readEnv: ReadEnv) => ModelListSource;
  readonly limit?: LimitParser;
}

/** The registered providers, as the agent composed them. */
export interface Providers {
  readonly limitParsers: readonly (LimitParser & { readonly provider: string })[];
  /** Every provider with a usage reader and a key for it, in default extension order (slot, then name). */
  usageSources(readEnv: ReadEnv): UsageSource[];
  /** Every provider with a model list, in default extension order (slot, then name). */
  modelSources(readEnv: ReadEnv): ModelListSource[];
}

/**
 * Collects the registrations of the extensions in use. One provider's usage reader or model list registered twice is
 * a wiring mistake and throws, so the agent refuses to open. Pi's replacement rule doesn't apply: no tool is involved.
 */
export function createProviders(
  registrations: readonly { readonly owner: string; readonly registration: ProviderRegistration }[],
): Providers {
  const claimed = new Map<string, string>();
  const claim = (
    owner: string,
    provider: string,
    piece: "usage reader" | "model list" | "limit parser",
  ) => {
    const key = `${provider}/${piece}`;
    const other = claimed.get(key);
    if (other !== undefined) {
      throw new Error(
        `Provider "${provider}"'s ${piece} is registered by both "${other}" and "${owner}"`,
      );
    }
    claimed.set(key, owner);
  };
  const limitParsers: Array<LimitParser & { provider: string }> = [];
  for (const { owner, registration } of registrations) {
    if (registration.limit !== undefined) {
      claim(owner, registration.provider, "limit parser");
      limitParsers.push({ ...registration.limit, provider: registration.provider });
    }
    if (registration.usage !== undefined) claim(owner, registration.provider, "usage reader");
    if (registration.models !== undefined) claim(owner, registration.provider, "model list");
  }
  const built = <T extends { readonly provider: string }>(
    registration: ProviderRegistration,
    piece: T | undefined,
  ): T[] => {
    if (piece === undefined) return [];
    if (piece.provider !== registration.provider) {
      throw new Error(
        `A piece registered for provider "${registration.provider}" names "${piece.provider}"`,
      );
    }
    return [piece];
  };
  return {
    limitParsers,
    usageSources: (readEnv) =>
      registrations.flatMap(({ registration }) =>
        built(registration, registration.usage?.(readEnv)),
      ),
    modelSources: (readEnv) =>
      registrations.flatMap(({ registration }) =>
        built(registration, registration.models?.(readEnv)),
      ),
  };
}

export const USAGE_CACHE_MS = 5 * 60_000;

// ---- The cache ----

/** Each source read at most every five minutes; a failed read is kept as "unavailable" for as long. */
export class ProviderUsageCache {
  readonly #sources: readonly UsageSource[];
  readonly #fetcher: FetchLike;
  readonly #cached = new Map<string, { readonly at: number; readonly usage: ProviderUsage }>();
  /** Reads in flight, by provider: callers at the same moment share one. */
  readonly #reading = new Map<string, Promise<ProviderUsage>>();

  constructor(sources: readonly UsageSource[], fetcher: FetchLike = fetch) {
    this.#sources = sources;
    this.#fetcher = fetcher;
  }

  /** What was read last, at most five minutes ago, without reading again: for callers that mustn't wait on a provider. */
  cached(now: number = Date.now()): ProviderUsage[] {
    return this.#sources.flatMap((source) => {
      const cached = this.#cached.get(source.provider);
      return cached !== undefined && now - cached.at < USAGE_CACHE_MS ? [cached.usage] : [];
    });
  }

  read(now: number = Date.now()): Promise<ProviderUsage[]> {
    return Promise.all(
      this.#sources.map((source) => {
        const cached = this.#cached.get(source.provider);
        if (cached !== undefined && now - cached.at < USAGE_CACHE_MS) return cached.usage;
        return this.#read(source, now);
      }),
    );
  }

  readFresh(provider: string, now: number = Date.now()): Promise<ProviderUsage | undefined> {
    const source = this.#sources.find((candidate) => candidate.provider === provider);
    return source === undefined ? Promise.resolve(undefined) : this.#read(source, now);
  }

  #read(source: UsageSource, now: number): Promise<ProviderUsage> {
    const reading = this.#reading.get(source.provider);
    if (reading !== undefined) return reading;
    const read = (async (): Promise<ProviderUsage> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let usage: ProviderUsage;
      try {
        usage = await Promise.race([
          source.read(this.#fetcher),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Usage read timed out")), 5_000);
          }),
        ]);
      } catch (error) {
        usage = {
          provider: source.provider,
          label: source.label,
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
      this.#cached.set(source.provider, { at: now, usage });
      return usage;
    })().finally(() => this.#reading.delete(source.provider));
    this.#reading.set(source.provider, read);
    return read;
  }
}
