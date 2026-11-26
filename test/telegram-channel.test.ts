/**
 * The Telegram door inside the agent: admission, receipts, commands, replies and the outbox, on a real harness with a
 * faux model over Durable Object SQLite. A "restart" closes the harness and the channel and opens new ones on the same
 * storage. The outbox's clock is the test's, so pacing and retry waits pass without sleeping.
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
} from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { createBot, renameBot } from "../src/agent/bots.ts";
import { Bots, ChannelBindings, ConversationMeta } from "../src/agent/conversations.ts";
import { stampInput } from "../src/agent/stamp.ts";
import { webRequest } from "../src/doors/web/index.ts";
import { composeMipi } from "../src/agent/composition.ts";
import { bindLimitRecorder } from "../src/agent/limits.ts";
import { ProviderUsageCache } from "../src/agent/providers.ts";
import { BUILT_IN_EXTENSIONS } from "../src/extensions/builtins.ts";
import { goLimit } from "../src/extensions/optional/opencode-go/limit.ts";
import { AnswerSettlement } from "../src/agent/answers.ts";
import { earliestWake } from "../src/agent/wake-sources.ts";
import { botsOnModel, PROFILES } from "./mipi.ts";
import { ModelList } from "../src/agent/model-list.ts";
import { goModelListSource } from "../src/extensions/optional/opencode-go/models.ts";
import {
  BATCH_MAX_MESSAGES,
  BATCH_MAX_UNITS,
  BUSY_REPLY,
  HELP_TEXT,
  NON_TEXT_HINT,
  RECEIPT_WINDOW_MS,
  RECEIPTS_KEPT,
  BATCH_WINDOW_MS,
  isTelegramChange,
  TelegramChannel,
  TelegramChannelRuntime,
  type TelegramChannelState,
  addReceipt,
} from "../src/doors/telegram/channel.ts";
import { type SendResult, TelegramOutbox } from "../src/doors/telegram/outbox.ts";
import type { TelegramMessage } from "../src/doors/telegram/bot-api.ts";
import type { TelegramInbound } from "../src/doors/telegram/update.ts";

const ctx = BACKGROUND_CONTEXT;
const CHAT = 4242;

type Sent = { readonly chatId: number; readonly text: string };
type SendBehaviour = (
  chatId: number,
  message: TelegramMessage,
  call: number,
) => Promise<SendResult>;

const delivered: SendBehaviour = async (_chatId, _text, call) => ({
  kind: "sent",
  messageId: 1000 + call,
});

interface Agent {
  readonly harness: Harness;
  readonly channel: TelegramChannelRuntime;
  /** Core's answer settlement, which turns the door's settled inputs into replies (`answers.ts`). */
  readonly answers: AnswerSettlement;
  readonly sent: Sent[];
  /** Waits for every turn, then runs what the alarm would. */
  settle(): Promise<void>;
  restart(options?: AgentOptions): Promise<Agent>;
  close(): Promise<void>;
}

interface AgentOptions {
  readonly responses?: readonly FauxResponseStep[];
  readonly planResetAt?: number;
  readonly send?: SendBehaviour;
  readonly modelIds?: () => Promise<string[]>;
  readonly onSubmitted?: (conversationId: number, text: string) => Promise<void>;
}

type Storage = Awaited<ReturnType<typeof openDurableObjectSqliteStorage>>;

/** Runs `test` in a Durable Object of its own, with a way to open its storage again after a "restart". */
let objects = 0;
const inObject = (test: (storage: () => Promise<Storage>) => Promise<void>): Promise<void> =>
  runInDurableObject(
    env.AGENT.getByName(`telegram-${++objects}-${Date.now()}`),
    async (_instance, state) => {
      // Let MipiAgent finish opening its own harness before opening one beside it.
      await state.blockConcurrencyWhile(async () => {});
      await test(() => openDurableObjectSqliteStorage(state.storage));
    },
  );

const clock = { now: Date.now() };

