import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type ConversationView,
  createRegistry,
  type EntryRecord,
  Harness,
  type HarnessOptions,
  type InboxState,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { withSpikeToken } from "./spike.ts";
import { Bots } from "../src/agent/conversations.ts";
import { createHarnessOptions } from "../src/agent/composition.ts";
import { HEARTBEAT_MS } from "../src/agent/alarm.ts";
import { MEMORY_IDLE_MS } from "../src/extensions/builtin/memory/memory-pass.ts";
import worker from "../src/worker/index.ts";
import { MAX_CLIENT_FRAME_CHARACTERS, queuedInputs } from "../src/protocol.ts";
import { DeliverScheduledInstruction } from "../src/extensions/builtin/reminders/schedule-task.ts";

/**
 * Opens a socket on a session's object directly. The Worker routes only the owner's id (tested on its own), and each
 * test here needs an object of its own.
 */
const openSession = (url: string): Promise<Response> => {
  const sessionId = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
  return env.AGENT.getByName(sessionId).fetch(
    new Request(url, { headers: { Upgrade: "websocket" } }),
  );
};

type ProtocolMessage = {
  readonly type?: string;
  readonly conversationId?: number;
  readonly usernames?: readonly string[];
};

const userEntryText = (entry: EntryRecord): string | undefined => {
  const message = entry.model?.[0];
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
};

/** User texts in a view: entries of the window, and inputs queued in `pi.inbox`. */
/** `[speaker · local time]\ntext` → `[speaker]\ntext`: the stamp's time differs per run (stamp.ts has its own tests). */
const withoutTime = (text: string): string =>
  text.replace(/^\[([^\]\n]*?) · [^\]\n]*\]\n/, "[$1]\n");

const submittedTexts = (view: ConversationView | undefined): readonly string[] => [
  ...(view?.entries ?? []).flatMap((entry) => {
    const text = userEntryText(entry);
    return text === undefined ? [] : [withoutTime(text)];
  }),
  ...queuedInputs(view?.docs["pi.inbox"] as InboxState | undefined).map(({ text }) =>
    withoutTime(text),
  ),
];

const sessionSocketUrl = (sessionId: string, username: string, clientId: string): string => {
  const url = new URL(`https://example.com/api/sessions/${sessionId}`);
  url.searchParams.set("username", username);
  url.searchParams.set("_pk", clientId);
  return url.href;
};

const jsonMessages = (socket: WebSocket) => {
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  /** Each conversation's view as the frames received so far leave it. */
  const views = new Map<number, ConversationView>();
  socket.addEventListener("message", (event) => {
    const value: unknown = JSON.parse(String(event.data));
    const frame = value as {
      type?: string;
      conversationId?: number;
      view?: ConversationView;
      ops?: Op[];
    };
    if (frame.type === "conversation.view") views.set(frame.conversationId!, frame.view!);
    if (frame.type === "conversation.ops") {
      views.set(
        frame.conversationId!,
        applyImmutable(views.get(frame.conversationId!), frame.ops!),
      );
    }
    const resolve = waiting.shift();
    if (resolve === undefined) queued.push(value);
    else resolve(value);
  });
  const next = <T>(): Promise<T> => {
    const value = queued.shift();
    return value === undefined
      ? new Promise((resolve) => waiting.push((message) => resolve(message as T)))
      : Promise.resolve(value as T);
  };
  const nextMatching = async <T>(predicate: (value: T) => boolean): Promise<T> => {
    for (;;) {
      const value = await next<T>();
      if (predicate(value)) return value;
    }
  };
  return {
    views,
    next,
    nextMatching,
    /** Reads frames until the view of `conversationId` satisfies `predicate`. */
    untilView: async (
      conversationId: number,
      predicate: (view: ConversationView) => boolean,
    ): Promise<ConversationView> => {
      for (;;) {
        const view = views.get(conversationId);
        if (view !== undefined && predicate(view)) return view;
        await next();
      }
    },
    /** Session snapshot, the bound bot's view (MiPi's at first), and typing presence: the bot's id. */
    skipConnectFrames: async (): Promise<number> => {
      let opened: number | undefined;
      for (let index = 0; index < 3; index++) {
        const frame = await next<{ type?: string; conversationId?: number }>();
        if (frame.type === "conversation.view") opened = frame.conversationId;
      }
      if (opened === undefined) throw new Error("The session opened no conversation");
      return opened;
    },
  };
};

/**
 * Write state as an earlier process would have. The live Session keeps its own harness open, so seed through a
 * separate harness and then evict, letting the next request reopen the Session from storage.
 */
