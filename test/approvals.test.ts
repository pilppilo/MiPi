/**
 * Approvals (COD-173, COD-237): a tool call that waits for the owner, on a real harness with a faux model. Covers the
 * core gate (`gate` policies) and a tool that asks for itself (`self`), approve, deny, expiry, a restart while
 * waiting, an abort, a second answer, other work going on meanwhile, and the owner notice.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  defineExtension,
  Harness,
  type Storage,
  type TaskGraph,
  type TaskGraphNode,
  ToolTask,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import {
  ApprovalNotices,
  ApprovalSignal,
  approvalsIn,
  ApprovalTracker,
  ApprovalWatch,
  awaitApproval,
  describeApproval,
  EXPIRED_TEXT,
  resolveApproval,
} from "../src/agent/approvals.ts";
import { createHarnessOptions } from "../src/agent/composition.ts";
import type { DiagInput } from "../src/agent/diag.ts";
import type { MipiExtension } from "../src/agent/extensions.ts";
import { abortConversation, type ToolRegistration } from "../src/agent/pi/durable.ts";
import { openDurableObjectSqliteStorage } from "../src/agent/pi/sqlite.ts";
import { BUILT_IN_EXTENSIONS } from "../src/extensions/builtins.ts";

const ctx = BACKGROUND_CONTEXT;
const MINUTE = 60_000;

/** What the test tools did. */
const ran: string[] = [];

/** Gated by core: asks before every call. */
const postTool: ToolRegistration = {
  name: "post",
  description: "Post a message somewhere public",
  parameters: obj({ text: str({ minLength: 1 }) }),
  replay: "unsafe",
  writesOutside: true,
  approval: {
    kind: "gate",
    describe: (args) => ({ summary: `Post "${String(args["text"])}"`, reason: "It is public" }),
    ttlMs: 30 * MINUTE,
  },
  execute: async (args) => {
    const { text } = args as { text: string };
    ran.push(`post:${text}`);
    return { output: [{ type: "text", text: `Posted ${text}` }] };
  },
};

/** Asks for itself, only when `ask` is set: a need its own transaction would see. */
const noteTool: ToolRegistration = {
  name: "note",
  description: "Keep a note",
  parameters: obj({ text: str({ minLength: 1 }), ask: opt(bool()) }),
  replay: "safe",
  approval: {
    kind: "self",
    describe: (args) => ({ summary: `Keep "${String(args["text"])}"`, reason: "Asked" }),
    ttlMs: 10 * MINUTE,
  },
  execute: async (args, api, context) => {
    const { text, ask } = args as { text: string; ask?: boolean };
    if (api.wake !== undefined || ask === true) {
      const step = await awaitApproval(api, context, 10 * MINUTE);
      if (step.kind === "park") return step.park;
      if (step.kind === "refused") return step.result;
    }
    ran.push(`note:${text}`);
    return { output: [{ type: "text", text: `Kept ${text}` }] };
  },
};

const testExtension: MipiExtension = {
  name: "test-approvals",
  tier: "builtin",
  pi: defineExtension({ name: "test-approvals", tools: [postTool, noteTool] }),
};

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage([fauxText(text)]);

