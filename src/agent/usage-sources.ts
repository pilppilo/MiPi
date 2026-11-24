/**
 * Each provider's own usage figures (M9), beside MiPi's own estimate. MiPi's estimate (`spend.ts`) works for every
 * provider; a provider's figures show only where MiPi can read them: one small reader per provider id, with a key that
 * has usage permission. A provider with no reader, or no key, shows nothing here, and the estimate stands alone.
 *
 * Reads are outside lookups: each is cached for five minutes, a failure too, and never stored.
 */
import type { ProviderUsage, UsageWindow } from "../protocol.ts";
import type { FetchLike } from "./model-list.ts";
import { MODEL_PROVIDER, type ReadEnv } from "./pi/models.ts";

/** One provider's usage reader. */
export interface UsageSource {
  /** pi-ai's provider id, as in a model ref. */
  readonly provider: string;
  /** How the readout names it. */
  readonly label: string;
  read(fetcher: FetchLike): Promise<ProviderUsage>;
}

export const USAGE_CACHE_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 5_000;

// ---- OpenCode Go ----

/**
 * OpenCode Go's allowance: `{ usage: { rolling, weekly, monthly } }`, each `{ status: "ok" | "rate-limited", percent,
 * resetsAt }` with `resetsAt` a date string. Shape and headers as OpenCode's own client reads them (sst/opencode
 * `packages/core/src/usage-limits.ts` `readGo` @ 84e357e).
 */
export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GO_WINDOWS = ["rolling", "weekly", "monthly"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Go's answer as windows. Throws with a short reason when it isn't the shape above. */
export function parseGoUsage(body: unknown): UsageWindow[] {
  const usage = isRecord(body) ? body.usage : undefined;
  if (!isRecord(usage)) throw new Error("OpenCode Go's usage has an unexpected shape");
  return GO_WINDOWS.map((name) => {
    const meter = usage[name];
    const resetsAt =
      isRecord(meter) && typeof meter.resetsAt === "string" ? Date.parse(meter.resetsAt) : NaN;
    if (
      !isRecord(meter) ||
      (meter.status !== "ok" && meter.status !== "rate-limited") ||
      typeof meter.percent !== "number" ||
      !Number.isFinite(meter.percent) ||
      !Number.isFinite(resetsAt)
    ) {
      throw new Error(`OpenCode Go's ${name} usage has an unexpected shape`);
    }
    return {
      name,
      percent: Math.min(100, Math.max(0, meter.percent)),
      limited: meter.status === "rate-limited",
      resetsAt,
    };
  });
}

/**
 * OpenCode Go's reader, with `OPENCODE_USAGE_KEY` when set (a key with usage permission), otherwise the model key.
 * `OPENCODE_ORG_ID`, when set, names the workspace, as OpenCode's own client does. No key: no reader.
 */
export function goUsageSource(readEnv: ReadEnv): UsageSource | undefined {
  // An empty secret counts as unset, and so does `off`: the deploy writes it when the Environment has no usage key,
  // since a deploy only adds secrets and would otherwise keep a removed one.
  const setting = (name: string) => {
    const value = readEnv(name)?.trim();
    return value === undefined || value === "" || value === "off" ? undefined : value;
  };
  const key = setting("OPENCODE_USAGE_KEY") ?? setting("OPENCODE_API_KEY");
  if (key === undefined) return undefined;
  const org = setting("OPENCODE_ORG_ID");
  const label = "OpenCode Go";
  const unavailable = (reason: string): ProviderUsage => ({
    provider: MODEL_PROVIDER,
    label,
    status: "unavailable",
    reason,
  });
  return {
    provider: MODEL_PROVIDER,
    label,
    read: async (fetcher) => {
      const response = await fetcher(GO_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(org === undefined ? {} : { "x-opencode-org-id": org }),
        },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Unread, so the connection is let go.
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401) return unavailable("the key has no usage permission");
        // OpenCode reads a 403 as a workspace with no Go plan: nothing to show, not a failure.
        if (response.status === 403) return unavailable("no Go plan for this key");
        return unavailable(`it answered ${response.status}`);
      }
      return {
        provider: MODEL_PROVIDER,
        label,
        status: "ok",
        windows: parseGoUsage(await response.json()),
      };
    },
  };
}

/** Every provider MiPi has a reader and a key for. */
export function usageSources(readEnv: ReadEnv): UsageSource[] {
  return [goUsageSource(readEnv)].flatMap((source) => (source === undefined ? [] : [source]));
}

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
      this.#sources.map(async (source) => {
        const cached = this.#cached.get(source.provider);
        if (cached !== undefined && now - cached.at < USAGE_CACHE_MS) return cached.usage;
        const reading = this.#reading.get(source.provider);
        if (reading !== undefined) return reading;
        const read = (async (): Promise<ProviderUsage> => {
          let usage: ProviderUsage;
          try {
            usage = await source.read(this.#fetcher);
          } catch (error) {
            usage = {
              provider: source.provider,
              label: source.label,
              status: "unavailable",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          this.#cached.set(source.provider, { at: now, usage });
          return usage;
        })().finally(() => this.#reading.delete(source.provider));
        this.#reading.set(source.provider, read);
        return read;
      }),
    );
  }
}
