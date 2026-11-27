/**
 * Archive and restore (COD-198): an archived bot and its cobots drop out of sight, no door reaches them and their
 * schedules hold; restoring brings back the bot, its cobots, its schedule, its binding and its held reminders. On
 * MiPi's real harness options, a faux model, Durable Object SQLite and a test clock (`reminder-agent.ts`).
 */
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  abortArchived,
  archiveBot,
  isArchived,
  replayHeld,
  restoreBot,
  routeSchedule,
} from "../src/agent/archive.ts";
import { botNameRefusal, createBot, liveBots } from "../src/agent/bots.ts";
import {
  bindChannel,
  Bots,
  boundConversation,
  ConversationMeta,
} from "../src/agent/conversations.ts";
import { readHeartbeat } from "../src/agent/heartbeat.ts";
import { Spend } from "../src/agent/spend.ts";
import { listVisible, OWNER_SCOPE } from "../src/agent/visibility.ts";
import {
  type ReminderInput,
  ScheduledReminder,
} from "../src/extensions/builtin/reminders/reminder-task.ts";
import { readSchedules } from "../src/extensions/builtin/reminders/schedule.ts";
import { PROFILES } from "./mipi.ts";
import {
  CHAT,
  clock,
  ctx,
  inObject,
  openAgent,
  reminders,
  said,
  userTexts,
  ZONE,
} from "./reminder-agent.ts";

const TG = `tg:${CHAT}`;

/** A purpose bot with a cobot (as COD-200 will make them), the chat bound to the bot. */
async function gardenBot(harness: Harness) {
  return harness.commit(async (tx) => {
    const bot = await createBot(
      tx,
      {
        kind: "bot",
        name: "Garden",
        purpose: "Look after the garden.",
        profile: "default",
        createdBy: "owner",
      },
      PROFILES,
    );
    const cobot = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
    const meta = await tx.doc(ConversationMeta, cobot);
    meta.kind = "cobot";
    meta.bot = bot;
    await bindChannel(tx, TG, bot);
    return { bot, cobot };
  }, ctx);
}

/** A reminder made in `conversationId`, as `schedule` makes one. */
function remind(
  harness: Harness,
  conversationId: ConversationId,
  reminder: Omit<ReminderInput, "conversationId" | "zone" | "destination">,
) {
  return harness.commit(
    (tx) =>
      tx.createTask(
        ScheduledReminder,
        {
          ...reminder,
          conversationId,
          zone: ZONE,
          destination: { kind: "telegram", chatId: CHAT },
        },
        { ownership: { kind: "conversation" }, conversationId, background: true },
      ),
    ctx,
  );
}

const bound = (harness: Harness) =>
  harness.commit((tx) => boundConversation(tx, TG, "default", PROFILES), ctx);

const archive = async (harness: Harness, id: ConversationId) => {
  const archived = await harness.commit((tx) => archiveBot(tx, id, clock.now), ctx);
  await abortArchived(harness, archived, ctx);
  return archived;
};

const restore = async (harness: Harness, id: ConversationId) => {
  const { conversations } = await harness.commit((tx) => restoreBot(tx, id, PROFILES), ctx);
  return replayHeld(harness, conversations, clock.now, ctx);
};