interface Agent {
  harness: Harness;
  readonly clock: { now: number };
  /** Closes the harness and opens a new one on fresh storage over the same data, as a restarted object does. */
  reopen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The agent with the test tools. `storage` opens the storage, again on each reopen: in memory by default (one store,
 * no reopen), or a Durable Object's SQLite.
 */
async function openAgent(
  responses: ReturnType<typeof say>[],
  storage: () => Promise<Storage> = memoryStorage(),
): Promise<Agent> {
  ran.length = 0;
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const clock = { now: Date.UTC(2026, 10, 27, 12) };
  const options = {
    ...createHarnessOptions({
      models,
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [...BUILT_IN_EXTENSIONS, testExtension],
    }),
    now: () => clock.now,
    // As the Durable Object does: no timer for sleeps, the host resumes them (here, the test).
    onWake: () => {},
  };
  const agent: Agent = {
    harness: await Harness.open(await storage(), options, ctx),
    clock,
    reopen: async () => {
      await agent.harness.close(ctx);
      agent.harness = await Harness.open(await storage(), options, ctx);
    },
    close: () => agent.harness.close(ctx),
  };
  return agent;
}

function memoryStorage(): () => Promise<Storage> {
  let opened = false;
  return async () => {
    if (opened) throw new Error("A memory store can't be reopened; use a Durable Object's");
    opened = true;
    return new MemoryStorage();
  };
}

async function conversation(harness: Harness) {
  const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
  await harness.commit(
    (tx) => configure(tx, created.id, { tools: [postTool, noteTool], thinkingLevel: "off" }),
    ctx,
  );
  return created;
}

async function send(harness: Harness, id: number, content: string) {
  const target = await harness.conversation(id as never, ctx);
  return target!.submit({ type: "input", content, requestId: `web:${content}` }, ctx);
}

async function graphOf(harness: Harness): Promise<TaskGraph> {
  const observation = await harness.observeTaskGraph({ advance() {}, end() {} }, ctx);
  observation.detach();
  return observation.value;
}

/** Waits until some approval is pending, and returns the graph that shows it. */
async function pending(harness: Harness): Promise<TaskGraph> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const graph = await graphOf(harness);
    if (approvalsIn(graph).length > 0) return graph;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No approval became pending");
}

/** The text of the tool results in a conversation, oldest first. */
async function toolResults(harness: Harness, id: number): Promise<string[]> {
  const target = await harness.conversation(id as never, ctx);
  const page = await target!.entries({ order: "ascending" }, 100, undefined, ctx);
  return page.items.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult"
        ? [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
        : [],
    ),
  );
}

const answer = (decision: "approve" | "deny", note?: string) => ({
  decision,
  decidedBy: "web:owner",
  ...(note === undefined ? {} : { note }),
});