async function openAgent(
  storage: () => Promise<Storage>,
  options: AgentOptions = {},
): Promise<Agent> {
  const faux = fauxProvider();
  faux.setResponses([...(options.responses ?? [])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const composition = composeMipi({
    models,
    model: { provider: "faux", modelId: "faux-1" },
    ...(options.planResetAt === undefined
      ? {}
      : {
          extensions: [
            ...BUILT_IN_EXTENSIONS,
            {
              name: "faux-limit",
              tier: "optional",
              providers: [{ provider: "faux", limit: { label: "OpenCode Go", parse: goLimit } }],
            },
          ],
        }),
  });
  const harness = await Harness.open(await storage(), composition.options, ctx);
  await botsOnModel(harness, { provider: "faux", modelId: "faux-1" });
  const resetsAt = options.planResetAt;
  if (resetsAt !== undefined) {
    bindLimitRecorder(
      composition.limitExtension,
      harness,
      composition.providers,
      new ProviderUsageCache([
        {
          provider: "faux",
          label: "OpenCode Go",
          read: async () => ({
            provider: "faux",
            label: "OpenCode Go",
            status: "ok",
            windows: [{ name: "monthly", limited: true, percent: 100, resetsAt }],
          }),
        },
      ]),
      () => clock.now,
    );
  }
  const sent: Sent[] = [];
  /** What this agent's channel reported: `settle()` fails on anything but a refused send. */
  const reports: string[] = [];
  const behaviour = options.send ?? delivered;
  let calls = 0;
  const channel = new TelegramChannelRuntime({
    harness,
    owner: "jerome",
    timeZone: "America/Chicago",
    profile: "default",
    profiles: PROFILES,
    version: "0.0.0-test",
    modelList: new ModelList([
      {
        ...goModelListSource(() => undefined),
        liveIds: options.modelIds ?? (async () => ["deepseek-v4.1-flash"]),
      },
    ]),
    send: async (chatId, message) => {
      calls += 1;
      const result = await behaviour(chatId, message, calls);
      if (result.kind === "sent") sent.push({ chatId, text: message.text });
      return result;
    },
    delivery: composition.connectors.delivery,
    armAlarm: async () => {},
    ...(options.onSubmitted === undefined ? {} : { onSubmitted: options.onSubmitted }),
    onWakeChange: () => {},
    report: (message, error) => {
      reports.push(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    now: () => clock.now,
  });
  const answers = new AnswerSettlement({
    harness,
    connectors: composition.connectors,
    providers: composition.providers,
    onQueued: () => channel.refresh(),
    onWakeChange: () => {},
    report: (message, error) => {
      reports.push(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    now: () => clock.now,
  });
  // As the Durable Object does: each looks again after the commits it observes.
  harness.observeCommits({
    advance: (publication) => {
      if (answers.observes(publication)) answers.refresh();
      if (isTelegramChange(publication)) channel.refresh();
    },
    end: () => {},
  });
  await answers.start();
  await channel.start();
  const agent: Agent = {
    harness,
    channel,
    answers,
    sent,
    settle: async () => {
      // Turns, then what the alarm would do; let window deadlines, pacing and retry waits pass on the test clock.
      for (let rounds = 0; rounds < 100; rounds++) {
        await harness.waitForIdle(ctx);
        await answers.reconcile();
        await channel.recover();
        const wake = earliestWake(answers.wake(), channel.wake());
        if (wake.at !== undefined) clock.now = Math.max(clock.now, wake.at);
        else if (!wake.active) break;
      }
      // Refused sends are reported on purpose; anything else is a failure.
      const unexpected = reports
        .splice(0)
        .filter((report) => !report.startsWith("A Telegram send"));
      if (unexpected.length > 0) throw new Error(`Reported: ${unexpected.join("; ")}`);
    },
    restart: async (next = {}) => {
      await agent.close();
      return openAgent(storage, next);
    },
    close: async () => {
      answers.close();
      channel.close();
      await harness.close(ctx);
    },
  };
  return agent;
}

const text = (updateId: number, message: string, chatId = CHAT): TelegramInbound => ({
  kind: "text",
  updateId,
  chatId,
  text: message,
});

const command = (
  updateId: number,
  name: Extract<TelegramInbound, { kind: "command" }>["command"],
  argument = "",
): TelegramInbound => ({ kind: "command", updateId, chatId: CHAT, command: name, argument });

/** Ends a chat's idle window now, so its messages are submitted (as the alarm would at the deadline). */
const endWindow = async (agent: Agent): Promise<void> => {
  clock.now += BATCH_WINDOW_MS;
  await agent.channel.flushDue();
};

const answers = (...texts: string[]): FauxResponseStep[] =>
  texts.map((reply) => fauxAssistantMessage([fauxText(reply)]));

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const channelState = (harness: Harness): Promise<TelegramChannelState> =>
  harness.commit(async (tx) => plain(await tx.doc(TelegramChannel)), ctx);

const outbox = (harness: Harness) =>
  harness.commit(async (tx) => plain(await tx.doc(TelegramOutbox)), ctx);

const boundId = (harness: Harness, chatId = CHAT) =>
  harness.commit(
    async (tx) => (await tx.doc(ChannelBindings, `tg:${chatId}`, null)).conversationId,
    ctx,
  );

const userTexts = async (harness: Harness, conversationId: number): Promise<string[]> => {
  const conversation = await harness.conversation(conversationId as never, ctx);
  const page = await conversation!.entries({ order: "ascending" }, 100, undefined, ctx);
  return page.items.flatMap((entry) => {
    const message = entry.model?.[0];
    if (message?.role !== "user") return [];
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return [content.replace(/^\[[^\]]*\]\n/, "")];
  });
};

describe("Telegram admission", () => {
  it("answers an allowlisted message once, in its chat, stamped like every door", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, { responses: answers("Hello back") });
      try {
        await agent.channel.admit(text(1, "Hello"));
        await agent.settle();
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Hello back" }]);
        const conversationId = (await boundId(agent.harness))!;
        expect(await userTexts(agent.harness, conversationId)).toEqual(["Hello"]);
        const conversation = await agent.harness.conversation(conversationId as never, ctx);
        const page = await conversation!.entries({ order: "ascending" }, 10, undefined, ctx);
        const first = page.items[0]!.model![0]!;
        expect(typeof first.content === "string" ? first.content : "").toMatch(
          /^\[jerome · .+\]\nHello$/,
        );
        expect(await channelState(agent.harness)).toMatchObject({ inputs: [], commands: [] });
        expect(agent.channel.wake()).toEqual({ active: false });
      } finally {
        await agent.close();
      }
    }));

  it("ignores a replay before and after the answer, and across a restart", () =>
    inObject(async (storage) => {
      let agent = await openAgent(storage, { responses: answers("Once") });
      try {
        await agent.channel.admit(text(7, "Only once"));
        await agent.channel.admit(text(7, "Only once"));
        await agent.settle();
        await agent.channel.admit(text(7, "Only once"));
        agent = await agent.restart();
        await agent.channel.admit(text(7, "Only once"));
        await agent.settle();
        expect(agent.sent).toEqual([]);
        const conversationId = (await boundId(agent.harness))!;
        expect(await userTexts(agent.harness, conversationId)).toEqual(["Only once"]);
        expect((await outbox(agent.harness)).replies).toHaveLength(1);
      } finally {
        await agent.close();
      }
    }));

  it("keeps replays out of the new conversation after /new, and /new itself runs once", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, { responses: answers("First") });
      try {
        await agent.channel.admit(text(1, "Before"));
        await agent.settle();
        const before = (await boundId(agent.harness))!;
        await agent.channel.admit(command(2, "new"));
        const after = (await boundId(agent.harness))!;
        expect(after).not.toBe(before);
        // Telegram retries both updates.
        await agent.channel.admit(command(2, "new"));
        await agent.channel.admit(text(1, "Before"));
        await agent.settle();
        expect(await boundId(agent.harness)).toBe(after);
        expect(await userTexts(agent.harness, after)).toEqual([]);
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual([
          "First",
          "Started a new conversation.",
        ]);
      } finally {
        await agent.close();
      }
    }));

  it("sends the answer to the chat the message came from, even after /new rebinds it", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const slow: FauxResponseStep = async () => {
        await release.promise;
        return fauxAssistantMessage([fauxText("Late answer")]);
      };
      const agent = await openAgent(storage, { responses: [slow] });
      try {
        await agent.channel.admit(text(1, "Think about it"));
        await agent.channel.admit(command(2, "new"));
        release.resolve();
        await agent.settle();
        expect(agent.sent).toEqual([
          { chatId: CHAT, text: "Started a new conversation." },
          { chatId: CHAT, text: "Late answer" },
        ]);
      } finally {
        await agent.close();
      }
    }));

  it("recovers an answer committed before its reply was queued", () =>
    inObject(async (storage) => {
      let agent = await openAgent(storage, { responses: answers("Recovered") });
      try {
        await agent.channel.admit(text(1, "Hi"));
        await endWindow(agent);
        // The instance dies right after the answer commits: nothing turned it into a reply yet.
        agent.answers.close();
        agent.channel.close();
        await agent.harness.waitForIdle(ctx);
        expect((await outbox(agent.harness)).replies).toEqual([]);
        agent = await agent.restart();
        await agent.settle();
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Recovered" }]);
      } finally {
        await agent.close();
      }
    }));

  it("recovers a plan-limit notice with its reset time after a restart", () =>
    inObject(async (storage) => {
      const planResetAt = clock.now + 60 * 60_000;
      let agent = await openAgent(storage, {
        planResetAt,
        responses: [
          fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 GoUsageLimitError" }),
        ],
      });
      try {
        await agent.channel.admit(text(1, "Hi"));
        agent.answers.close();
        await endWindow(agent);
        agent.channel.close();
        await agent.harness.waitForIdle(ctx);
        expect((await outbox(agent.harness)).replies).toEqual([]);
        agent = await agent.restart({ planResetAt });
        await agent.settle();
        expect(agent.sent).toEqual([
          {
            chatId: CHAT,
            text: expect.stringMatching(
              /^OpenCode Go's usage limit is reached; it resets at .+\.$/,
            ),
          },
        ]);
      } finally {
        await agent.close();
      }
    }));

  it("tells the chat when a message ends without an answer", () =>
    inObject(async (storage) => {
      const failing: FauxResponseStep = () =>
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider down" });
      const agent = await openAgent(storage, {
        responses: [failing, failing, failing, failing, failing, failing],
      });
      try {
        await agent.channel.admit(text(1, "Hello?"));
        await agent.settle();
        expect(agent.sent).toHaveLength(1);
        expect(agent.sent[0]!.text).toMatch(
          /^I couldn't answer that \(.+\)\. Send it again to retry\.$/,
        );
      } finally {
        await agent.close();
      }
    }));

  it("answers a photo or other non-text message with a hint, once", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        await agent.channel.admit({ kind: "non-text", updateId: 3, chatId: CHAT });
        await agent.channel.admit({ kind: "non-text", updateId: 3, chatId: CHAT });
        await agent.settle();
        expect(agent.sent).toEqual([{ chatId: CHAT, text: NON_TEXT_HINT }]);
      } finally {
        await agent.close();
      }
    }));
});

