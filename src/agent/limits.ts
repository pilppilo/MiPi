import { isRetryableErrorText, type AssistantMessage } from "./pi/ai.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  type Extension,
  type Harness,
  type SubmissionRecord,
  type Tx,
} from "./pi/durable.ts";
import type { Providers, ProviderUsageCache } from "./providers.ts";
import type { Delivery, DeliveryDestination } from "./delivery.ts";
import { AgentSettings } from "./settings.ts";
import { localTime } from "./stamp.ts";
import { KeyedSerialQueue } from "../lib/serial.ts";

export const PROVIDER_LIMIT_DOC_KIND = "app.provider-limit";
const UNKNOWN_RESET_HOLD_MS = 5 * 60_000;
export const TRANSIENT_REMINDER_COOLDOWN_MS = 60_000;

type Entry = {
  label: string;
  resetAt?: number;
  resetFrom?: "error" | "usage";
  at: number;
  told?: true;
};
type LimitState = { entries: Record<string, Entry> };

export const ProviderLimits = defineDoc<LimitState>({
  kind: PROVIDER_LIMIT_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ entries: {} }),
  checkpointWhen: () => true,
});

type PlanLimit = {
  kind: "usage";
  provider: string;
  label: string;
  resetAt?: number;
  reason: string;
};
type RateLimit = { kind: "rate"; provider?: string; label: string; reason: string };
export type ProviderLimit = PlanLimit | RateLimit;

function usageLimit(
  providers: Providers | undefined,
  provider: string | undefined,
  text: string,
  now: number,
): PlanLimit | undefined {
  for (const parser of providers?.limitParsers ?? []) {
    if (provider !== undefined && parser.provider !== provider) continue;
    const limit = parser.parse(text, now);
    if (limit !== undefined) {
      return {
        kind: "usage",
        provider: parser.provider,
        label: parser.label,
        ...limit,
        reason: text,
      };
    }
  }
}

export function limitOf(
  providers: Providers | undefined,
  provider: string | undefined,
  text: string,
  now: number,
): ProviderLimit | undefined {
  const usage = usageLimit(providers, provider, text, now);
  if (usage !== undefined) return usage;
  if (!isRetryableErrorText(text)) return undefined;
  return {
    kind: "rate",
    provider,
    label:
      providers?.limitParsers.find((parser) => parser.provider === provider)?.label ??
      "The model provider",
    reason: text,
  };
}

export function isTransientModelFailure(record: SubmissionRecord): boolean {
  return (
    record.status === "unanswered" &&
    record.reason === "model_error" &&
    typeof record.detail === "string" &&
    isRetryableErrorText(record.detail)
  );
}

export function activeLimits(state: LimitState | undefined, now: number) {
  return Object.entries(state?.entries ?? {}).flatMap(([provider, entry]) => {
    const until = entry.resetAt ?? entry.at + UNKNOWN_RESET_HOLD_MS;
    return until > now ? [{ provider, entry, until }] : [];
  });
}

export function providerHeldUntil(state: LimitState | undefined, now: number): number | undefined {
  const until = Math.max(now, ...activeLimits(state, now).map((limit) => limit.until));
  return until > now ? until : undefined;
}

export function limitText(
  limit: { kind: ProviderLimit["kind"]; label: string },
  entry: Entry | undefined,
  zone?: string,
): string {
  if (limit.kind === "rate")
    return `${limit.label} is rate limiting MiPi or temporarily unavailable. Try again in a minute.`;
  const reset = entry?.resetAt;
  return reset === undefined
    ? `${limit.label}'s usage limit is reached. /usage shows its windows.`
    : `${limit.label}'s usage limit is reached. It resets at ${localTime(reset, zone)}.`;
}

export async function settledLimit(
  tx: Tx,
  providers: Providers | undefined,
  detail: string | undefined,
  now: number,
) {
  if (detail === undefined) return undefined;
  const limit = limitOf(providers, undefined, detail, now);
  if (limit === undefined) return undefined;
  const active =
    limit.kind === "usage"
      ? activeLimits(await tx.doc(ProviderLimits), now).find(
          ({ provider }) => provider === limit.provider,
        )
      : undefined;
  const zone = (await tx.doc(AgentSettings)).timeZone;
  return { limit, text: limitText(limit, active?.entry, zone) };
}