describe("the approval gate", () => {
  it("parks a gated call until the owner approves, then runs it once", async () => {
    const agent = await openAgent([call("post", { text: "hello" }), say("Posted.")]);
    try {
      const chat = await conversation(agent.harness);
      const submission = await send(agent.harness, chat.id, "post hello");
      const graph = await pending(agent.harness);
      expect(ran).toEqual([]);

      const [ref] = approvalsIn(graph);
      expect(ref).toMatchObject({
        conversationId: chat.id,
        expiresAt: agent.clock.now + 30 * MINUTE,
      });
      const described = await describeApproval(
        agent.harness,
        ref!,
        new Map([["post", postTool]]),
        ctx,
      );
      expect(described).toMatchObject({
        tool: "post",
        arguments: { text: "hello" },
        summary: 'Post "hello"',
        reason: "It is public",
      });

      expect(
        await resolveApproval(
          agent.harness,
          graph,
          ref!.id,
          answer("approve"),
          agent.clock.now,
          ctx,
        ),
      ).toEqual({ kind: "resolved" });
      expect((await submission.wait(ctx)).status).toBe("done");
      expect(ran).toEqual(["post:hello"]);
      expect(await toolResults(agent.harness, chat.id)).toEqual(["Posted hello"]);
      expect(approvalsIn(await graphOf(agent.harness))).toEqual([]);

      // A second answer to the same request finds it decided.
      expect(
        await resolveApproval(agent.harness, graph, ref!.id, answer("deny"), agent.clock.now, ctx),
      ).toEqual({ kind: "already_decided" });
    } finally {
      await agent.close();
    }
  });

  it("tells the model about a deny, with the owner's note, and never runs the call", async () => {
    const agent = await openAgent([call("post", { text: "secret" }), say("Not posted.")]);
    try {
      const chat = await conversation(agent.harness);
      const submission = await send(agent.harness, chat.id, "post secret");
      const graph = await pending(agent.harness);
      const [ref] = approvalsIn(graph);
      await resolveApproval(
        agent.harness,
        graph,
        ref!.id,
        answer("deny", "  not today "),
        agent.clock.now,
        ctx,
      );
      expect((await submission.wait(ctx)).status).toBe("done");
      expect(ran).toEqual([]);
      expect(await toolResults(agent.harness, chat.id)).toEqual([
        expect.stringContaining("Denied by the owner. Their note: not today"),
      ]);
    } finally {
      await agent.close();
    }
  });

  it("times out unanswered and refuses a late answer", async () => {
    const agent = await openAgent([call("post", { text: "late" }), say("Timed out.")]);
    try {
      const chat = await conversation(agent.harness);
      const submission = await send(agent.harness, chat.id, "post late");
      const graph = await pending(agent.harness);
      agent.clock.now += 30 * MINUTE + 1;
      agent.harness.resume();
      expect((await submission.wait(ctx)).status).toBe("done");
      expect(ran).toEqual([]);
      expect(await toolResults(agent.harness, chat.id)).toEqual([
        expect.stringContaining(EXPIRED_TEXT),
      ]);
      const [ref] = approvalsIn(graph);
      // The stale graph still shows it; the task has ended, so the answer can't land.
      expect(
        await resolveApproval(
          agent.harness,
          graph,
          ref!.id,
          answer("approve"),
          agent.clock.now,
          ctx,
        ),
      ).toEqual({ kind: "already_decided" });
      expect(
        await resolveApproval(
          agent.harness,
          await graphOf(agent.harness),
          ref!.id,
          answer("approve"),
          agent.clock.now,
          ctx,
        ),
      ).toEqual({ kind: "not_found" });
    } finally {
      await agent.close();
    }
  });

  it("keeps waiting across a restart, with the same deadline", async () => {
    const stub = env.AGENT.getByName("approvals-restart");
    await runInDurableObject(stub, async (_instance, state) => {
      // Let MipiAgent finish opening its own harness before opening one beside it.
      await state.blockConcurrencyWhile(async () => {});
      const agent = await openAgent([call("post", { text: "durable" }), say("Posted.")], () =>
        openDurableObjectSqliteStorage(state.storage),
      );
      try {
        const chat = await conversation(agent.harness);
        const submission = await send(agent.harness, chat.id, "post durable");
        const [before] = approvalsIn(await pending(agent.harness));
        agent.clock.now += 5 * MINUTE;
        await agent.reopen();

        // Reopening runs the gate again: it finds no answer and sleeps on the first deadline.
        const graph = await pending(agent.harness);
        const [after] = approvalsIn(graph);
        expect(after).toEqual(before);
        expect(ran).toEqual([]);

        await resolveApproval(
          agent.harness,
          graph,
          after!.id,
          answer("approve"),
          agent.clock.now,
          ctx,
        );
        const reacquired = await agent.harness.submission(submission.id, ctx);
        expect((await reacquired!.wait(ctx)).status).toBe("done");
        expect(ran).toEqual(["post:durable"]);
      } finally {
        await agent.close();
      }
    });
    await evictDurableObject(stub);
  });

  it("drops a waiting call from the list when its conversation is aborted", async () => {
    const agent = await openAgent([call("post", { text: "never" })]);
    try {
      const chat = await conversation(agent.harness);
      await send(agent.harness, chat.id, "post never");
      const graph = await pending(agent.harness);
      const [ref] = approvalsIn(graph);
      const target = await agent.harness.conversation(chat.id, ctx);
      await abortConversation(target!, ctx);
      expect(approvalsIn(await graphOf(agent.harness))).toEqual([]);
      expect(ran).toEqual([]);
      expect(
        await resolveApproval(
          agent.harness,
          graph,
          ref!.id,
          answer("approve"),
          agent.clock.now,
          ctx,
        ),
      ).toEqual({ kind: "already_decided" });
    } finally {
      await agent.close();
    }
  });

  it("answers other conversations while one waits", async () => {
    const agent = await openAgent([call("post", { text: "wait" }), say("Hi there."), say("Done.")]);
    try {
      const waiting = await conversation(agent.harness);
      const parked = await send(agent.harness, waiting.id, "post wait");
      const graph = await pending(agent.harness);
      const other = await conversation(agent.harness);
      expect((await (await send(agent.harness, other.id, "hi")).wait(ctx)).status).toBe("done");

      const [ref] = approvalsIn(graph);
      await resolveApproval(agent.harness, graph, ref!.id, answer("approve"), agent.clock.now, ctx);
      expect((await parked.wait(ctx)).status).toBe("done");
      expect(ran).toEqual(["post:wait"]);
    } finally {
      await agent.close();
    }
  });

  it("refuses an id that names no waiting approval", async () => {
    const agent = await openAgent([]);
    try {
      expect(
        await resolveApproval(
          agent.harness,
          await graphOf(agent.harness),
          "999",
          answer("approve"),
          agent.clock.now,
          ctx,
        ),
      ).toEqual({ kind: "not_found" });
    } finally {
      await agent.close();
    }
  });
});

