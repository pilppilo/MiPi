// Pattern adapted from pi-pocket src/server/spend.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
/**
 * The daily spend cap and the pause switch (M9). Both are the agent's, so every door and every kind of background
 * work asks the same question here: may this start a model call now?
 *
 * - **Spend.** Pi Durable records each conversation's own spend in `pi.usage`, and MiPi's side calls (titles, the
 *   memory pass) add theirs there too (`recordUsage`). A measure sums every conversation, task-owned ones included,
 *   and adds what grew since the last measure to today's count. The count only grows, so a conversation whose usage
 *   disappears never gives spend back, and it starts afresh at Chicago midnight. Costs are pi-ai's list prices: an
 *   estimate, whatever the provider bills. The first measure only records where the total stands.
 * - **The cap** (`MIPI_DAILY_SPEND_CAP`, dollars) holds work nobody asked for at that moment: reminders, the memory
 *   pass, model-written titles. The owner's own messages still go through; the first one over the cap each day gets
 *   one warning line (Telegram).
 * - **Pause** (`MIPI_PAUSED`) holds every model call: doors refuse messages, and reminders are held as at the cap.
 *
 * pi-ledger L7. Spend is measured where work is decided (a reminder's admission, each tool round of a reminder run,
 * the memory pass, a title, the readout), never in a hook before a request: `beforeRequest` can't write or stop.
 */
import { configure, type Cursor, defineDoc, UsageDoc } from "./pi/durable.ts";
import type { TelegramChannelState } from "./telegram-state.ts";
import { enqueueReply, TelegramOutbox, type OutboxState } from "./telegram-outbox.ts";
import { chicagoDay } from "../lib/cap-day.ts";

type Tx = Parameters<typeof configure>[0];

export type SpendState = {
  /** The Chicago day `spent` counts. */
  day?: string;
  /** Dollars spent on `day`, as far as MiPi measured: list-price estimates from `pi.usage`. */
  spent: number;
  /** Every conversation's cost together at the last measure; the next measure adds what grew since. */
  lastTotal?: number;
  /** The day the notice that scheduled work waits went out. */
  noticeDay?: string;
  /** The day the owner was told their own messages are over the cap. */
  ownerNoticeDay?: string;
  /** The cap in force, in dollars, written by the agent at start from `MIPI_DAILY_SPEND_CAP`. Unset: no cap. */
  limit?: number;
  /** Whether `MIPI_PAUSED` is on, written by the agent at start. */
  paused?: boolean;
};

export const SPEND_DOC_KIND = "app.spend";

export const Spend = defineDoc<SpendState>({
  kind: SPEND_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ spent: 0 }),
  // A handful of numbers: a full base every time keeps replay at one record.
  checkpointWhen: () => true,
});

/** Why work nobody asked for at that moment may not start: paused, or today's spend reached the cap. */
export type Hold = "paused" | "spend-cap";

export const PAUSED_REPLY = "MiPi is paused, so it can't answer right now.";
export const SPEND_NOTICE =
  "Daily spend cap reached; scheduled runs and background work resume tomorrow.";

/**
 * `MIPI_DAILY_SPEND_CAP`: dollars, 0 or more. Unset, empty, `off` or `none`: no cap (`off` lets a lane's Environment
 * variable turn off `wrangler.jsonc`'s cap). Anything else is reported and means no cap.
 */
export function parseSpendCap(value: string | undefined): { cap?: number; invalid?: string } {
  const word = (value ?? "").trim().toLowerCase();
  if (word === "" || word === "off" || word === "none") return {};
  const cap = Number(word);
  return Number.isFinite(cap) && cap >= 0 ? { cap } : { invalid: value ?? "" };
}

const ON = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["", "0", "false", "no", "off"]);

/** `MIPI_PAUSED`: on or off. A value that is neither is reported and pauses: stopping is the safe side. */
export function parsePaused(value: string | undefined): { paused: boolean; invalid?: string } {
  const word = (value ?? "").trim().toLowerCase();
  if (ON.has(word)) return { paused: true };
  if (OFF.has(word)) return { paused: false };
  return { paused: true, invalid: value ?? "" };
}

