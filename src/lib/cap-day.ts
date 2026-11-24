/**
 * The day MiPi's daily limits count in: the owner's calendar day in Chicago. The run cap (M6), the memory pass's cap
 * (M8) and the spend cap (M9) all start afresh at Chicago midnight. Here, with no Pi imports, so every one of them can
 * share it without importing the others.
 */
import { zonedMoment } from "./when.ts";

/** The caps' day is the owner's calendar day. */
export const CAP_ZONE = "America/Chicago";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAP_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Chicago calendar day of `now`, as `YYYY-MM-DD`. */
export const chicagoDay = (now: number): string => dayFormat.format(now);

/** A second past the next Chicago midnight, so a wake right on the boundary is already in the new day. */
export function afterNextChicagoMidnight(now: number): number {
  const [year, month, day] = chicagoDay(now).split("-").map(Number) as [number, number, number];
  return zonedMoment(year, month, day + 1, 0, 0, CAP_ZONE) + 1_000;
}