describe("a tool that asks for itself", () => {
  it("runs once approved, and only when it asked", async () => {
    const agent = await openAgent([
      call("note", { text: "plain" }),
      say("Kept."),
      call("note", { text: "asked", ask: true }),
      say("Kept too."),
    ]);
    try {
      const chat = await conversation(agent.harness);
      expect((await (await send(agent.harness, chat.id, "note plain")).wait(ctx)).status).toBe(
        "done",
      );
      expect(ran).toEqual(["note:plain"]);

      const submission = await send(agent.harness, chat.id, "note asked");
      const graph = await pending(agent.harness);
      const [ref] = approvalsIn(graph);
      expect(ref!.expiresAt).toBe(agent.clock.now + 10 * MINUTE);
      expect(
        await describeApproval(agent.harness, ref!, new Map([["note", noteTool]]), ctx),
      ).toMatchObject({ tool: "note", summary: 'Keep "asked"' });
      await resolveApproval(agent.harness, graph, ref!.id, answer("approve"), agent.clock.now, ctx);
      expect((await submission.wait(ctx)).status).toBe("done");
      expect(ran).toEqual(["note:plain", "note:asked"]);
    } finally {
      await agent.close();
    }
  });

  it("returns the deny or the timeout as its result", async () => {
    const agent = await openAgent([
      call("note", { text: "no", ask: true }),
      say("Denied."),
      call("note", { text: "slow", ask: true }),
      say("Timed out."),
    ]);
    try {
      const chat = await conversation(agent.harness);
      const denied = await send(agent.harness, chat.id, "note no");
      const graph = await pending(agent.harness);
      await resolveApproval(
        agent.harness,
        graph,
        approvalsIn(graph)[0]!.id,
        answer("deny"),
        agent.clock.now,
        ctx,
      );
      expect((await denied.wait(ctx)).status).toBe("done");

      const slow = await send(agent.harness, chat.id, "note slow");
      await pending(agent.harness);
      agent.clock.now += 10 * MINUTE + 1;
      agent.harness.resume();
      expect((await slow.wait(ctx)).status).toBe("done");

      expect(ran).toEqual([]);
      expect(await toolResults(agent.harness, chat.id)).toEqual([
        "Denied by the owner.",
        EXPIRED_TEXT,
      ]);
    } finally {
      await agent.close();
    }
  });
});

/** What one approval watch reported: the owner notices and the diagnostics. */
interface Seen {
  readonly told: { id: string; text: string }[];
  readonly events: DiagInput[];
}

const seen = (): Seen => ({ told: [], events: [] });

