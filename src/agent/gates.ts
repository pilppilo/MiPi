/**
 * The gates (COD-210): may work start a model call now? Core owns the run cap (`proactive.ts`) and the spend cap and
 * pause (`spend.ts`); doors and extensions ask here, read-only, and never read those documents themselves. The one
 * write is charging a round, which happens when a proactive input is admitted (`expectProactive`). No extension can
 * replace a gate.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import type { Harness, Tx } from "./pi/durable.ts";
import type { Delivery, DeliveryDestination } from "./delivery.ts";
import {
  DEFAULT_DAILY_RUN_CAP,
  hasRound,
  noticeCap,
  Proactive,
  PROACTIVE_DOC_KIND,
} from "./proactive.ts";
import {
  type Hold as SpendHold,
  holdOf,
  measureSpend,
  noticeSpend,
  Spend,
  SPEND_DOC_KIND,
} from "./spend.ts";
import {
  PROVIDER_LIMIT_DOC_KIND,
  ProviderLimits,
  providerHeldUntil,
  tellProviderLimit,
} from "./limits.ts";
import { afterNextChicagoMidnight, chicagoDay } from "../lib/cap-day.ts";

export { PAUSED_REPLY, warnOwnerOverCap } from "./spend.ts";
export { expectProactive } from "./proactive.ts";

/** The documents the gates read: a commit that changes one may open or close a gate. */
export const GATE_DOC_KINDS: readonly string[] = [
  PROACTIVE_DOC_KIND,
  SPEND_DOC_KIND,
  PROVIDER_LIMIT_DOC_KIND,
];

export type Hold = SpendHold | "provider-limit";

/** Why a proactive run may not start: a hold, or today's run cap. */
export type ProactiveHold = Hold | "run-cap";

/** The proactive gate as last measured, with the effective deadline of timed holds. */
export async function readProactiveHold(harness: Harness, now: number) {
  const [spend, limits, proactive] = await Promise.all([
    harness.snapshot(Spend, BACKGROUND_CONTEXT),
    harness.snapshot(ProviderLimits, BACKGROUND_CONTEXT),
    harness.snapshot(Proactive, BACKGROUND_CONTEXT),
  ]);
  const spendHold = spend === undefined ? undefined : holdOf(spend, now);
  const providerUntil = providerHeldUntil(limits, now);
  const runCapped = proactive !== undefined && !hasRound(proactive, now);
  const held: ProactiveHold | undefined =
    spendHold ??
    (providerUntil === undefined ? undefined : "provider-limit") ??
    (runCapped ? "run-cap" : undefined);
  const heldUntil =
    held === "paused"
      ? undefined
      : maxDeadline(
          spendHold === "spend-cap" || runCapped ? afterNextChicagoMidnight(now) : undefined,
          providerUntil,
        );
  return { held, heldUntil, lastProactiveRun: proactive?.lastRun };
}

/** Whether MiPi is paused (`MIPI_PAUSED`): every model call is held, the owner's messages too. */
export async function isPaused(tx: Tx): Promise<boolean> {
  return (await tx.doc(Spend)).paused === true;
}

/** `isPaused` outside a commit: a snapshot, which writes nothing. */
export async function isPausedNow(harness: Harness): Promise<boolean> {
  return (await harness.snapshot(Spend, BACKGROUND_CONTEXT))?.paused === true;
}

/** Brings today's spend up to date (`measureSpend`). Reads every conversation's usage: call it before deciding. */
export async function measureToday(tx: Tx, now: number): Promise<void> {
  await measureSpend(tx, now);
}

/** Whether work nobody asked for at that moment is held, as of the last measure. Changes nothing. */
export async function heldAsMeasured(tx: Tx, now: number): Promise<Hold | undefined> {
  return (
    holdOf(await tx.doc(Spend), now) ??
    ((await providerHoldUntil(tx, now)) === undefined ? undefined : "provider-limit")
  );
}

