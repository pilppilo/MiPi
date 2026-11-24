/**
 * The usage readout (M9), the same for every door: Telegram's `/usage`, the web header and the admin status. Today's
 * spend by MiPi's own estimate is measured as it's read, then each provider's own figures are added where MiPi can
 * read them (`providers.ts`).
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import type { Harness } from "./pi/durable.ts";
import { runCap } from "./gates.ts";
import { dollars, holdOf, measureSpend, Spend, spentToday } from "./spend.ts";
import { localTime } from "./stamp.ts";
import type { ProviderUsageCache } from "./providers.ts";
import { chicagoDay } from "../lib/cap-day.ts";
import type { UsageReadout } from "../protocol.ts";

/**
 * Today's readout, with today's spend measured first. `fresh: false` measures nothing and asks no provider: it shows
 * the spend as last measured and what providers said in the last five minutes. The admin status uses it, so a GET
 * writes nothing and a deploy's checks never wait on a provider.
 */
export async function readUsage(
  harness: Harness,
  providers: ProviderUsageCache,
  now: number,
  options: { readonly fresh?: boolean } = {},
): Promise<UsageReadout> {
  const day = chicagoDay(now);
  const own = await harness.commit(async (tx) => {
    const spend = options.fresh === false ? await tx.doc(Spend) : await measureSpend(tx, now);
    const held = holdOf(spend, now);
    return {
      day,
      spent: spentToday(spend, now),
      ...(spend.limit === undefined ? {} : { cap: spend.limit }),
      ...(held === undefined ? {} : { held }),
      runs: await runCap(tx, now),
    };
  }, BACKGROUND_CONTEXT);
  return {
    ...own,
    providers: options.fresh === false ? providers.cached(now) : await providers.read(now),
  };
}

/** The readout as a few lines of plain text, for Telegram. */
export function usageText(readout: UsageReadout, timeZone: string | undefined): string {
  const lines = [
    readout.cap === undefined
      ? `Today: about ${dollars(readout.spent)} (MiPi's estimate at list prices; no daily cap).`
      : `Today: about ${dollars(readout.spent)} of the ${dollars(readout.cap)} daily cap (MiPi's estimate at list prices).`,
    `Scheduled runs: ${readout.runs.used} of ${readout.runs.cap} rounds.`,
  ];
  if (readout.held === "paused") lines.push("MiPi is paused (MIPI_PAUSED).");
  if (readout.held === "spend-cap") {
    lines.push("Over the spend cap: scheduled runs and background work wait until tomorrow.");
  }
  for (const provider of readout.providers) {
    switch (provider.status) {
      case "unavailable":
        lines.push(`${provider.label}: usage unavailable (${provider.reason}).`);
        break;
      case "ok": {
        const windows = provider.windows.map(
          (window) =>
            `${window.name} ${Math.round(window.percent)}%${window.limited ? ", limit reached" : ""} (resets ${localTime(window.resetsAt, timeZone)})`,
        );
        lines.push(`${provider.label}: ${windows.join("; ")}.`);
        break;
      }
      default: {
        const _: never = provider;
        throw new Error("Unknown provider usage");
      }
    }
  }
  return lines.join("\n");
}