/** An approval watch over `harness`, reporting into `into`; `reach` says whether a door can reach the owner. */
function approvalWatch(
  harness: Harness,
  into: Seen,
  options: { watched?: () => boolean; reach?: () => boolean; now?: () => number } = {},
): ApprovalWatch {
  return new ApprovalWatch({
    harness,
    delivery: {
      tellOwner: async (_tx, notice) => {
        if (options.reach !== undefined && !options.reach()) return false;
        into.told.push(notice);
        return true;
      },
    },
    tools: new Map([
      ["post", postTool],
      ["note", noteTool],
    ]),
    diag: { emit: (event) => into.events.push(event) },
    watched: options.watched ?? (() => false),
    now: options.now ?? Date.now,
    report: (error) => {
      throw error;
    },
  });
}

/** Attaches `watch` to the harness's task-graph watch as the Durable Object does: seeded, then every frame. */
async function attach(harness: Harness, watch: ApprovalWatch): Promise<() => Promise<void>> {
  const activity = await harness.watchTaskGraph(ctx);
  void watch.seed(activity.value, ctx);
  activity.start(async (call) => {
    if (call.kind === "value") void watch.observe(call.value, ctx);
  });
  return async () => {
    await activity.stop();
    await watch.settled();
  };
}

/** Waits until `check` holds, letting frames and notices land. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting");
}

describe("the approval tracker", () => {
  /** A one-task graph: the call's tool task in `state`. */
  const graphWith = (state: TaskGraphNode["state"] | undefined): TaskGraph => ({
    tasks:
      state === undefined
        ? {}
        : {
            "7": {
              id: 7 as TaskGraphNode["id"],
              kind: ToolTask.definition.name,
              conversationId: 1 as TaskGraphNode["conversationId"],
              background: false,
              abortRequested: false,
              state,
              conversations: [],
            },
          },
  });
  const asleep = graphWith({
    status: "sleeping",
    phase: "call",
    until: 1_000,
    signals: [ApprovalSignal.key("7")],
  });
  const checking = graphWith({ status: "running", phase: "call" });

  it("keeps a request while its gate checks again, and ends it only when the task goes", () => {
    const tracker = new ApprovalTracker();
    expect(tracker.update(asleep, 0).map(({ kind }) => kind)).toEqual(["requested"]);
    // Woken on a reopen or registry change: running, then asleep once more. Neither is a change.
    expect(tracker.update(checking, 1)).toEqual([]);
    expect(tracker.pending.map(({ id }) => id)).toEqual(["7"]);
    expect(tracker.update(asleep, 2)).toEqual([]);
    // Gone before its deadline: canceled. A fresh one past its deadline: expired.
    expect(tracker.update(graphWith(undefined), 3)).toEqual([
      expect.objectContaining({ kind: "ended", how: "canceled" }),
    ]);
    tracker.update(asleep, 4);
    expect(tracker.update(graphWith(undefined), 1_000)).toEqual([
      expect.objectContaining({ kind: "ended", how: "expired" }),
    ]);
  });

  it("ends an answered request once it stops sleeping, and seeds without changes", () => {
    const tracker = new ApprovalTracker();
    tracker.seed(asleep);
    expect(tracker.pending.map(({ id }) => id)).toEqual(["7"]);
    expect(tracker.update(asleep, 0)).toEqual([]);
    tracker.answered("7");
    expect(tracker.pending).toEqual([]);
    expect(tracker.update(checking, 1)).toEqual([
      expect.objectContaining({ kind: "ended", how: "resolved" }),
    ]);
    // An id it never saw pending can't be marked answered.
    tracker.answered("8");
    expect(tracker.update(graphWith(undefined), 2)).toEqual([]);
  });
});