/** Takes a read-only view of the background gate for the alarm planner. */
export async function backgroundHoldNow(harness: Harness, now: number) {
  const spend = await harness.snapshot(Spend, BACKGROUND_CONTEXT);
  const cap = spend === undefined ? undefined : holdOf(spend, now);
  const provider = providerHeldUntil(
    await harness.snapshot(ProviderLimits, BACKGROUND_CONTEXT),
    now,
  );
  return {
    paused: cap === "paused",
    until: maxDeadline(cap === "spend-cap" ? afterNextChicagoMidnight(now) : undefined, provider),
  };
}

const maxDeadline = (cap: number | undefined, provider: number | undefined) =>
  cap === undefined ? provider : Math.max(cap, provider ?? cap);

export async function providerHoldUntil(tx: Tx, now: number) {
  return providerHeldUntil(await tx.doc(ProviderLimits), now);
}

/** The next time to check a timed hold, considering all applicable caps and provider deadlines. */
export async function heldUntil(
  tx: Tx,
  hold: ProactiveHold,
  now: number,
  proactive = false,
): Promise<number> {
  if (hold === "paused") return afterNextChicagoMidnight(now);
  const cap =
    hold === "spend-cap" ||
    hold === "run-cap" ||
    holdOf(await tx.doc(Spend), now) === "spend-cap" ||
    (proactive && !hasRound(await tx.doc(Proactive), now));
  return (
    maxDeadline(
      cap ? afterNextChicagoMidnight(now) : undefined,
      await providerHoldUntil(tx, now),
    ) ?? now
  );
}

/** Whether work nobody asked for at that moment is held, with today's spend measured first. */
export async function holdNow(tx: Tx, now: number): Promise<Hold | undefined> {
  await measureSpend(tx, now);
  return heldAsMeasured(tx, now);
}

/**
 * Whether a proactive run may start now, as of the last measure: a hold first, then today's run cap. Changes nothing;
 * the round is charged when the input is admitted (`expectProactive`).
 */
export async function proactiveHold(tx: Tx, now: number): Promise<ProactiveHold | undefined> {
  return (
    (await heldAsMeasured(tx, now)) ??
    (hasRound(await tx.doc(Proactive), now) ? undefined : "run-cap")
  );
}

/** Whether the run cap is 0 (`MIPI_DAILY_RUN_CAP=0`): proactive and background work is switched off. */
export async function runsOff(tx: Tx): Promise<boolean> {
  return (await tx.doc(Proactive)).limit === 0;
}

/** `runsOff` outside a commit. */
export async function runsOffNow(harness: Harness): Promise<boolean> {
  return (await harness.snapshot(Proactive, BACKGROUND_CONTEXT))?.limit === 0;
}

/** Today's proactive rounds and the cap in force, for the readout. */
export async function runCap(tx: Tx, now: number): Promise<{ used: number; cap: number }> {
  const proactive = await tx.doc(Proactive);
  return {
    used: proactive.cap?.day === chicagoDay(now) ? proactive.cap.count : 0,
    cap: proactive.limit ?? DEFAULT_DAILY_RUN_CAP,
  };
}

/**
 * Today's one notice that proactive work waits for a cap (`run-cap` or `spend-cap`), in the caller's commit: at
 * `prefer` when it can push, otherwise wherever delivery says the owner is. A pause tells nothing.
 */
export async function tellHeld(
  tx: Tx,
  delivery: Delivery,
  held: ProactiveHold,
  prefer: DeliveryDestination | undefined,
  now: number,
): Promise<void> {
  switch (held) {
    case "run-cap":
      await noticeCap(tx, await tx.doc(Proactive), delivery, prefer, now);
      return;
    case "spend-cap":
      await noticeSpend(tx, await tx.doc(Spend), delivery, prefer, now);
      return;
    case "provider-limit":
      await tellProviderLimit(tx, delivery, prefer, now);
      return;
    case "paused":
      return;
    default: {
      const _: never = held;
      throw new Error("Unknown hold");
    }
  }
}