/** Makes a purpose bot as the web's `bot.create` does. */
const makeBot = (harness: Harness, name: string, purpose: string): Promise<number> =>
  harness.commit(
    (tx) =>
      createBot(
        tx,
        { kind: "bot", name, purpose, profile: "default", createdBy: "owner" },
        PROFILES,
      ),
    ctx,
  );

const mainId = async (harness: Harness): Promise<number> =>
  (await harness.commit(async (tx) => (await tx.doc(Bots)).mainId, ctx))!;

describe("Telegram /bot (COD-197)", () => {
  it("lists the bots, switches by whole name in any case, refuses others, and keeps the choice across a restart", () =>
    inObject(async (storage) => {
      let agent = await openAgent(storage, { responses: answers("Hi from the digest") });
      try {
        const main = await mainId(agent.harness);
        const digest = await makeBot(
          agent.harness,
          "Daily Digest",
          "Summarise my day.\nKeep it short.",
        );
        await agent.channel.admit(command(1, "bot"));
        await agent.channel.admit(command(2, "bot", "nope"));
        await agent.channel.admit(command(3, "bot", "daily DIGEST"));
        await agent.channel.admit(command(4, "bot", "Daily Digest"));
        await agent.settle();
        const [listed, unknown, switched, already] = agent.sent.map(({ text: sent }) => sent);
        const list =
          "Bots:\n▸ MiPi\n• Daily Digest — Summarise my day.\n\nSwitch with /bot <name>.";
        expect(listed).toBe(list);
        expect(unknown).toBe(`There's no bot named nope.\n\n${list}`);
        expect(switched).toBe("Now talking to Daily Digest.");
        expect(already).toBe("This chat is already talking to Daily Digest.");
        expect(await agent.harness.snapshot(ChannelBindings, `tg:${CHAT}`, ctx)).toEqual({
          conversationId: digest,
          bots: true,
        });

        // A restart keeps the choice: the next message goes to the digest, not MiPi.
        agent = await agent.restart({ responses: answers("Hi from the digest") });
        await agent.channel.admit(text(5, "hello"));
        await agent.settle();
        expect(await userTexts(agent.harness, digest)).toEqual(["hello"]);
        expect(await userTexts(agent.harness, main)).toEqual([]);

        // A renamed MiPi answers to its new name; a chat on a conversation of its own (/new) says so.
        await agent.harness.commit((tx) => renameBot(tx, main as never, "Mia"), ctx);
        await agent.channel.admit(command(6, "new"));
        await agent.channel.admit(command(7, "bot"));
        await agent.channel.admit(command(8, "bot", "mia"));
        await agent.settle();
        const [, , ownChat, toMia] = agent.sent.slice(-4).map(({ text: sent }) => sent);
        expect(ownChat).toBe(
          "Bots:\n• Mia\n• Daily Digest — Summarise my day.\n\n" +
            "This chat is on a conversation of its own (from /new).\n\nSwitch with /bot <name>.",
        );
        expect(toMia).toBe("Now talking to Mia.");
        expect(await boundId(agent.harness)).toBe(main);
      } finally {
        await agent.close();
      }
    }));

  it("sends a waiting window to the bot it was written to before switching", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, { responses: answers("MiPi here", "Groceries here") });
      try {
        const main = await mainId(agent.harness);
        const groceries = await makeBot(agent.harness, "Groceries", "Keep the shopping list.");
        await agent.channel.admit(text(1, "for mipi"));
        await agent.channel.admit(command(2, "bot", "groceries"));
        expect((await channelState(agent.harness)).staged ?? []).toEqual([]);
        await agent.channel.admit(text(3, "for groceries"));
        await agent.settle();
        expect(await userTexts(agent.harness, main)).toEqual(["for mipi"]);
        expect(await userTexts(agent.harness, groceries)).toEqual(["for groceries"]);
        expect(agent.sent.map(({ text: sent }) => sent).sort()).toEqual(
          ["Groceries here", "MiPi here", "Now talking to Groceries."].sort(),
        );
      } finally {
        await agent.close();
      }
    }));

  it("shares one conversation between Telegram and the web on the same bot, both ways", () =>
    inObject(async (storage) => {
      // What the model got on each turn.
      const seen: string[][] = [];
      const reply =
        (text: string): FauxResponseStep =>
        (context) => {
          seen.push(
            context.messages.flatMap((message) =>
              message.role === "user" && typeof message.content === "string"
                ? [message.content]
                : [],
            ),
          );
          return fauxAssistantMessage([fauxText(text)]);
        };
      const agent = await openAgent(storage, {
        responses: [reply("Milk noted."), reply("Eggs noted."), reply("Milk and eggs.")],
      });
      try {
        const groceries = await makeBot(agent.harness, "Groceries", "Keep the shopping list.");
        await agent.channel.admit(command(1, "bot", "Groceries"));
        // Telegram, then the web (as the web door's `prompt.submit` does), then Telegram again.
        await agent.channel.admit(text(2, "Add milk"));
        await agent.settle();
        const conversation = (await agent.harness.conversation(groceries as never, ctx))!;
        await (
          await conversation.submit(
            {
              type: "input",
              content: stampInput("jerome", "Add eggs", "America/Chicago", clock.now),
              requestId: webRequest("web-eggs"),
            },
            ctx,
          )
        ).wait(ctx);
        await agent.settle();
        await agent.channel.admit(text(3, "What's on the list?"));
        await agent.settle();

        // One transcript, both doors' messages in order, as the web shows it.
        expect(await userTexts(agent.harness, groceries)).toEqual([
          "Add milk",
          "Add eggs",
          "What's on the list?",
        ]);
        // The last Telegram turn saw the web's message: one context.
        expect(seen.at(-1)!.map((content) => content.replace(/^\[[^\]]*\]\n/, ""))).toEqual([
          "Add milk",
          "Add eggs",
          "What's on the list?",
        ]);
        // Telegram got the answers to its own messages; the web's answer stayed in the transcript.
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual([
          "Now talking to Groceries.",
          "Milk noted.",
          "Milk and eggs.",
        ]);
      } finally {
        await agent.close();
      }
    }));
});