describe("the approval watch across a restart", () => {
  it.each([
    ["a gated call", "post", { text: "durable" }],
    ["a call that asked for itself", "note", { text: "durable", ask: true }],
  ] as const)(
    "keeps %s pending, tells the owner once, and logs no false end",
    async (_label, tool, args) => {
      const stub = env.AGENT.getByName(`approvals-watch-restart-${tool}`);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.blockConcurrencyWhile(async () => {});
        const agent = await openAgent([call(tool, args), say("Done.")], () =>
          openDurableObjectSqliteStorage(state.storage),
        );
        try {
          const before = seen();
          const first = approvalWatch(agent.harness, before, { now: () => agent.clock.now });
          let detach = await attach(agent.harness, first);
          const chat = await conversation(agent.harness);
          const submission = await send(agent.harness, chat.id, `${tool} durable`);
          const [ref] = approvalsIn(await pending(agent.harness));
          await eventually(() => before.told.length === 1);
          await detach();

          await agent.reopen();
          const after = seen();
          const second = approvalWatch(agent.harness, after, { now: () => agent.clock.now });
          detach = await attach(agent.harness, second);
          const graph = await pending(agent.harness);
          await eventually(async () => {
            await second.settled();
            return second.pending.some(({ id }) => id === ref!.id);
          });
          // Let any frames from the call checking again on reopen land.
          await new Promise((resolve) => setTimeout(resolve, 50));
          await second.settled();
          expect(second.pending.map(({ id }) => id)).toEqual([ref!.id]);
          expect(after.told).toEqual([]);
          expect(after.events).toEqual([]);
          expect((await agent.harness.snapshot(ApprovalNotices, ctx))?.notified).toEqual([ref!.id]);

          await resolveApproval(
            agent.harness,
            graph,
            ref!.id,
            answer("approve"),
            agent.clock.now,
            ctx,
          );
          second.answered(ref!.id);
          expect(second.pending).toEqual([]);
          const reacquired = await agent.harness.submission(submission.id, ctx);
          expect((await reacquired!.wait(ctx)).status).toBe("done");
          await eventually(() => after.events.length > 0);
          await detach();
          expect(after.events.map(({ kind }) => kind)).toEqual(["approval.resolved"]);
          expect(before.told).toHaveLength(1);
          expect(ran).toEqual([`${tool}:durable`]);
        } finally {
          await agent.close();
        }
      });
      await evictDurableObject(stub);
    },
  );
});