describe("archive and restore (COD-198)", () => {
  it("hides a bot and its cobots, sends its door to MiPi, and holds its schedules", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const { bot, cobot } = await gardenBot(harness);
        const { mainId } = (await harness.snapshot(Bots, ctx))!;
        const first = clock.now + 60_000;
        await remind(harness, bot, {
          id: "reminder:once",
          instruction: "Water",
          first,
        });
        await remind(harness, cobot, {
          id: "reminder:every",
          instruction: "Check the soil",
          first,
          every: { minutes: 30 },
        });
        expect(await bound(harness)).toBe(bot);

        expect(await archive(harness, bot)).toEqual([bot, cobot]);
        // Gone from sight: the bots list, and everything that looks across conversations.
        expect((await harness.commit(liveBots, ctx)).map(({ name }) => name)).toEqual(["MiPi"]);
        const visible = await harness.commit((tx) => listVisible(tx, OWNER_SCOPE), ctx);
        expect(visible.map(({ id }) => id)).not.toContain(bot);
        expect(visible.map(({ id }) => id)).not.toContain(cobot);
        // Archiving again archives nothing.
        expect(await archive(harness, bot)).toEqual([]);

        // A door bound to it reaches MiPi, and remembers where it was.
        expect(await bound(harness)).toBe(mainId);
        expect((await harness.snapshot(Bots, ctx))?.released).toEqual({ [TG]: bot });

        // The heartbeat sees a known hold, not overdue alarms.
        const work = await harness.commit(readSchedules, ctx);
        expect(work.map(({ held }) => held)).toEqual(["archived", "archived"]);

        // Due: nothing runs, nothing is sent. The one-time reminder parks and ends; the repeat skips its time.
        await agent.advance(60_000);
        expect(agent.sent).toEqual([]);
        expect(await userTexts(harness, bot)).toEqual([]);
        expect(await userTexts(harness, cobot)).toEqual([]);
        const held = (await harness.snapshot(Bots, ctx))?.held;
        expect(held).toEqual([
          expect.objectContaining({
            id: "reminder:once",
            conversationId: bot,
            requestId: "held:reminderonce",
            destination: { kind: "telegram", chatId: CHAT },
          }),
        ]);
        const left = await reminders(harness);
        expect(left.map(({ input }) => input.id)).toEqual(["reminder:every"]);
        // Asleep until its next time.
        expect(left[0]!.checkpoint).toMatchObject({
          phase: "send",
          at: first + 30 * 60_000,
          skippedArchived: 1,
          sent: 0,
        });
      } finally {
        await agent.close();
      }
    }));

  it("brings back the bot, its cobot, its schedule, its binding and its held reminder", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, [
        ...said("Watering now, a little late.", "Soil is fine."),
      ]);
      try {
        const { harness } = agent;
        const { bot, cobot } = await gardenBot(harness);
        await remind(harness, bot, {
          id: "reminder:once",
          instruction: "Water",
          first: clock.now + 60_000,
        });
        await remind(harness, cobot, {
          id: "reminder:every",
          instruction: "Check the soil",
          first: clock.now + 60_000,
          every: { minutes: 30 },
        });
        await archive(harness, bot);
        await bound(harness);
        await agent.advance(60_000);
        expect(agent.sent).toEqual([]);

        expect(await restore(harness, bot)).toBe(1);
        await agent.settle();
        // The held reminder, marked late, answered in its chat.
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Watering now, a little late." }]);
        expect((await userTexts(harness, bot)).at(-1)).toMatch(/while this bot was archived/);
        // A second restore sends nothing twice.
        expect(await restore(harness, bot)).toBe(0);
        expect((await harness.snapshot(Bots, ctx))?.held).toEqual([]);

        // Back in sight, both of them, and the chat talks to it again.
        expect(await harness.commit((tx) => isArchived(tx, bot), ctx)).toBe(false);
        expect(await harness.commit((tx) => isArchived(tx, cobot), ctx)).toBe(false);
        expect((await harness.snapshot(ConversationMeta, cobot, ctx))?.archivedAt).toBeUndefined();
        expect((await harness.commit(liveBots, ctx)).map(({ name }) => name)).toEqual([
          "MiPi",
          "Garden",
        ]);
        expect(await bound(harness)).toBe(bot);
        expect((await harness.snapshot(Bots, ctx))?.released).toEqual({});

        // The repeat runs at its next time, in its own conversation.
        await agent.advance(30 * 60_000);
        expect(agent.sent.at(-1)).toEqual({ chatId: CHAT, text: "Soil is fine." });
        expect((await userTexts(harness, cobot)).at(-1)).toMatch(/Check the soil/);
      } finally {
        await agent.close();
      }
    }));

  it("keeps held reminders while paused or archived again, and a later start sends them", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, said("Watering now, late."));
      try {
        const { harness } = agent;
        const { bot } = await gardenBot(harness);
        await remind(harness, bot, {
          id: "reminder:once",
          instruction: "Water",
          first: clock.now + 60_000,
        });
        await archive(harness, bot);
        await agent.advance(60_000);
        const held = async () => (await harness.snapshot(Bots, ctx))?.held?.map(({ id }) => id);
        expect(await held()).toEqual(["reminder:once"]);

        // Paused (`MIPI_PAUSED`): restore brings the bot back, and its reminder waits.
        await harness.commit(async (tx) => {
          (await tx.doc(Spend)).paused = true;
        }, ctx);
        expect(await restore(harness, bot)).toBe(0);
        expect(await held()).toEqual(["reminder:once"]);
        expect(await harness.commit((tx) => isArchived(tx, bot), ctx)).toBe(false);

        // Archived again before it went: a later start leaves it for the next restore.
        await harness.commit(async (tx) => {
          (await tx.doc(Spend)).paused = false;
        }, ctx);
        await archive(harness, bot);
        expect(await replayHeld(harness, [bot], clock.now, ctx)).toBe(0);
        expect(await replayHeld(harness, undefined, clock.now, ctx)).toBe(0);
        expect(await held()).toEqual(["reminder:once"]);

        // Restored while paused, then a start without the pause sends it, once.
        await harness.commit(async (tx) => {
          (await tx.doc(Spend)).paused = true;
        }, ctx);
        await restore(harness, bot);
        await harness.commit(async (tx) => {
          (await tx.doc(Spend)).paused = false;
        }, ctx);
        expect(await replayHeld(harness, undefined, clock.now, ctx)).toBe(1);
        await agent.settle();
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Watering now, late." }]);
        expect(await held()).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("says an archived bot keeps its name", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const { bot } = await gardenBot(harness);
        await archive(harness, bot);
        const bots = (await harness.snapshot(Bots, ctx))!;
        expect(botNameRefusal(bots, "garden")).toBe(
          "There is already an archived bot named garden. Restore it or pick another name.",
        );
      } finally {
        await agent.close();
      }
    }));

  it("doesn't take back a door bound elsewhere while its bot was archived", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const { bot } = await gardenBot(harness);
        const { mainId } = (await harness.snapshot(Bots, ctx))!;
        await archive(harness, bot);
        expect(await bound(harness)).toBe(mainId);
        // `/bot MiPi`, as the owner chose it.
        await harness.commit((tx) => bindChannel(tx, TG, mainId as ConversationId), ctx);
        await restore(harness, bot);
        expect(await bound(harness)).toBe(mainId);
      } finally {
        await agent.close();
      }
    }));

  it("never archives or restores MiPi, nor archives a chat from before bots", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const { mainId } = (await harness.snapshot(Bots, ctx))!;
        const main = mainId as ConversationId;
        await expect(harness.commit((tx) => archiveBot(tx, main, clock.now), ctx)).rejects.toThrow(
          "MiPi can't be archived.",
        );
        await expect(harness.commit((tx) => restoreBot(tx, main, PROFILES), ctx)).rejects.toThrow(
          "MiPi can't be restored.",
        );
        const chat = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
        await expect(
          harness.commit((tx) => archiveBot(tx, chat.id, clock.now), ctx),
        ).rejects.toThrow("Only a bot or a cobot can be archived.");
        // A live chat isn't archived, so there's nothing to restore.
        await expect(
          harness.commit((tx) => restoreBot(tx, chat.id, PROFILES), ctx),
        ).rejects.toThrow("Only an archived chat can be restored.");
        expect(await harness.commit((tx) => isArchived(tx, main), ctx)).toBe(false);
      } finally {
        await agent.close();
      }
    }));

  it("runs a chat-from-before-bots reminder in MiPi, and counts it active", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, said("Stretched."));
      try {
        const { harness } = agent;
        const { mainId } = (await harness.snapshot(Bots, ctx))!;
        // As `ensureBots` leaves a chat from before bots: no kind, archived, in the index.
        const chat = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
        await harness.commit(async (tx) => {
          (await tx.doc(ConversationMeta, chat.id)).archivedAt = clock.now;
          const bots = await tx.doc(Bots);
          bots.archived = { ...bots.archived, [String(chat.id)]: clock.now };
        }, ctx);
        expect(await harness.commit((tx) => routeSchedule(tx, chat.id), ctx)).toEqual({
          kind: "run",
          conversationId: mainId,
        });
        await harness.commit(
          (tx) =>
            tx.createTask(
              ScheduledReminder,
              {
                id: "reminder:old",
                conversationId: chat.id,
                instruction: "Stretch",
                zone: ZONE,
                first: clock.now + 60_000,
                // Its own transcript: it follows the reminder to MiPi's.
                destination: { kind: "web", conversationId: chat.id },
              },
              { ownership: { kind: "conversation" }, conversationId: chat.id, background: true },
            ),
          ctx,
        );
        const status = await readHeartbeat(
          harness,
          { exec: () => ({ toArray: () => [] }) } as never,
          [readSchedules],
          clock.now,
        );
        expect(status).toMatchObject({ activeSchedules: 1, archivedSchedules: 0 });
        await agent.advance(60_000);
        expect((await userTexts(harness, mainId!)).at(-1)).toMatch(/Stretch/);
        expect(await userTexts(harness, chat.id)).toEqual([]);
        expect((await harness.snapshot(Bots, ctx))?.held ?? []).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("restores a cobot only with its bot, or alone under a live bot (COD-201)", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const { bot, cobot } = await gardenBot(harness);
        expect(await archive(harness, bot)).toEqual([bot, cobot]);
        await expect(harness.commit((tx) => restoreBot(tx, cobot, PROFILES), ctx)).rejects.toThrow(
          "Restore Garden first.",
        );
        expect(await harness.commit((tx) => isArchived(tx, cobot), ctx)).toBe(true);
        await restore(harness, bot);
        expect(await harness.commit((tx) => isArchived(tx, cobot), ctx)).toBe(false);
        // Live already: restoring it again restores nothing.
        expect(await harness.commit((tx) => restoreBot(tx, cobot, PROFILES), ctx)).toEqual({
          restored: [],
          conversations: [cobot],
        });
      } finally {
        await agent.close();
      }
    }));

  it("archives a cobot alone, and keeps it archived through its bot's later archive and restore (COD-233)", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        const { harness } = agent;
        const { bot, cobot } = await gardenBot(harness);
        // Alone: its bot stays live, and still reaches the chat bound to it.
        expect(await archive(harness, cobot)).toEqual([cobot]);
        expect(await harness.commit((tx) => isArchived(tx, bot), ctx)).toBe(false);
        expect(await bound(harness)).toBe(bot);
        // Archived already: nothing more.
        expect(await archive(harness, cobot)).toEqual([]);
        // Later, the bot: only the bot, since the cobot isn't live. Restoring the bot leaves the cobot as it was.
        await agent.advance(1000);
        expect(await archive(harness, bot)).toEqual([bot]);
        await restore(harness, bot);
        expect(await harness.commit((tx) => isArchived(tx, bot), ctx)).toBe(false);
        expect(await harness.commit((tx) => isArchived(tx, cobot), ctx)).toBe(true);
        // Then restored on its own, under its live bot.
        expect(await harness.commit((tx) => restoreBot(tx, cobot, PROFILES), ctx)).toEqual({
          restored: [cobot],
          conversations: [cobot],
        });
        expect(await harness.commit((tx) => isArchived(tx, cobot), ctx)).toBe(false);
      } finally {
        await agent.close();
      }
    }));

  it("restores a chat from before bots as a cobot under MiPi, and runs its reminders in it (COD-201)", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, said("Stretched."));
      try {
        const { harness } = agent;
        const { mainId, names } = (await harness.snapshot(Bots, ctx))!;
        // As `ensureBots` leaves a chat from before bots, on the relay's old profile.
        const chat = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
        await harness.commit(async (tx) => {
          const meta = await tx.doc(ConversationMeta, chat.id);
          meta.archivedAt = clock.now;
          meta.title = "Morning stretches and a very long title that runs on";
          meta.profile = "pidu";
          const bots = await tx.doc(Bots);
          bots.archived = { ...bots.archived, [String(chat.id)]: clock.now };
        }, ctx);
        await harness.commit(
          (tx) =>
            tx.createTask(
              ScheduledReminder,
              {
                id: "reminder:old",
                conversationId: chat.id,
                instruction: "Stretch",
                zone: ZONE,
                first: clock.now + 60_000,
                destination: { kind: "web", conversationId: chat.id },
              },
              { ownership: { kind: "conversation" }, conversationId: chat.id, background: true },
            ),
          ctx,
        );
        expect(await harness.commit((tx) => restoreBot(tx, chat.id, PROFILES), ctx)).toEqual({
          restored: [chat.id],
          conversations: [chat.id],
        });
        const meta = await harness.snapshot(ConversationMeta, chat.id, ctx);
        expect(meta).toMatchObject({
          kind: "cobot",
          bot: mainId,
          name: "Morning stretches and a very long title…",
          profile: "default",
        });
        expect(meta?.archivedAt).toBeUndefined();
        expect([...(meta?.name ?? "")].length).toBeLessThanOrEqual(40);
        const bots = (await harness.snapshot(Bots, ctx))!;
        // Out of the bot name index and the archive index.
        expect(bots.names).toEqual(names);
        expect(bots.archived?.[String(chat.id)]).toBeUndefined();
        expect(await harness.commit((tx) => routeSchedule(tx, chat.id), ctx)).toEqual({
          kind: "run",
          conversationId: chat.id,
        });
        await agent.advance(60_000);
        expect((await userTexts(harness, chat.id)).at(-1)).toMatch(/Stretch/);
        expect(await userTexts(harness, mainId as ConversationId)).toEqual([]);
        // A cobot under a live bot now: restoring it again restores nothing.
        expect(await harness.commit((tx) => restoreBot(tx, chat.id, PROFILES), ctx)).toEqual({
          restored: [],
          conversations: [chat.id],
        });
      } finally {
        await agent.close();
      }
    }));
});
