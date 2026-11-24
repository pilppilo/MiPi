/**
 * A test agent for scheduled runs (M6): MiPi's real harness options, a faux model, Durable Object SQLite, and a test
 * clock the Harness and the Telegram door share. With `onWake`, the Harness keeps no timer of its own; a test moves the
 * clock and calls `resume()`, as the alarm would.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ChannelBindings } from "../src/agent/conversations.ts";
import { createHarnessOptions } from "../src/agent/harness.ts";
import { ModelList } from "../src/agent/model-list.ts";
import { isTelegramChange, TelegramChannelRuntime } from "../src/agent/telegram.ts";
import { type ReminderInput, ScheduledReminder } from "../src/tools/reminder-task.ts";
import type { TelegramInbound } from "../src/lib/telegram-update.ts";

export const ctx = BACKGROUND_CONTEXT;
export const CHAT = 4242;
export const ZONE = "America/Chicago";

export type Storage = Awaited<ReturnType<typeof openDurableObjectSqliteStorage>>;

let objects = 0;
export const inObject = (test: (storage: () => Promise<Storage>) => Promise<void>): Promise<void> =>
  runInDurableObject(
    env.AGENT.getByName(`agent-${++objects}-${Date.now()}`),
    async (_instance, state) => {
      // Let MipiAgent finish opening its own harness before opening one beside it.
      await state.blockConcurrencyWhile(async () => {});
      await test(() => openDurableObjectSqliteStorage(state.storage));
    },
  );

export const clock = { now: Date.now() };

export interface Agent {
  readonly harness: Harness;
  readonly channel: TelegramChannelRuntime;
  readonly sent: Array<{ chatId: number; text: string }>;
  /** Moves the clock, then does what the alarm does: resume, wait for turns, run the door. */
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  restart(responses?: readonly FauxResponseStep[]): Promise<Agent>;
  close(): Promise<void>;
}

export async function openAgent(
  storage: () => Promise<Storage>,
  responses: readonly FauxResponseStep[] = [],
  /** The Telegram door's `/usage` readout (M9); unset, as in a door without one. */
  usage?: () => Promise<string>,
): Promise<Agent> {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    await storage(),
    {
      ...createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
      now: () => clock.now,
      // The alarm's job here is the test's: no timers.
      onWake: () => {},
    },
    ctx,
  );
  const sent: Array<{ chatId: number; text: string }> = [];
  /** What the door reported: `settle()` fails on any. */
  const reports: string[] = [];
  let calls = 0;
  const channel = new TelegramChannelRuntime({
    harness,
    owner: "jerome",
    timeZone: ZONE,
    profile: "default",
    version: "0.0.0-test",
    modelList: new ModelList(async () => []),
    send: async (chatId, message) => {
      sent.push({ chatId, text: message.text });
      return { kind: "sent", messageId: ++calls };
    },
    armAlarm: async () => {},
    onWakeChange: () => {},
    ...(usage === undefined ? {} : { usage }),
    report: (message, error) => {
      reports.push(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    now: () => clock.now,
  });
  // As the Durable Object does: a reminder records Telegram answers in the door's document.
  harness.observeCommits({
    advance: (publication) => {
      if (isTelegramChange(publication)) channel.refresh();
    },
    end: () => {},
  });
  harness.resume();
  await channel.start();
  const agent: Agent = {
    harness,
    channel,
    sent,
    settle: async () => {
      for (let rounds = 0; rounds < 50; rounds++) {
        await harness.waitForIdle(ctx);
        await channel.recover();
        const wake = channel.wake();
        if (wake.at !== undefined) clock.now = Math.max(clock.now, wake.at);
        else if (!wake.active) break;
        // Let a reminder's commit reach the door before looking again.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (reports.length > 0) throw new Error(`Reported: ${reports.splice(0).join("; ")}`);
    },
    advance: async (ms) => {
      clock.now += ms;
      harness.resume();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await agent.settle();
    },
    restart: async (next = []) => {
      await agent.close();
      return openAgent(storage, next, usage);
    },
    close: async () => {
      channel.close();
      await harness.close(ctx);
    },
  };
  return agent;
}

export const text = (updateId: number, message: string): TelegramInbound => ({
  kind: "text",
  updateId,
  chatId: CHAT,
  text: message,
});

export const said = (...texts: string[]): FauxResponseStep[] =>
  texts.map((reply) => fauxAssistantMessage([fauxText(reply)]));

export const schedules = (args: Parameters<typeof fauxToolCall>[1]): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall("schedule", args)], { stopReason: "toolUse" });

export const reminders = async (harness: Harness) =>
  (await harness.inspect(ctx)).tasks
    .filter(({ record }) => record.kind === ScheduledReminder.definition.name)
    .map(({ record }) => ({
      input: record.input as ReminderInput,
      checkpoint: (record.state as { checkpoint?: Record<string, unknown> }).checkpoint,
    }));

export const userTexts = async (harness: Harness, conversationId: number): Promise<string[]> => {
  const conversation = await harness.conversation(conversationId as never, ctx);
  const page = await conversation!.entries({ order: "ascending" }, 100, undefined, ctx);
  return page.items.flatMap((entry) => {
    const message = entry.model?.[0];
    if (message?.role !== "user") return [];
    return [typeof message.content === "string" ? message.content : ""];
  });
};

export const boundId = (harness: Harness) =>
  harness.commit(
    async (tx) => (await tx.doc(ChannelBindings, `tg:${CHAT}`, null)).conversationId!,
    ctx,
  );
