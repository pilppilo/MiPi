/**
 * OpenCode Go's usage reader (M9, COD-193), moved out of core in COD-212. Registered with core's providers connector
 * (`src/agent/providers.ts`) by this extension's `index.ts`.
 */
import type { ProviderUsage, UsageWindow } from "../../../protocol.ts";
import type { UsageSource } from "../../../agent/providers.ts";
import { MODEL_PROVIDER, type ReadEnv } from "../../../agent/pi/models.ts";

const READ_TIMEOUT_MS = 5_000;

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