describe("Telegram commands", () => {
  it("answers /start and /version without the model", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        await agent.channel.admit(command(1, "start"));
        await agent.channel.admit(command(2, "version"));
        await agent.settle();
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual([HELP_TEXT, "MiPi 0.0.0-test"]);
      } finally {
        await agent.close();
      }
    }));

  it("shows, validates and sets the profile", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage);
      try {
        // The chat reaches MiPi first, which always runs on `main` (COD-197).
        await agent.channel.admit(command(1, "profile"));
        await agent.channel.admit(command(2, "profile", "empty"));
        await agent.channel.admit(command(3, "new"));
        await agent.channel.admit(command(4, "profile"));
        await agent.channel.admit(command(5, "profile", "nope"));
        await agent.channel.admit(command(6, "profile", "main"));
        await agent.channel.admit(command(7, "profile", "empty"));
        await agent.settle();
        const [mipi, kept, , shown, refused, onlyMipi, set] = agent.sent.map(
          ({ text: sent }) => sent,
        );
        expect(mipi).toMatch(/^Profile: main /);
        expect(kept).toBe("MiPi always runs on the main profile.");
        expect(shown).toMatch(/^Profile: default /);
        expect(shown).toMatch(/default, empty\.$/);
        expect(refused).toBe("nope is not a profile. Pick one of: default, empty.");
        expect(onlyMipi).toBe("Only MiPi runs on the main profile.");
        expect(set).toBe("Profile set to empty.");
        const conversationId = (await boundId(agent.harness))!;
        const profile = await agent.harness.commit(
          async (tx) => (await tx.doc(ConversationMeta, conversationId as never)).profile,
          ctx,
        );
        expect(profile).toBe("empty");
      } finally {
        await agent.close();
      }
    }));

  it("acknowledges /model <id> before the slow model list answers, then sets or refuses it", () =>
    inObject(async (storage) => {
      const list = Promise.withResolvers<string[]>();
      const agent = await openAgent(storage, { modelIds: () => list.promise });
      try {
        // Admission returns although the lookup hasn't.
        await agent.channel.admit(command(1, "model", "deepseek-v4.1-flash"));
        await agent.channel.admit(command(2, "model", "made-up-model"));
        expect((await channelState(agent.harness)).commands).toHaveLength(2);
        expect(agent.channel.wake().active).toBe(true);
        list.resolve(["deepseek-v4.1-flash"]);
        await agent.settle();
        const [set, refused] = agent.sent.map(({ text: sent }) => sent);
        expect(set).toBe("Model set to deepseek-v4.1-flash.");
        expect(refused).toMatch(/^made-up-model is not available/);
        const conversation = await agent.harness.conversation(
          (await boundId(agent.harness)) as never,
          ctx,
        );
        expect((await conversation!.agent(ctx)).model?.modelId).toBe("deepseek-v4.1-flash");
        expect((await channelState(agent.harness)).commands).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("answers a deferred /model after a restart, once", () =>
    inObject(async (storage) => {
      let agent = await openAgent(storage, { modelIds: () => new Promise(() => {}) });
      try {
        await agent.channel.admit(command(1, "model", "deepseek-v4.1-flash"));
        agent = await agent.restart();
        await agent.channel.admit(command(1, "model", "deepseek-v4.1-flash"));
        await agent.settle();
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual([
          "Model set to deepseek-v4.1-flash.",
        ]);
      } finally {
        await agent.close();
      }
    }));
});

describe("Telegram replies", () => {
  it("sends a reply longer than one message in order", () =>
    inObject(async (storage) => {
      const long = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
      expect(long.length).toBeGreaterThan(4096);
      const agent = await openAgent(storage, { responses: answers(long) });
      try {
        await agent.channel.admit(text(1, "Talk a lot"));
        await agent.settle();
        expect(agent.sent.length).toBeGreaterThan(1);
        for (const { text: sent } of agent.sent) expect(sent.length).toBeLessThanOrEqual(4096);
        expect(agent.sent.map(({ text: sent }) => sent).join(" ")).toBe(long);
      } finally {
        await agent.close();
      }
    }));

  it("keeps a confirmed first chunk and sends the rest after a restart between chunks", () =>
    inObject(async (storage) => {
      const long = `${"a".repeat(4000)}\n\n${"b".repeat(100)}`;
      let first: Agent | undefined;
      first = await openAgent(storage, {
        responses: answers(long),
        send: async (_chatId, _text, call) => {
          // The instance goes away right after Telegram confirmed chunk 1.
          if (call === 1) first!.channel.close();
          return { kind: "sent", messageId: call };
        },
      });
      let agent = first;
      try {
        await agent.channel.admit(text(1, "Two parts"));
        await agent.settle();
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["a".repeat(4000)]);
        agent = await agent.restart();
        await agent.settle();
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["b".repeat(100)]);
        const [reply] = (await outbox(agent.harness)).replies;
        expect(reply!.chunks.map(({ status }) => status)).toEqual(["sent", "sent"]);
      } finally {
        await agent.close();
      }
    }));

  it("tries a send cut off by a restart once more, and the whole reply arrives", () =>
    inObject(async (storage) => {
      const long = `${"a".repeat(4000)}\n\n${"b".repeat(100)}`;
      let agent = await openAgent(storage, {
        responses: answers(long),
        // The request never comes back: the instance dies while it is out.
        send: () => new Promise(() => {}),
      });
      try {
        await agent.channel.admit(text(1, "Two parts"));
        await endWindow(agent);
        await agent.harness.waitForIdle(ctx);
        await agent.answers.reconcile();
        void agent.channel.drain();
        await new Promise((resolve) => setTimeout(resolve, 20));
        agent = await agent.restart();
        await agent.settle();
        const [reply] = (await outbox(agent.harness)).replies;
        expect(reply!.chunks.map(({ status }) => status)).toEqual(["sent", "sent"]);
        expect(reply!.chunks[0]).toMatchObject({ ambiguousRetries: 1 });
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual([
          "a".repeat(4000),
          "b".repeat(100),
        ]);
      } finally {
        await agent.close();
      }
    }));

  it("ends a send whose retry is cut off too, skips the rest of that reply, and the chat moves on", () =>
    inObject(async (storage) => {
      const long = `${"a".repeat(4000)}\n\n${"b".repeat(100)}`;
      let agent = await openAgent(storage, {
        responses: answers(long),
        send: () => new Promise(() => {}),
      });
      try {
        await agent.channel.admit(text(1, "Two parts"));
        await endWindow(agent);
        await agent.harness.waitForIdle(ctx);
        await agent.answers.reconcile();
        void agent.channel.drain();
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Restarted, and its one retry is cut off as well.
        agent = await agent.restart({ send: () => new Promise(() => {}) });
        clock.now += 60_000;
        void agent.channel.drain();
        await new Promise((resolve) => setTimeout(resolve, 20));
        agent = await agent.restart({ responses: answers("Next one") });
        await agent.settle();
        const [cut] = (await outbox(agent.harness)).replies;
        expect(cut!.chunks.map(({ status }) => status)).toEqual([
          "delivery-unknown",
          "skipped-after-failure",
        ]);
        await agent.channel.admit(text(2, "Still there?"));
        await agent.settle();
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Next one" }]);
      } finally {
        await agent.close();
      }
    }));

  it("never sends one chunk twice from two drains at once", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const agent = await openAgent(storage, {
        responses: answers("Once"),
        send: async () => {
          calls += 1;
          await release.promise;
          return { kind: "sent", messageId: calls };
        },
      });
      try {
        await agent.channel.admit(text(1, "Hi"));
        await endWindow(agent);
        await agent.harness.waitForIdle(ctx);
        await agent.answers.reconcile();
        const first = agent.channel.drain();
        const second = agent.channel.drain();
        // An overlapping alarm, too, while the first request is out.
        const third = agent.channel.recover();
        await new Promise((resolve) => setTimeout(resolve, 20));
        release.resolve();
        await Promise.all([first, second, third]);
        expect(calls).toBe(1);
      } finally {
        release.resolve();
        await agent.close();
      }
    }));

  it("ends a reply refused for good (a revoked token, a blocked bot) without waking again", () =>
    inObject(async (storage) => {
      let calls = 0;
      const agent = await openAgent(storage, {
        responses: answers("Nobody hears this"),
        send: async () => {
          calls += 1;
          return { kind: "failed", reason: "403: Forbidden: bot was blocked by the user" };
        },
      });
      try {
        await agent.channel.admit(text(1, "Hi"));
        await agent.settle();
        await agent.channel.recover();
        expect(calls).toBe(1);
        const [reply] = (await outbox(agent.harness)).replies;
        expect(reply!.chunks[0]).toMatchObject({ status: "failed" });
        expect(agent.channel.wake()).toEqual({ active: false });
      } finally {
        await agent.close();
      }
    }));

  it("waits out a 429 and then sends", () =>
    inObject(async (storage) => {
      const attempts: number[] = [];
      const agent = await openAgent(storage, {
        responses: answers("Patience"),
        send: async (_chatId, _text, call) => {
          attempts.push(clock.now);
          return call === 1
            ? { kind: "retry", afterMs: 30_000, reason: "429: Too Many Requests" }
            : { kind: "sent", messageId: 9 };
        },
      });
      try {
        await agent.channel.admit(text(1, "Hi"));
        await agent.settle();
        expect(attempts).toHaveLength(2);
        expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(30_000);
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "Patience" }]);
      } finally {
        await agent.close();
      }
    }));
});