async function seedSession<T>(
  sessionId: string,
  options: HarnessOptions,
  seed: (harness: Harness) => Promise<T>,
): Promise<T> {
  const stub = env.AGENT.getByName(sessionId);
  const result = await runInDurableObject(stub, async (_instance, state) => {
    // Let the Session finish opening its harness before writing beside it.
    await state.blockConcurrencyWhile(async () => {});
    const storage = await openDurableObjectSqliteStorage(state.storage);
    const harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    try {
      return await seed(harness);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
  await evictDurableObject(stub);
  return result;
}

/**
 * Puts a conversation on a model that never answers, and returns its id: MiPi (which the web door opens) unless named,
 * or `root`, Pi Durable's root conversation, which stands for a chat from before bots.
 */
const configureOfflineModel = (
  sessionId: string,
  target: "main" | "root" | number = "main",
): Promise<number> =>
  seedSession(sessionId, createHarnessOptions(), async (harness) => {
    const id =
      target === "root"
        ? (await harness.root(BACKGROUND_CONTEXT)).id
        : target === "main"
          ? await harness.commit(async (tx) => (await tx.doc(Bots)).mainId, BACKGROUND_CONTEXT)
          : target;
    const conversation = await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Conversation ${id} is missing`);
    await conversation.configure(
      { model: { provider: "offline", modelId: "offline" }, tools: [] },
      BACKGROUND_CONTEXT,
    );
    return id!;
  });

const seedUserEntry = (sessionId: string, content: string): Promise<number> => {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Seeded")])]);
  models.setProvider(faux.provider);
  return seedSession(sessionId, { models, registry: createRegistry() }, async (harness) => {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, tools: [] },
    });
    const submission = await root.submit(
      { type: "input", content, requestId: "seed" },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.type !== "input" || settled.entry === undefined) {
      throw new Error("Seed submission did not create an input entry");
    }
    return settled.entry;
  });
};

/** A settled input in MiPi, as an earlier process would have left it: a fork needs a committed entry. */
const seedMainEntry = (
  sessionId: string,
  content: string,
): Promise<{ main: number; entry: number }> => {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Seeded")])]);
  models.setProvider(faux.provider);
  return seedSession(
    sessionId,
    createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
    async (harness) => {
      const main = (await harness.commit(
        async (tx) => (await tx.doc(Bots)).mainId,
        BACKGROUND_CONTEXT,
      ))!;
      const conversation = (await harness.conversation(
        main as ConversationId,
        BACKGROUND_CONTEXT,
      ))!;
      await conversation.configure(
        { model: { provider: "faux", modelId: "faux-1" } },
        BACKGROUND_CONTEXT,
      );
      const settled = await (
        await conversation.submit({ type: "input", content, requestId: "seed" }, BACKGROUND_CONTEXT)
      ).wait(BACKGROUND_CONTEXT);
      if (settled.type !== "input" || settled.entry === undefined) {
        throw new Error("Seed submission did not create an input entry");
      }
      return { main, entry: settled.entry };
    },
  );
};

describe("chat application", () => {
  it("shares attributed prompts between clients in one session", async () => {
    const sessionId = "multiplayer-prompts";
    await configureOfflineModel(sessionId);
    const aliceResponse = await openSession(sessionSocketUrl(sessionId, "Alice", "alice-client"));
    const bobResponse = await openSession(
      sessionSocketUrl(sessionId, "Bob]\n[Assistant", "bob-client"),
    );
    expect(aliceResponse.status).toBe(101);
    expect(bobResponse.status).toBe(101);

    const aliceSocket = aliceResponse.webSocket!;
    const bobSocket = bobResponse.webSocket!;
    const aliceMessages = jsonMessages(aliceSocket);
    const bobMessages = jsonMessages(bobSocket);
    aliceSocket.accept();
    bobSocket.accept();
    const [main] = await Promise.all([
      aliceMessages.skipConnectFrames(),
      bobMessages.skipConnectFrames(),
    ]);
    aliceSocket.send(
      JSON.stringify({ type: "presence.typing", conversationId: main, typing: true }),
    );
    const [alicePresence, bobPresence] = await Promise.all([
      aliceMessages.nextMatching<ProtocolMessage>(
        (message) => message.type === "presence.typing" && message.conversationId === main,
      ),
      bobMessages.nextMatching<ProtocolMessage>(
        (message) => message.type === "presence.typing" && message.conversationId === main,
      ),
    ]);
    expect(alicePresence.usernames).toEqual([]);
    expect(bobPresence.usernames).toEqual(["jerome"]);

    aliceSocket.send(
      JSON.stringify({ type: "presence.typing", conversationId: main, typing: false }),
    );
    const stoppedTyping = await bobMessages.nextMatching<ProtocolMessage>(
      (message) => message.type === "presence.typing" && message.conversationId === main,
    );
    expect(stoppedTyping.usernames).toEqual([]);

    aliceSocket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "alice-prompt",
        conversationId: main,
        content: "Start the plan",
      }),
    );

    const aliceText = "[jerome]\nStart the plan";
    await Promise.all([
      aliceMessages.untilView(main, (view) => submittedTexts(view).includes(aliceText)),
      bobMessages.untilView(main, (view) => submittedTexts(view).includes(aliceText)),
    ]);

    bobSocket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "bob-prompt",
        conversationId: main,
        content: "Add the risks",
      }),
    );

    const bobText = "[jerome]\nAdd the risks";
    await Promise.all([
      aliceMessages.untilView(main, (view) => submittedTexts(view).includes(bobText)),
      bobMessages.untilView(main, (view) => submittedTexts(view).includes(bobText)),
    ]);

    aliceSocket.close(1000, "test complete");
    bobSocket.close(1000, "test complete");
  });
  it("replaces the heartbeat with the memory pass's wake once a submitted turn settles", async () => {
    const sessionId = "heartbeat-cleared";
    await configureOfflineModel(sessionId);
    const stub = env.AGENT.getByName(sessionId);
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "heartbeat-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    const main = await messages.skipConnectFrames();

    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "heartbeat-prompt",
        conversationId: main,
        content: "Answer and go idle",
      }),
    );
    await messages.nextMatching<{ type: string; requestId?: string }>(
      (message) => message.type === "command.result" && message.requestId === "heartbeat-prompt",
    );

    // Whatever the submit path armed, the 60-second heartbeat goes once nothing can run. What stays is the memory
    // pass's wake (M8), when the conversation will have been idle for `MEMORY_IDLE_MS`: no heartbeat while waiting.
    let alarm: number | null = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
      if (alarm !== null && alarm > Date.now() + 10 * HEARTBEAT_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(alarm).toBeGreaterThan(Date.now() + MEMORY_IDLE_MS - 60_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + MEMORY_IDLE_MS);
    socket.close(1000, "test complete");
  });

  it("deduplicates a retried prompt by request ID", async () => {
    const sessionId = "retried-prompt";
    await configureOfflineModel(sessionId);
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "retry-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    const main = await messages.skipConnectFrames();

    const command = JSON.stringify({
      type: "prompt.submit",
      requestId: "stable-request",
      conversationId: main,
      content: "Only once",
    });
    socket.send(command);
    socket.send(command);

    type Acknowledgement = {
      type: string;
      requestId?: string;
      submissionId?: number;
    };
    const isAcknowledgement = (message: Acknowledgement): boolean =>
      message.type === "command.result" && message.requestId === "stable-request";
    const acknowledgements = [
      await messages.nextMatching<Acknowledgement>(isAcknowledgement),
      await messages.nextMatching<Acknowledgement>(isAcknowledgement),
    ];
    expect(acknowledgements[0]?.submissionId).toEqual(expect.any(Number));
    expect(acknowledgements[0]?.submissionId).toBe(acknowledgements[1]?.submissionId);

    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.close(1000, "reconnect test");
    await closed;
    await evictDurableObject(env.AGENT.getByName(sessionId));
    const reopened = await openSession(sessionSocketUrl(sessionId, "Alice", "retry-client-2"));
    const reopenedSocket = reopened.webSocket!;
    const reopenedMessages = jsonMessages(reopenedSocket);
    reopenedSocket.accept();
    expect(await reopenedMessages.skipConnectFrames()).toBe(main);
    expect(
      submittedTexts(reopenedMessages.views.get(main)).filter(
        (text) => text === "[jerome]\nOnly once",
      ),
    ).toHaveLength(1);
    reopenedSocket.close(1000, "test complete");
  });
  it("titles a conversation from its first message and switches its profile", async () => {
    const sessionId = "titles-and-profiles";
    // A chat from before bots (the root): MiPi's profile never changes (COD-197).
    const chat = await configureOfflineModel(sessionId, "root");
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "titles-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    type Snapshot = {
      type: string;
      session?: { conversations: Array<{ id: number; title?: string; profile?: string }> };
    };
    type Result = { type: string; requestId?: string; ok?: boolean; error?: { message: string } };
    const root = (snapshot: Snapshot) =>
      snapshot.session?.conversations.find(({ id }) => id === chat);

    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "first",
        conversationId: chat,
        content: "Plan the week",
      }),
    );
    const titled = await messages.nextMatching<Snapshot>(
      (message) => message.type === "session.snapshot" && root(message)?.title !== undefined,
    );
    expect(root(titled)).toMatchObject({ title: "Plan the week" });

    socket.send(
      JSON.stringify({
        type: "conversation.configure",
        requestId: "to-empty",
        conversationId: chat,
        profile: "empty",
      }),
    );
    const switched = await messages.nextMatching<Snapshot>(
      (message) => message.type === "session.snapshot" && root(message)?.profile === "empty",
    );
    expect(root(switched)).toMatchObject({ title: "Plan the week", profile: "empty" });

    socket.send(
      JSON.stringify({
        type: "conversation.configure",
        requestId: "bad",
        conversationId: chat,
        profile: "coding",
      }),
    );
    const refused = await messages.nextMatching<Result>(
      (message) => message.type === "command.result" && message.requestId === "bad",
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not a profile") },
    });
    socket.close(1000, "test complete");
  });

  it("acknowledges and deduplicates retried bot creation", async () => {
    const sessionId = "retried-conversation-create";
    const command = JSON.stringify({
      type: "bot.create",
      requestId: "stable-create-request",
      name: "Groceries",
      purpose: "Keep the shopping list.",
      profile: "default",
    });
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "create-retry-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    const main = await messages.skipConnectFrames();

    socket.send(command);
    type CreateEvent = {
      type: string;
      requestId?: string;
      conversationId?: number;
    };
    const creationFrames: CreateEvent[] = [];
    while (
      !creationFrames.some(
        ({ type, requestId }) => type === "command.result" && requestId === "stable-create-request",
      ) ||
      !creationFrames.some(
        ({ type, conversationId }) => type === "conversation.view" && conversationId !== main,
      )
    ) {
      creationFrames.push(await messages.next<CreateEvent>());
    }
    const acknowledgementIndex = creationFrames.findIndex(
      ({ type, requestId }) => type === "command.result" && requestId === "stable-create-request",
    );
    const watchIndex = creationFrames.findIndex(
      ({ type, conversationId }) => type === "conversation.view" && conversationId !== main,
    );
    expect(watchIndex).toBeLessThan(acknowledgementIndex);
    const first = creationFrames[acknowledgementIndex]!;
    expect(first).toMatchObject({
      type: "command.result",
      requestId: "stable-create-request",
      conversationId: expect.any(Number),
    });

    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.close(1000, "retry after eviction");
    await closed;
    await evictDurableObject(env.AGENT.getByName(sessionId));

    const reopened = await openSession(
      sessionSocketUrl(sessionId, "Alice", "create-retry-client-2"),
    );
    const reopenedSocket = reopened.webSocket!;
    const reopenedMessages = jsonMessages(reopenedSocket);
    reopenedSocket.accept();
    const snapshot = await reopenedMessages.next<{
      type: string;
      session: { conversations: Array<{ id: number }> };
    }>();
    // MiPi and the new bot, which survived the restart as a bot (COD-197).
    expect(snapshot.session.conversations).toEqual([
      expect.objectContaining({ kind: "main", name: "MiPi", profile: "main" }),
      {
        id: first.conversationId,
        kind: "bot",
        name: "Groceries",
        purpose: "Keep the shopping list.",
        profile: "default",
      },
    ]);
    for (let index = 0; index < 2; index++) await reopenedMessages.next();

    reopenedSocket.send(command);
    const retried = await reopenedMessages.nextMatching<CreateEvent>(
      ({ type, requestId }) => type === "command.result" && requestId === "stable-create-request",
    );
    expect(retried).toMatchObject({
      type: "command.result",
      requestId: "stable-create-request",
      conversationId: first.conversationId,
    });
    reopenedSocket.close(1000, "test complete");
  });

  it("names bots uniquely, keeps main and pidu off them, renames them, and tells the list of new entries", async () => {
    const sessionId = "bots-over-websocket";
    const main = await configureOfflineModel(sessionId);
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "bots-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    expect(await messages.skipConnectFrames()).toBe(main);
    type Result = {
      type: string;
      requestId?: string;
      ok?: boolean;
      conversationId?: number;
      error?: { message: string };
    };
    const run = async (command: Record<string, unknown>): Promise<Result> => {
      const requestId = crypto.randomUUID();
      socket.send(JSON.stringify({ ...command, requestId }));
      return messages.nextMatching<Result>(
        (message) => message.type === "command.result" && message.requestId === requestId,
      );
    };
    const bot = (name: string, profile = "default") =>
      run({ type: "bot.create", name, purpose: "Keep the shopping list.", profile });

    const created = await bot("Groceries");
    expect(created.ok).toBe(true);
    // Names are unique ignoring case, MiPi's included; `main` and `pidu` are no bot's profile.
    expect(await bot("  groceries ")).toMatchObject({
      ok: false,
      error: { message: "There is already a bot named groceries." },
    });
    expect(await bot("mipi")).toMatchObject({ ok: false });
    for (const profile of ["main", "pidu"]) {
      expect(await bot("Other", profile)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("can't be a bot's profile") },
      });
    }

    // Renaming keeps the purpose and frees the old name, and an open tab hears of it at once.
    type Snapshot = {
      type: string;
      session?: { conversations: Array<{ id: number; name?: string; kind?: string }> };
    };
    const other = await openSession(sessionSocketUrl(sessionId, "Bob", "bots-client-other"));
    const otherSocket = other.webSocket!;
    const otherMessages = jsonMessages(otherSocket);
    otherSocket.accept();
    await otherMessages.skipConnectFrames();
    const renamed = otherMessages.nextMatching<Snapshot>(
      (message) =>
        message.type === "session.snapshot" &&
        message.session?.conversations.some(({ name }) => name === "Shopping") === true,
    );
    expect(
      await run({ type: "bot.rename", conversationId: created.conversationId, name: "Shopping" }),
    ).toMatchObject({ ok: true });
    await renamed;
    otherSocket.close(1000, "test complete");
    expect((await bot("Groceries")).ok).toBe(true);
    // MiPi can be renamed too; a chat from before bots can't.
    const older = await configureOfflineModel(sessionId, "root");
    expect(
      await run({ type: "bot.rename", conversationId: older, name: "Old chat" }),
    ).toMatchObject({ ok: false, error: { message: "Only a bot can be renamed." } });

    // A new entry tells every list its conversation's newest entry, with no snapshot.
    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "head-prompt",
        conversationId: main,
        content: "Hello",
      }),
    );
    const head = await messages.nextMatching<{
      type: string;
      conversationId?: number;
      latestEntryId?: number;
    }>((message) => message.type === "conversation.head" && message.conversationId === main);
    expect(head.latestEntryId).toEqual(expect.any(Number));

    socket.close(1000, "test complete");

    // A new session's snapshot carries each bot's newest entry, and the rename.
    const again = await openSession(sessionSocketUrl(sessionId, "Alice", "bots-client-2"));
    const againSocket = again.webSocket!;
    const againMessages = jsonMessages(againSocket);
    againSocket.accept();
    const snapshot = await againMessages.nextMatching<{
      type: string;
      session?: {
        conversations: Array<{ id: number; name?: string; latestEntryId?: number }>;
      };
    }>((message) => message.type === "session.snapshot");
    const conversations = snapshot.session!.conversations;
    expect(conversations.find(({ id }) => id === main)?.latestEntryId).toBeGreaterThanOrEqual(
      head.latestEntryId!,
    );
    expect(conversations.find(({ id }) => id === created.conversationId)).toMatchObject({
      name: "Shopping",
      purpose: "Keep the shopping list.",
    });
    againSocket.close(1000, "test complete");
  });

  it("archives and restores a bot over the WebSocket, never MiPi, and moves an open tab to MiPi (COD-198)", async () => {
    const sessionId = "archive-over-websocket";
    const main = await configureOfflineModel(sessionId);
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "archive-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    expect(await messages.skipConnectFrames()).toBe(main);
    type Result = {
      type: string;
      requestId?: string;
      ok?: boolean;
      conversationId?: number;
      error?: { message: string };
    };
    const run = async (command: Record<string, unknown>): Promise<Result> => {
      const requestId = crypto.randomUUID();
      socket.send(JSON.stringify({ ...command, requestId }));
      return messages.nextMatching<Result>(
        (message) => message.type === "command.result" && message.requestId === requestId,
      );
    };
    expect(await run({ type: "bot.archive", conversationId: main })).toMatchObject({
      ok: false,
      error: { message: "MiPi can't be archived." },
    });
    const created = await run({
      type: "bot.create",
      name: "Garden",
      purpose: "Look after the garden.",
      profile: "default",
    });
    const garden = created.conversationId!;
    expect(
      await run({ type: "bot.bind", conversationId: garden, channel: "relay:pidu" }),
    ).toMatchObject({
      ok: true,
      conversationId: garden,
    });
    expect(await run({ type: "bot.bind", conversationId: garden, channel: "web" })).toMatchObject({
      ok: false,
      error: { message: "No rebindable door named web." },
    });
    // `bot.create` opened it in this tab: archiving moves the tab to MiPi, then tells every list, then answers.
    type Snapshot = {
      type: string;
      session?: { conversations: Array<{ id: number; archivedAt?: number }> };
    };
    socket.send(
      JSON.stringify({ type: "bot.archive", requestId: "archive", conversationId: garden }),
    );
    await messages.nextMatching<{ type: string; conversationId?: number }>(
      (message) => message.type === "conversation.view" && message.conversationId === main,
    );
    await messages.nextMatching<Snapshot>(
      (message) =>
        message.type === "session.snapshot" &&
        message.session?.conversations.find(({ id }) => id === garden)?.archivedAt !== undefined,
    );
    expect(
      await messages.nextMatching<Result>(
        (message) => message.type === "command.result" && message.requestId === "archive",
      ),
    ).toMatchObject({ ok: true });
    // An archived bot takes no message.
    expect(
      await run({ type: "prompt.submit", conversationId: garden, content: "Hello?" }),
    ).toMatchObject({
      ok: false,
      error: { message: "This bot is archived. Restore it to talk to it again." },
    });
    socket.send(
      JSON.stringify({ type: "bot.restore", requestId: "restore", conversationId: garden }),
    );
    await messages.nextMatching<Snapshot>(
      (message) =>
        message.type === "session.snapshot" &&
        message.session?.conversations.some(
          ({ id, archivedAt }) => id === garden && archivedAt === undefined,
        ) === true,
    );
    expect(
      await messages.nextMatching<Result>(
        (message) => message.type === "command.result" && message.requestId === "restore",
      ),
    ).toMatchObject({ ok: true, conversationId: garden });
    expect(await run({ type: "bot.restore", conversationId: main })).toMatchObject({
      ok: false,
      error: { message: "MiPi can't be restored." },
    });
    socket.close(1000, "test complete");
  });

  it("forks MiPi into a chat of its own on the default profile, never a second MiPi", async () => {
    const sessionId = "fork-the-main-bot";
    const { main, entry } = await seedMainEntry(sessionId, "Fork this");
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "fork-main-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    expect(await messages.skipConnectFrames()).toBe(main);
    type Snapshot = {
      type: string;
      session?: { conversations: Array<{ id: number; kind?: string; parent?: unknown }> };
    };
    socket.send(
      JSON.stringify({
        type: "conversation.fork",
        requestId: "fork-main",
        conversationId: main,
        entryId: entry,
      }),
    );
    const result = await messages.nextMatching<{
      type: string;
      requestId?: string;
      ok?: boolean;
      conversationId?: number;
    }>((message) => message.type === "command.result" && message.requestId === "fork-main");
    expect(result.ok).toBe(true);
    socket.close(1000, "test complete");

    const again = await openSession(sessionSocketUrl(sessionId, "Alice", "fork-main-client-2"));
    const againSocket = again.webSocket!;
    const againMessages = jsonMessages(againSocket);
    againSocket.accept();
    const snapshot = await againMessages.nextMatching<Snapshot>(
      ({ type }) => type === "session.snapshot",
    );
    const conversations = snapshot.session!.conversations;
    expect(conversations.filter(({ kind }) => kind === "main").map(({ id }) => id)).toEqual([main]);
    // Off MiPi's `main` too, whose tools are MiPi's alone.
    expect(conversations.find(({ id }) => id === result.conversationId)).toEqual({
      id: result.conversationId,
      parent: { conversationId: main, at: entry },
      profile: "default",
      latestEntryId: entry,
    });
    againSocket.close(1000, "test complete");
  });

  it("always returns the owner's one session", async () => {
    const response = await exports.default.fetch(
      withSpikeToken("https://example.com/api/sessions", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: "jerome", url: "/sessions/jerome" });

    const again = await exports.default.fetch(
      withSpikeToken("https://example.com/api/sessions", { method: "POST" }),
    );
    expect(await again.json()).toEqual({ sessionId: "jerome", url: "/sessions/jerome" });
  });

  it("routes only the owner's session and never opens another object", async () => {
    const response = await exports.default.fetch(
      withSpikeToken("https://example.com/api/sessions/someone-else", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it("opens a session WebSocket with MiPi", async () => {
    const response = await exports.default.fetch(
      withSpikeToken("https://example.com/api/sessions/jerome", {
        headers: { Upgrade: "websocket" },
      }),
    );

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    const messages = jsonMessages(socket!);
    socket!.accept();

    const session = await messages.next<{
      type: string;
      session: {
        conversations: Array<{ id: number }>;
        activity: { tasks: Record<string, unknown> };
      };
    }>();
    // A new agent has only MiPi, which every door reaches (COD-197).
    expect(session).toEqual({
      type: "session.snapshot",
      session: {
        conversations: [{ id: expect.any(Number), kind: "main", name: "MiPi", profile: "main" }],
        activity: { tasks: {} },
      },
    });
    const main = session.session.conversations[0]!.id;

    await expect(messages.next()).resolves.toMatchObject({
      type: "conversation.view",
      conversationId: main,
      view: {
        conversation: { id: main },
        entries: [],
        docs: {
          "pi.agent": {
            model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
            thinkingLevel: "low",
            tools: [
              "schedule",
              "search_history",
              "remember",
              "forget",
              "web_fetch",
              "create_bot",
              "bind_door",
              "message_bot",
              "list_bots",
              "stop_bot",
            ],
          },
        },
      },
    });
    await expect(messages.next()).resolves.toEqual({
      type: "presence.typing",
      conversationId: main,
      usernames: [],
    });

    socket!.close(1000, "test complete");
  });

  it("restores participant and conversation state after Durable Object eviction", async () => {
    const sessionId = "websocket-eviction";
    const response = await openSession(sessionSocketUrl(sessionId, "Alice", "eviction-client"));
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    socket.send(
      JSON.stringify({
        type: "bot.create",
        requestId: "create-before-eviction",
        name: "Before eviction",
        purpose: "Survive a restart.",
        profile: "default",
      }),
    );
    const created = await messages.nextMatching<{
      type: string;
      requestId?: string;
      conversationId?: number;
    }>(
      (message) =>
        message.type === "command.result" && message.requestId === "create-before-eviction",
    );
    expect(created.conversationId).toEqual(expect.any(Number));

    await evictDurableObject(env.AGENT.getByName(sessionId));
    await configureOfflineModel(sessionId, created.conversationId);
    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "prompt-after-eviction",
        conversationId: created.conversationId,
        content: "Continue here",
      }),
    );

    // The restarted object watches the conversation again for the hibernated socket: a fresh first value.
    const restored = await messages.nextMatching<ProtocolMessage>(
      (message) =>
        message.type === "conversation.view" && message.conversationId === created.conversationId,
    );
    expect(restored.conversationId).toBe(created.conversationId);
    await messages.untilView(created.conversationId!, (view) =>
      submittedTexts(view).includes("[jerome]\nContinue here"),
    );
    socket.close(1000, "test complete");
  });

  it("restores typing presence after Durable Object eviction", async () => {
    const sessionId = "typing-presence-eviction";
    const aliceResponse = await openSession(sessionSocketUrl(sessionId, "Alice", "typing-alice"));
    const bobResponse = await openSession(sessionSocketUrl(sessionId, "Bob", "typing-bob"));
    const aliceSocket = aliceResponse.webSocket!;
    const bobSocket = bobResponse.webSocket!;
    const aliceMessages = jsonMessages(aliceSocket);
    const bobMessages = jsonMessages(bobSocket);
    aliceSocket.accept();
    bobSocket.accept();
    const [main] = await Promise.all([
      aliceMessages.skipConnectFrames(),
      bobMessages.skipConnectFrames(),
    ]);

    aliceSocket.send(
      JSON.stringify({ type: "presence.typing", conversationId: main, typing: true }),
    );
    await expect(
      bobMessages.nextMatching<ProtocolMessage>(
        (message) =>
          message.type === "presence.typing" &&
          message.conversationId === main &&
          message.usernames?.includes("jerome") === true,
      ),
    ).resolves.toMatchObject({ usernames: ["jerome"] });

    await evictDurableObject(env.AGENT.getByName(sessionId));
    bobSocket.send(
      JSON.stringify({
        type: "conversation.open",
        requestId: "wake-after-eviction",
        conversationId: main,
      }),
    );

    await expect(
      bobMessages.nextMatching<ProtocolMessage>(
        (message) =>
          message.type === "presence.typing" &&
          message.conversationId === main &&
          message.usernames?.includes("jerome") === true,
      ),
    ).resolves.toMatchObject({ usernames: ["jerome"] });

    aliceSocket.close(1000, "test complete");
    bobSocket.close(1000, "test complete");
  });

  it("closes the WebSocket after a malformed command frame", async () => {
    const response = await openSession("https://example.com/api/sessions/malformed-frame");
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );

    socket.send("{");

    await expect(messages.next()).resolves.toEqual({
      type: "error",
      error: { code: "invalid_command", message: "Message must contain valid JSON" },
    });
    await expect(closed).resolves.toMatchObject({ code: 1002 });
  });

  it("rejects oversized command frames before parsing", async () => {
    const response = await openSession("https://example.com/api/sessions/oversized-frame");
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );

    socket.send("x".repeat(MAX_CLIENT_FRAME_CHARACTERS + 1));

    await expect(messages.next()).resolves.toEqual({
      type: "error",
      error: { code: "frame_too_large", message: "Command frame exceeds the size limit" },
    });
    await expect(closed).resolves.toMatchObject({ code: 1009 });
  });

  it("requires a GET WebSocket upgrade on session socket routes", async () => {
    const nonGetResponse = await worker.fetch(
      withSpikeToken(
        new Request("https://example.com/api/sessions/non-get-upgrade", {
          method: "POST",
          headers: { Upgrade: "websocket" },
        }),
      ),
      env,
    );

    expect(nonGetResponse.status).toBe(405);
    expect(nonGetResponse.headers.get("Allow")).toBe("GET");
    await nonGetResponse.body?.cancel();

    const nonUpgradeResponse = await worker.fetch(
      withSpikeToken(new Request("https://example.com/api/sessions/non-upgrade")),
      env,
    );
    expect(nonUpgradeResponse.status).toBe(426);
    expect(nonUpgradeResponse.headers.get("Upgrade")).toBe("websocket");
    await nonUpgradeResponse.body?.cancel();

    const extraSegmentResponse = await worker.fetch(
      withSpikeToken(
        new Request("https://example.com/api/sessions/opaque/extra", {
          headers: { Upgrade: "websocket" },
        }),
      ),
      env,
    );
    expect(extraSegmentResponse.status).toBe(404);
    await extraSegmentResponse.body?.cancel();
  });

  it("creates a durable fork at a committed transcript entry", async () => {
    const sessionId = "fork-over-websocket";
    const entryId = await seedUserEntry(sessionId, "Fork this");

    const response = await openSession(`https://example.com/api/sessions/${sessionId}`);
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    socket.send(
      JSON.stringify({
        type: "conversation.fork",
        requestId: "fork-1",
        conversationId: 1,
        entryId,
      }),
    );

    type Event = {
      type: string;
      requestId?: string;
      ok?: boolean;
      conversationId?: number;
      session?: {
        conversations: Array<{
          id: number;
          parent?: { conversationId: number; at: number };
        }>;
      };
    };
    let forkId: number | undefined;
    let forkSummary: { id: number; parent?: { conversationId: number; at: number } } | undefined;
    let receivedForkSnapshot = false;
    for (
      let index = 0;
      index < 10 && (forkId === undefined || forkSummary === undefined || !receivedForkSnapshot);
      index++
    ) {
      const event = await messages.next<Event>();
      if (event.type === "command.result" && event.requestId === "fork-1" && event.ok) {
        forkId = event.conversationId;
      }
      if (event.type === "session.snapshot") {
        forkSummary = event.session?.conversations.find(({ parent }) => parent !== undefined);
      }
      if (event.type === "conversation.view" && event.conversationId !== 1) {
        receivedForkSnapshot = true;
      }
    }

    expect(forkId).toEqual(expect.any(Number));
    expect(forkSummary).toEqual({
      id: forkId,
      parent: { conversationId: 1, at: entryId },
      // A fork sees its parent's entries up to where it forked.
      latestEntryId: entryId,
      // A fork keeps its parent's profile.
      profile: "default",
    });
    expect(receivedForkSnapshot).toBe(true);
    socket.send(
      JSON.stringify({
        type: "conversation.fork",
        requestId: "fork-1",
        conversationId: 1,
        entryId,
      }),
    );
    const retryFrames: Event[] = [];
    while (
      !retryFrames.some(
        (event) => event.type === "command.result" && event.requestId === "fork-1",
      ) ||
      !retryFrames.some((event) => event.type === "session.snapshot")
    ) {
      retryFrames.push(await messages.next<Event>());
    }
    const retried = retryFrames.find(
      (event) => event.type === "command.result" && event.requestId === "fork-1",
    );
    expect(retried).toMatchObject({ ok: true, conversationId: forkId });
    const afterRetry = retryFrames.find((event) => event.type === "session.snapshot");
    expect(
      afterRetry?.session?.conversations.filter(({ parent }) => parent !== undefined),
    ).toHaveLength(1);
    socket.close(1000, "test complete");
  });

  it("pages transcript entries outside the view's window", async () => {
    const sessionId = "entries-paging";
    const input = await seedUserEntry(sessionId, "Page me");
    const response = await openSession(`https://example.com/api/sessions/${sessionId}`);
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    type PageResult = {
      type: string;
      requestId?: string;
      ok?: boolean;
      page?: { items: EntryRecord[]; next?: unknown };
    };
    const requestPage = async (requestId: string, query: object): Promise<PageResult> => {
      socket.send(
        JSON.stringify({ type: "conversation.entries", requestId, conversationId: 1, ...query }),
      );
      return messages.nextMatching<PageResult>(
        (message) => message.type === "command.result" && message.requestId === requestId,
      );
    };

    // Newest first: the answer, with more before it.
    const newest = await requestPage("page-1", { order: "descending", limit: 1 });
    expect(newest.ok).toBe(true);
    expect(newest.page?.items).toHaveLength(1);
    expect(newest.page?.next).toBeDefined();
    // Up to the input, the first entry: nothing before it.
    const first = await requestPage("page-2", { maxEntryId: input, order: "descending", limit: 1 });
    expect(first.page?.items.map(({ id }) => id)).toEqual([input]);
    expect(first.page?.next).toBeUndefined();

    // Out-of-range limits are protocol errors.
    socket.send(
      JSON.stringify({
        type: "conversation.entries",
        requestId: "page-3",
        conversationId: 1,
        order: "ascending",
        limit: 1_000,
      }),
    );
    await expect(closed).resolves.toMatchObject({ code: 1002 });
  });

  it("lists subagent conversations with their owner", async () => {
    const sessionId = "owned-conversations-listed";
    // A task-owned conversation, as history search creates for its subagent.
    const { childId, rootId } = await seedSession(
      sessionId,
      createHarnessOptions(),
      async (harness) => {
        const root = await harness.root(BACKGROUND_CONTEXT);
        const childId = await root.commit(async (tx) => {
          const task = await tx.createTask(
            DeliverScheduledInstruction,
            {
              id: "schedule:owner",
              conversationId: root.id,
              instruction: "Owner only",
              runAt: Date.now() + 3_600_000,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: task },
          });
          return child.id;
        }, BACKGROUND_CONTEXT);
        return { childId, rootId: root.id };
      },
    );

    const response = await openSession(`https://example.com/api/sessions/${sessionId}`);
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    // The reopened Session resumes the delivery, which goes to sleep: its activity update may precede the snapshot.
    const snapshot = await messages.nextMatching<{
      type: string;
      session: {
        conversations: unknown[];
        activity: { tasks: Record<string, unknown> };
      };
    }>(({ type }) => type === "session.snapshot");
    expect(snapshot).toMatchObject({
      type: "session.snapshot",
      session: {
        conversations: expect.arrayContaining([
          expect.objectContaining({ id: rootId }),
          { id: childId, owner: { conversationId: rootId } },
        ]),
      },
    });
    expect(Object.values(snapshot.session.activity.tasks)).toEqual([
      expect.objectContaining({
        kind: "app.deliver-scheduled-instruction",
        conversationId: rootId,
        background: true,
        conversations: [childId],
      }),
    ]);
    socket.close(1000, "test complete");
  });
});
