/**
 * Delivery (COD-210): core sends through the doors' adapters, inside the caller's commit. A notice and the state change
 * it belongs to are stored together, so a crash between them drops neither and repeats neither; destinations that
 * can't push (the web) get nothing, and the owner is told where the doors say they are.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { composeMipi } from "../src/agent/composition.ts";
import { Delivery, type DeliveryAdapter } from "../src/agent/delivery.ts";
import { tellHeld } from "../src/agent/gates.ts";
import { CAP_NOTICE, Proactive } from "../src/agent/proactive.ts";
import { Spend, SPEND_NOTICE } from "../src/agent/spend.ts";
import { chicagoDay } from "../src/lib/cap-day.ts";
import { TelegramOutbox } from "../src/doors/telegram/outbox.ts";
import { TelegramChannel } from "../src/doors/telegram/state.ts";

const ctx = BACKGROUND_CONTEXT;
const CHAT = 4242;
/** Noon in Chicago: no test crosses the caps' midnight. */
const NOON = Date.UTC(2026, 10, 23, 18, 0);

const pushing = (kind: string, sent: string[], owner?: string): DeliveryAdapter => ({
  kind,
  canPush: true,
  key: (destination) => String(destination.id),
  describe: () => kind,
  send: async (_tx, destination, message) => {
    sent.push(`${kind}:${String(destination.id)}:${message.id}`);
  },
  ...(owner === undefined ? {} : { ownerDestination: async () => ({ kind, id: owner }) }),
});

describe("delivery", () => {
  it("sends only where a destination can push, and tells the owner where a door knows them", async () => {
    const sent: string[] = [];
    const delivery = new Delivery(
      [
        { kind: "web", canPush: false, key: (d) => String(d.id), describe: () => "web" },
        pushing("quiet", sent),
        pushing("chat", sent, "owner"),
      ],
      (conversationId) => ({ kind: "web", id: conversationId }),
    );
    const tx = {} as never;
    expect(await delivery.send(tx, { kind: "web", id: 1 }, { id: "a", text: "x" }, 0)).toBe(false);
    expect(await delivery.send(tx, { kind: "gone", id: 1 }, { id: "b", text: "x" }, 0)).toBe(false);
    expect(await delivery.send(tx, { kind: "quiet", id: 7 }, { id: "c", text: "x" }, 0)).toBe(true);
    // Preferred where it can push; otherwise the first door that knows where the owner is.
    expect(await delivery.tellOwner(tx, { id: "d", text: "x" }, 0, { kind: "quiet", id: 8 })).toBe(
      true,
    );
    expect(await delivery.tellOwner(tx, { id: "e", text: "x" }, 0, { kind: "web", id: 1 })).toBe(
      true,
    );
    expect(sent).toEqual(["quiet:7:c", "quiet:8:d", "chat:owner:e"]);
    expect(delivery.transcriptOf(3)).toEqual({ kind: "web", id: 3 });
    expect(delivery.canPush({ kind: "web", id: 1 })).toBe(false);
    // Nobody to tell: nothing sent, and the caller knows.
    expect(await new Delivery([]).tellOwner(tx, { id: "f", text: "x" }, 0)).toBe(false);
    expect(() => new Delivery([pushing("chat", sent), pushing("chat", sent)])).toThrow(/twice/);
  });

  it("describes and keys Telegram and web destinations as the doors register them", () => {
    const { delivery } = composeMipi().connectors;
    expect(delivery.kinds()).toEqual(["web", "telegram"]);
    expect(delivery.canPush({ kind: "telegram", chatId: CHAT })).toBe(true);
    expect(delivery.canPush({ kind: "web", conversationId: 1 })).toBe(false);
    expect(delivery.key({ kind: "telegram", chatId: CHAT })).toBe(String(CHAT));
    expect(delivery.describe({ kind: "telegram", chatId: CHAT })).toBe("this Telegram chat");
    expect(delivery.describe({ kind: "web", conversationId: 1 })).toBe("this conversation");
    expect(delivery.transcriptOf(5)).toEqual({ kind: "web", conversationId: 5 });
  });

  it("neither drops nor repeats a notice when the commit with its state change fails", async () => {
    const composition = composeMipi({
      models: createModels(),
      model: { provider: "faux", modelId: "faux-1" },
    });
    const { delivery } = composition.connectors;
    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      await harness.commit(async (tx) => {
        (await tx.doc(TelegramChannel)).lastChat = CHAT;
        // The run cap used up and the spend cap reached, both today.
        const proactive = await tx.doc(Proactive);
        proactive.limit = 1;
        proactive.cap = { day: chicagoDay(NOON), count: 1, noticeSent: false };
        Object.assign(await tx.doc(Spend), { day: chicagoDay(NOON), spent: 2, limit: 1 });
      }, ctx);

      // A crash after the notice was enqueued, before the commit ends: nothing of it is stored.
      await expect(
        harness.commit(async (tx) => {
          await tellHeld(tx, delivery, "run-cap", undefined, NOON);
          await tellHeld(tx, delivery, "spend-cap", undefined, NOON);
          throw new Error("crash");
        }, ctx),
      ).rejects.toThrow("crash");
      expect((await harness.snapshot(TelegramOutbox, ctx))?.replies ?? []).toEqual([]);
      expect((await harness.snapshot(Proactive, ctx))?.cap?.noticeSent).toBe(false);
      expect((await harness.snapshot(Spend, ctx))?.noticeDay).toBeUndefined();

      // The retry tells once, and every later held run tells nothing more today.
      for (let attempt = 0; attempt < 3; attempt++) {
        await harness.commit(async (tx) => {
          await tellHeld(tx, delivery, "run-cap", undefined, NOON);
          await tellHeld(tx, delivery, "spend-cap", undefined, NOON);
          await tellHeld(tx, delivery, "paused", undefined, NOON);
        }, ctx);
      }
      const replies = (await harness.snapshot(TelegramOutbox, ctx))?.replies ?? [];
      expect(replies.map(({ id, chatId, chunks }) => [id, chatId, chunks[0]?.text])).toEqual([
        [`cap:${chicagoDay(NOON)}`, CHAT, CAP_NOTICE],
        [`spend-cap:${chicagoDay(NOON)}`, CHAT, SPEND_NOTICE],
      ]);
      expect((await harness.snapshot(Proactive, ctx))?.cap?.noticeSent).toBe(true);
      expect((await harness.snapshot(Spend, ctx))?.noticeDay).toBe(chicagoDay(NOON));
    } finally {
      await harness.close(ctx);
    }
  });

  it("waits to tell until someone can be told, without marking the day", async () => {
    const composition = composeMipi({
      models: createModels(),
      model: { provider: "faux", modelId: "faux-1" },
    });
    const { delivery } = composition.connectors;
    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      await harness.commit(async (tx) => {
        const proactive = await tx.doc(Proactive);
        proactive.limit = 0;
        // No chat has written, and the held reminder answers on the web.
        await tellHeld(tx, delivery, "run-cap", { kind: "web", conversationId: 1 }, NOON);
      }, ctx);
      expect((await harness.snapshot(TelegramOutbox, ctx))?.replies ?? []).toEqual([]);
      expect((await harness.snapshot(Proactive, ctx))?.cap?.noticeSent).toBe(false);
    } finally {
      await harness.close(ctx);
    }
  });
});