/** A faux reply that waits for `release`, so a turn can be kept running. */
const held =
  (release: Promise<void>, reply: string): FauxResponseStep =>
  async () => {
    await release;
    return fauxAssistantMessage([fauxText(reply)]);
  };

describe("Telegram formatting", () => {
  it("sends the model's markdown as HTML, and the plain source once when Telegram can't read it", () =>
    inObject(async (storage) => {
      const messages: TelegramMessage[] = [];
      const agent = await openAgent(storage, {
        responses: answers("**Sneeze.**"),
        send: async (_chatId, message, call) => {
          messages.push(message);
          return message.html === undefined
            ? { kind: "sent", messageId: call }
            : { kind: "markup", reason: "400: Bad Request: can't parse entities" };
        },
      });
      try {
        await agent.channel.admit(text(1, "Remind me"));
        await agent.settle();
        expect(messages).toEqual([
          { text: "**Sneeze.**", html: "<b>Sneeze.</b>" },
          { text: "**Sneeze.**" },
        ]);
        expect(agent.sent).toEqual([{ chatId: CHAT, text: "**Sneeze.**" }]);
      } finally {
        await agent.close();
      }
    }));

  it("splits a message Telegram finds too long and sends the halves in order", () =>
    inObject(async (storage) => {
      const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
      const agent = await openAgent(storage, {
        responses: answers(long),
        send: async (_chatId, message, call) =>
          message.text.length > 100
            ? { kind: "too-long", reason: "400: Bad Request: message is too long" }
            : { kind: "sent", messageId: call },
      });
      try {
        await agent.channel.admit(text(1, "Talk"));
        await agent.settle();
        expect(agent.sent.length).toBeGreaterThan(1);
        expect(agent.sent.map(({ text: sent }) => sent).join(" ")).toBe(long);
      } finally {
        await agent.close();
      }
    }));
});