/** Dollars as the readout shows them. */
export const dollars = (amount: number): string => `$${amount.toFixed(2)}`;

/** Every model and tool bucket of one conversation's usage, in dollars. */
function usageCost(usage: {
  readonly models: Readonly<Record<string, { readonly cost: { readonly total: number } }>>;
  readonly tools: Readonly<Record<string, { readonly cost: { readonly total: number } }>>;
}): number {
  let total = 0;
  for (const bucket of [usage.models, usage.tools]) {
    for (const entry of Object.values(bucket)) {
      // Stored data: a provider that reported no cost leaves nothing to add.
      const cost = entry.cost.total;
      if (Number.isFinite(cost) && cost > 0) total += cost;
    }
  }
  return total;
}

/** Every conversation's spend together, task-owned ones (subagents) and forks included. */
export async function totalCost(tx: Tx): Promise<number> {
  let total = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const record of page.items) total += usageCost(await tx.doc(UsageDoc, record.id));
    cursor = page.next;
  } while (cursor !== undefined);
  return total;
}

/** Today's spend as of the last measure: nothing yet on a day not measured. */
export const spentToday = (state: Readonly<SpendState>, now: number): number =>
  state.day === chicagoDay(now) ? state.spent : 0;

/** Whether work nobody asked for at that moment is held now, and why. Changes nothing. */
export function holdOf(state: Readonly<SpendState>, now: number): Hold | undefined {
  if (state.paused === true) return "paused";
  if (state.limit !== undefined && spentToday(state, now) >= state.limit) return "spend-cap";
  return undefined;
}

/**
 * Brings today's count up to date: adds what every conversation spent since the last measure. Writes only what
 * changed. Call it before a decision, in a commit that submits nothing (or after the submit): it reads every
 * conversation's usage.
 */
export async function measureSpend(tx: Tx, now: number): Promise<SpendState> {
  const total = await totalCost(tx);
  const state = await tx.doc(Spend);
  const day = chicagoDay(now);
  const grown = state.lastTotal === undefined ? 0 : Math.max(0, total - state.lastTotal);
  const spent = (state.day === day ? state.spent : 0) + grown;
  if (state.day !== day) state.day = day;
  if (state.spent !== spent) state.spent = spent;
  if (state.lastTotal !== total) state.lastTotal = total;
  return { ...state, spent };
}

/**
 * Today's one notice that scheduled work waits for the spend cap: to `chatId` when the held reminder answers in a
 * chat, otherwise the private chat that last wrote. With neither, nothing is sent and the day isn't marked.
 */
export function noticeSpend(
  state: SpendState,
  channel: TelegramChannelState,
  outbox: OutboxState,
  chatId: number | undefined,
  now: number,
): void {
  const day = chicagoDay(now);
  if (state.noticeDay === day) return;
  const chat = chatId ?? channel.lastChat;
  if (chat === undefined) return;
  state.noticeDay = day;
  enqueueReply(outbox, { id: `spend-cap:${day}`, chatId: chat, text: SPEND_NOTICE }, now);
}

/**
 * The owner's first message over the cap each day gets one line saying so, in its chat. Their messages still go
 * through. Measures first; call it after the commit's submit. Returns whether a line was queued.
 */
export async function warnOwnerOverCap(tx: Tx, chatId: number, now: number): Promise<boolean> {
  const day = chicagoDay(now);
  const stored = await tx.doc(Spend);
  // No cap, or told today already: no need to read every conversation's usage.
  if (stored.limit === undefined || stored.paused === true || stored.ownerNoticeDay === day) {
    return false;
  }
  const state = await measureSpend(tx, now);
  if (holdOf(state, now) !== "spend-cap") return false;
  stored.ownerNoticeDay = day;
  enqueueReply(
    await tx.doc(TelegramOutbox),
    {
      id: `spend-owner:${day}`,
      chatId,
      text: `Heads up: MiPi has spent about ${dollars(state.spent)} today, over its ${dollars(state.limit ?? 0)} daily cap. Your messages still go through; scheduled runs wait until tomorrow.`,
    },
    now,
  );
  return true;
}