describe("the approval watch", () => {
  it("tells the owner once per request, also after a restart, and logs how it ended", async () => {
    const agent = await openAgent([call("post", { text: "ping" }), say("Posted.")]);
    try {
      const told: { id: string; text: string }[] = [];
      const events: DiagInput[] = [];
      let watched = false;
      const watch = () =>
        new ApprovalWatch({
          harness: agent.harness,
          delivery: {
            tellOwner: async (_tx, notice) => {
              told.push(notice);
              return true;
            },
          },
          tools: new Map([["post", postTool]]),
          diag: { emit: (event) => events.push(event) },
          watched: () => watched,
          now: () => agent.clock.now,
          report: (error) => {
            throw error;
          },
        });
      const chat = await conversation(agent.harness);
      const submission = await send(agent.harness, chat.id, "post ping");
      const graph = await pending(agent.harness);
      const [ref] = approvalsIn(graph);

      const first = watch();
      await first.observe(graph, ctx);
      await first.observe(graph, ctx);
      // A new object after a restart sees it requested again, but the owner was told already.
      await watch().observe(graph, ctx);
      expect(told).toEqual([
        {
          id: `approval:${ref!.id}`,
          text: 'Approval needed: Post "ping". Open MiPi on the web to approve or deny.',
        },
      ]);
      expect((await agent.harness.snapshot(ApprovalNotices, ctx))?.notified).toEqual([ref!.id]);

      await resolveApproval(agent.harness, graph, ref!.id, answer("approve"), agent.clock.now, ctx);
      first.answered(ref!.id);
      await submission.wait(ctx);
      await first.observe(await graphOf(agent.harness), ctx);
      expect(events.map(({ kind }) => kind)).toEqual([
        "approval.requested",
        "approval.requested",
        "approval.resolved",
      ]);
      // Told requests are forgotten once they leave the list.
      expect((await agent.harness.snapshot(ApprovalNotices, ctx))?.notified).toEqual([]);

      // Someone watching: nobody is pinged.
      watched = true;
      const quiet = watch();
      await quiet.observe(graph, ctx);
      expect(told).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });

  it("tells at the next open a request nobody was told about, and only once a door can reach the owner", async () => {
    const agent = await openAgent([call("post", { text: "missed" }), say("Posted.")]);
    try {
      const chat = await conversation(agent.harness);
      await send(agent.harness, chat.id, "post missed");
      const graph = await pending(agent.harness);
      const [ref] = approvalsIn(graph);

      // Watched when it was asked: nobody was pinged.
      const quiet = seen();
      await approvalWatch(agent.harness, quiet, { watched: () => true }).seed(graph, ctx);
      expect(quiet.told).toEqual([]);

      // Opened again with nobody watching, and no door that knows where the owner is: not marked told.
      let reach = false;
      const later = seen();
      await approvalWatch(agent.harness, later, { reach: () => reach }).seed(graph, ctx);
      expect(later.told).toEqual([]);
      expect((await agent.harness.snapshot(ApprovalNotices, ctx))?.notified ?? []).toEqual([]);

      // A door can reach them now: told once, and the seed logs nothing.
      reach = true;
      await approvalWatch(agent.harness, later, { reach: () => reach }).seed(graph, ctx);
      expect(later.told.map(({ id }) => id)).toEqual([`approval:${ref!.id}`]);
      expect(later.events).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  it("doesn't announce a request answered before its notice runs, or describe one that ended", async () => {
    const agent = await openAgent([call("post", { text: "quick" }), say("Posted.")]);
    try {
      const chat = await conversation(agent.harness);
      const submission = await send(agent.harness, chat.id, "post quick");
      const graph = await pending(agent.harness);
      const [ref] = approvalsIn(graph);
      const into = seen();
      const watch = approvalWatch(agent.harness, into);
      const noticed = watch.observe(graph, ctx);
      // Answered in the same tick, before the queued notice reads the list.
      watch.answered(ref!.id);
      await noticed;
      expect(into.told).toEqual([]);
      expect(into.events.map(({ kind }) => kind)).toEqual(["approval.requested"]);

      await resolveApproval(agent.harness, graph, ref!.id, answer("approve"), agent.clock.now, ctx);
      await submission.wait(ctx);
      // The ended task is still kept by `getTask`, but it asks nothing any more.
      expect(await describeApproval(agent.harness, ref!, new Map([["post", postTool]]), ctx)).toBe(
        undefined,
      );
    } finally {
      await agent.close();
    }
  });

  it("logs an approval that timed out or was aborted", async () => {
    const agent = await openAgent([
      call("post", { text: "a" }),
      say("Timed out."),
      call("post", { text: "b" }),
    ]);
    try {
      const events: DiagInput[] = [];
      const watch = new ApprovalWatch({
        harness: agent.harness,
        delivery: { tellOwner: async () => true },
        tools: new Map(),
        diag: { emit: (event) => events.push(event) },
        watched: () => true,
        now: () => agent.clock.now,
        report: (error) => {
          throw error;
        },
      });
      const chat = await conversation(agent.harness);
      const first = await send(agent.harness, chat.id, "post a");
      await watch.observe(await pending(agent.harness), ctx);
      agent.clock.now += 30 * MINUTE + 1;
      agent.harness.resume();
      await first.wait(ctx);
      await watch.observe(await graphOf(agent.harness), ctx);

      await send(agent.harness, chat.id, "post b");
      await watch.observe(await pending(agent.harness), ctx);
      await abortConversation((await agent.harness.conversation(chat.id, ctx))!, ctx);
      await watch.observe(await graphOf(agent.harness), ctx);

      expect(events.map(({ kind, outcome }) => `${kind}:${outcome}`)).toEqual([
        "approval.requested:held",
        "approval.expired:refused",
        "approval.requested:held",
        "approval.canceled:quiet",
      ]);
    } finally {
      await agent.close();
    }
  });
});