describe("Telegram bursts (COD-174)", () => {
  it("answers three quick idle messages with one turn, and later input can't stretch the window", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, {
        responses: answers("All three", "And the late one"),
      });
      try {
        const start = clock.now;
        await agent.channel.admit(text(1, "one"));
        clock.now = start + 1_500;
        await agent.channel.admit(text(2, "two"));
        clock.now = start + 1_999;
        await agent.channel.admit(text(3, "three"));
        expect((await channelState(agent.harness)).staged).toMatchObject([
          { firstUpdateId: 1, deadline: start + BATCH_WINDOW_MS },
        ]);
        expect(agent.channel.wake()).toEqual({ active: true, at: start + BATCH_WINDOW_MS });
        // Past the deadline, before any alarm: the late window goes out first, then this message on its own.
        clock.now = start + 2_500;
        await agent.channel.admit(text(4, "four"));
        await agent.settle();
        const conversationId = (await boundId(agent.harness))!;
        expect(await userTexts(agent.harness, conversationId)).toEqual([
          "one\n\ntwo\n\nthree",
          "four",
        ]);
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["All three", "And the late one"]);
      } finally {
        await agent.close();
      }
    }));

  it("sends messages that arrive during a run with the next turn, and answers them once", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const agent = await openAgent(storage, {
        responses: [held(release.promise, "First"), fauxAssistantMessage([fauxText("Rest")])],
      });
      try {
        await agent.channel.admit(text(1, "first"));
        await endWindow(agent);
        // Busy now: each goes straight to the inbox as a follow-up, no window.
        for (const [id, message] of [
          [2, "two"],
          [3, "three"],
          [4, "four"],
        ] as const) {
          await agent.channel.admit(text(id, message));
        }
        expect((await channelState(agent.harness)).staged ?? []).toEqual([]);
        expect((await channelState(agent.harness)).inputs).toHaveLength(4);
        release.resolve();
        await agent.settle();
        const conversationId = (await boundId(agent.harness))!;
        // One turn for the three: `followUpMode: "all"` placed them together.
        expect(await userTexts(agent.harness, conversationId)).toEqual([
          "first",
          "two",
          "three",
          "four",
        ]);
        const conversation = await agent.harness.conversation(conversationId as never, ctx);
        const page = await conversation!.entries({ order: "ascending" }, 50, undefined, ctx);
        expect(page.items.filter((entry) => entry.model?.[0]?.role === "assistant")).toHaveLength(
          2,
        );
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["First", "Rest"]);
      } finally {
        await agent.close();
      }
    }));

  it("sends one notice when the turn several messages joined fails", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const failing: FauxResponseStep = () =>
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider down" });
      const agent = await openAgent(storage, {
        responses: [held(release.promise, "First"), ...Array.from({ length: 8 }, () => failing)],
      });
      try {
        await agent.channel.admit(text(1, "first"));
        await endWindow(agent);
        await agent.channel.admit(text(2, "two"));
        await agent.channel.admit(text(3, "three"));
        release.resolve();
        await agent.settle();
        const [answer, notice, ...rest] = agent.sent.map(({ text: sent }) => sent);
        expect(answer).toBe("First");
        expect(notice).toMatch(/^I couldn't answer that/);
        expect(rest).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("keeps a window through a restart and sends it once; replays of any of its messages do nothing", () =>
    inObject(async (storage) => {
      let agent = await openAgent(storage);
      try {
        await agent.channel.admit(text(1, "before"));
        await agent.channel.admit(text(2, "the restart"));
        agent = await agent.restart({ responses: answers("Both") });
        await agent.channel.admit(text(2, "the restart"));
        // Two flushes at once have one effect.
        clock.now += BATCH_WINDOW_MS;
        await Promise.all([agent.channel.flushDue(), agent.channel.flushDue()]);
        await agent.settle();
        await agent.channel.admit(text(2, "the restart"));
        await agent.channel.admit(text(1, "before"));
        await agent.settle();
        const conversationId = (await boundId(agent.harness))!;
        expect(await userTexts(agent.harness, conversationId)).toEqual(["before\n\nthe restart"]);
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["Both"]);
      } finally {
        await agent.close();
      }
    }));

  it("makes the window a follow-up when a web turn starts during the wait", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const agent = await openAgent(storage, {
        responses: [
          held(release.promise, "Web answer"),
          fauxAssistantMessage([fauxText("Telegram answer")]),
        ],
      });
      try {
        await agent.channel.admit(text(1, "from telegram"));
        const conversationId = (await boundId(agent.harness))!;
        const conversation = await agent.harness.conversation(conversationId as never, ctx);
        await conversation!.submit({ type: "input", content: "from the web" }, ctx);
        await endWindow(agent);
        release.resolve();
        await agent.settle();
        expect(await userTexts(agent.harness, conversationId)).toEqual([
          "from the web",
          "from telegram",
        ]);
        // Telegram gets the answer to its own message, not the web's.
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["Telegram answer"]);
      } finally {
        await agent.close();
      }
    }));

  it("sends a waiting window to the old conversation on /new; later text starts the new one", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, { responses: answers("Old answer", "New answer") });
      try {
        await agent.channel.admit(text(1, "old"));
        const before = (await boundId(agent.harness))!;
        await agent.channel.admit(command(2, "new"));
        const after = (await boundId(agent.harness))!;
        expect(after).not.toBe(before);
        expect((await channelState(agent.harness)).staged ?? []).toEqual([]);
        await agent.channel.admit(text(3, "new"));
        await agent.channel.admit(text(1, "old"));
        await agent.channel.admit(command(2, "new"));
        await agent.settle();
        expect(await boundId(agent.harness)).toBe(after);
        expect(await userTexts(agent.harness, before)).toEqual(["old"]);
        expect(await userTexts(agent.harness, after)).toEqual(["new"]);
        expect(agent.sent.map(({ text: sent }) => sent).sort()).toEqual(
          ["New answer", "Old answer", "Started a new conversation."].sort(),
        );
      } finally {
        await agent.close();
      }
    }));

  it("answers busy to /model and /profile changes while a message waits or a turn runs", () =>
    inObject(async (storage) => {
      const release = Promise.withResolvers<void>();
      const agent = await openAgent(storage, { responses: [held(release.promise, "Done")] });
      try {
        // A chat of its own: MiPi's profile never changes (COD-197).
        await agent.channel.admit(command(1, "new"));
        await agent.channel.admit(text(2, "wait for me"));
        await agent.channel.admit(command(3, "profile", "empty"));
        await agent.channel.admit(command(4, "model", "deepseek-v4.1-flash"));
        // The plain forms still answer.
        await agent.channel.admit(command(5, "profile"));
        await endWindow(agent);
        await agent.channel.admit(command(6, "profile", "empty"));
        release.resolve();
        await agent.settle();
        await agent.channel.admit(command(7, "profile", "empty"));
        await agent.settle();
        const texts = agent.sent
          .map(({ text: sent }) => sent)
          .filter((sent) => sent !== "Started a new conversation.");
        expect(texts.slice(0, 2)).toEqual([BUSY_REPLY, BUSY_REPLY]);
        expect(texts[2]).toMatch(/^Profile: default /);
        expect(texts.slice(3)).toEqual([BUSY_REPLY, "Done", "Profile set to empty."]);
        expect((await channelState(agent.harness)).commands).toEqual([]);
      } finally {
        await agent.close();
      }
    }));

  it("sends a full window at once, with the message that filled it", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, { responses: answers("Lots") });
      try {
        for (let id = 1; id <= BATCH_MAX_MESSAGES; id++)
          await agent.channel.admit(text(id, `m${id}`));
        const state = await channelState(agent.harness);
        expect(state.staged ?? []).toEqual([]);
        expect(state.inputs).toHaveLength(1);
        await agent.settle();
        const conversationId = (await boundId(agent.harness))!;
        const [batch] = await userTexts(agent.harness, conversationId);
        expect(batch!.split("\n\n")).toHaveLength(BATCH_MAX_MESSAGES);
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["Lots"]);
      } finally {
        await agent.close();
      }
    }));

  it("answers busy to a deferred /model when work started while the model list was being read", () =>
    inObject(async (storage) => {
      const list = Promise.withResolvers<string[]>();
      const agent = await openAgent(storage, {
        modelIds: () => list.promise,
        responses: answers("Busy turn"),
      });
      try {
        // Idle when it arrives: recorded, waiting on the list.
        await agent.channel.admit(command(1, "model", "deepseek-v4.1-flash"));
        expect((await channelState(agent.harness)).commands).toHaveLength(1);
        // A message opens a window before the list answers.
        await agent.channel.admit(text(2, "meanwhile"));
        list.resolve(["deepseek-v4.1-flash"]);
        await agent.channel.runCommands();
        const bound = (await boundId(agent.harness))!;
        const conversation = await agent.harness.conversation(bound as never, ctx);
        expect((await conversation!.agent(ctx)).model?.modelId).toBe("faux-1");
        // Plain /model still answers while busy.
        await agent.channel.admit(command(3, "model"));
        await agent.settle();
        const texts = agent.sent.map(({ text: sent }) => sent);
        expect(texts[0]).toBe(BUSY_REPLY);
        expect(texts).toContain("Model: faux-1.\nChange it with /model <id>.");
        expect(texts).toContain("Busy turn");
      } finally {
        await agent.close();
      }
    }));

  it("sends a window early once its text reaches the size cap", () =>
    inObject(async (storage) => {
      const agent = await openAgent(storage, { responses: answers("Long read") });
      try {
        const half = "x".repeat(BATCH_MAX_UNITS / 2);
        await agent.channel.admit(text(1, half));
        expect((await channelState(agent.harness)).staged).toHaveLength(1);
        await agent.channel.admit(text(2, half));
        const state = await channelState(agent.harness);
        expect(state.staged ?? []).toEqual([]);
        expect(state.inputs).toHaveLength(1);
        await agent.settle();
        expect(agent.sent.map(({ text: sent }) => sent)).toEqual(["Long read"]);
      } finally {
        await agent.close();
      }
    }));

  it("titles a batched conversation from all of its messages", () =>
    inObject(async (storage) => {
      const titled: string[] = [];
      const agent = await openAgent(storage, {
        responses: answers("Sure"),
        onSubmitted: async (_conversationId, submitted) => {
          titled.push(submitted);
        },
      });
      try {
        await agent.channel.admit(text(1, "hey"));
        await agent.channel.admit(text(2, "help me debug my wrangler config"));
        await agent.settle();
        expect(titled).toEqual(["hey\n\nhelp me debug my wrangler config"]);
      } finally {
        await agent.close();
      }
    }));

  it("keeps failure notices of the conversations before and after /new apart", () =>
    inObject(async (storage) => {
      const failing: FauxResponseStep = () =>
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider down" });
      let agent = await openAgent(storage, {
        responses: Array.from({ length: 16 }, () => failing),
      });
      try {
        await agent.channel.admit(text(1, "old"));
        await agent.channel.admit(command(2, "new"));
        await agent.channel.admit(text(3, "new"));
        await endWindow(agent);
        // No watcher turns either failure into a notice: both settle first, and one reconcile after the restart
        // sees them together.
        agent.answers.close();
        agent.channel.close();
        await agent.harness.waitForIdle(ctx);
        agent = await agent.restart();
        await agent.settle();
        const notices = agent.sent.filter(({ text: sent }) => sent.startsWith("I couldn't answer"));
        expect(notices).toHaveLength(2);
      } finally {
        await agent.close();
      }
    }));
});

describe("Telegram receipts", () => {
  it("drop past the window or the cap, but never while their update is pending", () => {
    const now = 10 * RECEIPT_WINDOW_MS;
    const state: TelegramChannelState = {
      receipts: [
        { updateId: 1, at: now - RECEIPT_WINDOW_MS - 1 },
        { updateId: 2, at: now - RECEIPT_WINDOW_MS - 1 },
        { updateId: 3, at: now - 1 },
      ],
      inputs: [{ updateId: 2, chatId: CHAT, conversationId: 1, submissionId: 1 }],
      commands: [],
    };
    addReceipt(state, 4, now);
    expect(state.receipts.map(({ updateId }) => updateId)).toEqual([2, 3, 4]);

    const full: TelegramChannelState = { receipts: [], inputs: [], commands: [] };
    for (let id = 0; id < RECEIPTS_KEPT + 10; id++) addReceipt(full, id, now);
    expect(full.receipts).toHaveLength(RECEIPTS_KEPT);
    expect(full.receipts[0]!.updateId).toBe(10);
  });
});