export async function tellProviderLimit(
  tx: Tx,
  delivery: Delivery,
  prefer: DeliveryDestination | undefined,
  now: number,
  providerId?: string,
): Promise<boolean> {
  const state = await tx.doc(ProviderLimits);
  const zone = (await tx.doc(AgentSettings)).timeZone;
  let sent = false;
  for (const { provider, entry } of activeLimits(state, now)) {
    if ((providerId !== undefined && provider !== providerId) || entry.told) continue;
    if (
      await delivery.tellOwner(
        tx,
        {
          id: `provider-limit:${provider}:${entry.at}`,
          text: limitText({ kind: "usage", label: entry.label }, entry, zone),
        },
        now,
        prefer,
      )
    ) {
      entry.told = true;
      sent = true;
    }
  }
  return sent;
}

type Observation = PlanLimit | { kind: "success"; provider: string };
type RecordLimit = (observation: Observation) => Promise<void>;
type Binding = { providers?: Providers; recordLimit?: RecordLimit };
const extensionBindings = new WeakMap<Extension, Binding>();
const sideCallBindings = new WeakMap<Harness, Binding>();

async function observeResponse(
  binding: Binding | undefined,
  message: AssistantMessage,
  now: number,
) {
  if (binding?.recordLimit === undefined) return;
  if (message.stopReason === "error" && message.errorMessage !== undefined) {
    const limit = usageLimit(binding.providers, message.provider, message.errorMessage, now);
    if (limit !== undefined) {
      await binding.recordLimit(limit);
      return limit;
    }
  } else if (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse"
  ) {
    await binding.recordLimit({ kind: "success", provider: message.provider });
  }
}

export function providerLimitsExtension(): Extension {
  const binding: Binding = {};
  const extension = defineExtension({
    name: "provider-limits",
    hooks: [
      hook(GenerationTask, {
        // pi-ledger L9: this awaited observer runs off the Session line and has no write API of its own.
        afterResponse: async (message, api) => {
          await observeResponse(binding, message, api.now());
        },
      }),
    ],
  });
  extensionBindings.set(extension, binding);
  return extension;
}

export function bindLimitRecorder(
  extension: Extension,
  harness: Harness,
  providers: Providers,
  usage: ProviderUsageCache,
  now: () => number = Date.now,
): void {
  const binding = extensionBindings.get(extension);
  if (binding === undefined) throw new Error("Missing provider limit extension binding");
  const pending = new KeyedSerialQueue<string>();
  binding.providers = providers;
  binding.recordLimit = async (observation) => {
    const { provider } = observation;
    const record = async () => {
      if (observation.kind === "success") {
        const state = await harness.snapshot(ProviderLimits, BACKGROUND_CONTEXT);
        if (!Object.hasOwn(state?.entries ?? {}, provider)) return;
        await harness.commit(async (tx) => {
          delete (await tx.doc(ProviderLimits)).entries[provider];
        }, BACKGROUND_CONTEXT);
        return;
      }
      const observedAt = now();
      const hintedReset = observation.resetAt;
      const useHint =
        hintedReset !== undefined && hintedReset > observedAt && hintedReset <= 8.64e15;
      const usageRead = useHint ? undefined : await usage.readFresh(provider, observedAt);
      const at = now();
      const reset = useHint
        ? hintedReset
        : Math.max(
            0,
            ...(usageRead?.status === "ok" ? usageRead.windows : [])
              .filter(
                (window) => window.limited && window.resetsAt > at && window.resetsAt <= 8.64e15,
              )
              .map((window) => window.resetsAt),
          );
      const resetAt = Number.isFinite(reset) && reset > at ? reset : undefined;
      const resetFrom = resetAt === undefined ? undefined : useHint ? "error" : "usage";
      await harness.commit(async (tx) => {
        const state = await tx.doc(ProviderLimits);
        const active = activeLimits(state, at).find((entry) => entry.provider === provider);
        const entry: Entry = {
          label: observation.label,
          at,
          ...(resetFrom !== undefined
            ? { resetAt, resetFrom }
            : active?.entry.resetAt === undefined
              ? {}
              : { resetAt: active.entry.resetAt, resetFrom: active.entry.resetFrom }),
          ...(active?.entry.told ? { told: true } : {}),
        };
        state.entries = { ...state.entries, [provider]: entry };
      }, BACKGROUND_CONTEXT);
    };
    await pending.run(provider, record);
  };
  sideCallBindings.set(harness, { providers, recordLimit: binding.recordLimit });
}

export function observeSideResponse(harness: Harness, message: AssistantMessage, now: number) {
  return observeResponse(sideCallBindings.get(harness), message, now);
}
