/**
 * The contract between MiPi and Pi Durable: every name `src/agent/pi/` exports, used once against the real packages
 * on real Durable Object SQLite (only the model is faked). After a Pi Durable upgrade this is the test that fails
 * first and names the seam file to fix.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createBot, createCobot } from "../src/agent/bots.ts";
import { createHarnessOptions } from "../src/agent/composition.ts";
import { ConversationMeta } from "../src/agent/conversations.ts";
import { parseServerEventEnvelope } from "../src/protocol.ts";
import { CORE_PREAMBLE } from "../src/agent/harness.ts";
import { PROFILES } from "./mipi.ts";
import * as ai from "../src/agent/pi/ai.ts";
import * as context from "../src/agent/pi/context.ts";
import * as durable from "../src/agent/pi/durable.ts";
import * as schema from "../src/agent/pi/schema.ts";
import * as shared from "../src/agent/pi/shared.ts";
import { openDurableObjectSqliteStorage } from "../src/agent/pi/sqlite.ts";
import {
  BUILT_IN_TASKS,
  storedSchemaVersion,
  storedTaskVersions,
  SUPPORTED_SCHEMA_VERSION,
  supportedTaskVersions,
  tasksNewerThanSupported,
} from "../src/agent/pi/storage.ts";
import {
  type ExportCursor,
  type ExportHeader,
  exportHeader,
  exportPage,
  type ExportRow,
  restoreRows,
  restoreSchema,
  rowCounts,
  tablesWithoutRowid,
} from "../src/agent/maintenance.ts";
import { DeliverScheduledInstruction } from "../src/extensions/builtin/reminders/schedule-task.ts";

const ctx = context.BACKGROUND_CONTEXT;
/** How a submission settles when an afterTools hook task ends its run (pinned by the hooks test). */
const TERMINATED_STATUS = "done";

/** Every runtime name of a seam module, each defined (a type-only export never shows up here). */
const runtimeNames = (module: Record<string, unknown>): string[] => {
  for (const [name, value] of Object.entries(module)) {
    expect(value, `${name} is undefined: the package no longer exports it`).toBeDefined();
  }
  return Object.keys(module).sort();
};

describe("Pi seam contract", () => {
  it("exports exactly the names MiPi uses, all defined", () => {
    // Adding a name to a seam file means adding it here too, on purpose.
    expect(runtimeNames(durable)).toEqual([
      "AssistantEntry",
      "ConversationIdle",
      "GenerationTask",
      "Harness",
      "InboxDoc",
      "LiveDoc",
      "ProviderDoc",
      "UsageDoc",
      "UserEntry",
      "abortConversation",
      "configure",
      "createRegistry",
      "defineDoc",
      "defineDocFamily",
      "defineExtension",
      "defineTask",
      "hook",
      "hookTask",
      "section",
    ]);
    expect(runtimeNames(shared)).toEqual([
      "BACKGROUND_CONTEXT",
      "CompactionEntry",
      "ConversationTranscript",
      "ResetEntry",
      "ToolResultEntry",
      "applyImmutable",
      "assertValidOp",
    ]);
    expect(runtimeNames(schema)).toEqual(["int", "obj", "oneOf", "opt", "str"]);
    expect(runtimeNames(ai)).toEqual(["isRetryableErrorText"]);
    expect(ai.isRetryableErrorText("429 Too Many Requests")).toBe(true);
    expect(ai.isRetryableErrorText("429 GoUsageLimitError")).toBe(false);
    expect(runtimeNames(context)).toEqual(["BACKGROUND_CONTEXT"]);
    expect(shared.BACKGROUND_CONTEXT).toBe(context.BACKGROUND_CONTEXT);
  });

  it("runs a tool-using turn through the seam on Durable Object SQLite", async () => {
    let exported:
      | { header: ExportHeader; rows: ExportRow[]; counts: Record<string, number> }
      | undefined;
    const stub = env.AGENT.getByName("contract-turn");
    await runInDurableObject(stub, async (_instance, state) => {
      // Let MipiAgent finish opening its own harness before opening one beside it.
      await state.blockConcurrencyWhile(async () => {});

      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("echo", { text: "hi", times: 2, mode: "plain" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("Echoed.")]),
        fauxAssistantMessage([fauxText("Admitted in a commit.")]),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);

      const Notes = durable.defineDoc<{ count: number }>({
        kind: "contract.notes",
        version: 1,
        scope: "session",
        initial: () => ({ count: 0 }),
        checkpointWhen: () => false,
      });
      const Marks = durable.defineDocFamily<{ seen: boolean }, null>({
        family: true,
        kind: "contract.marks",
        version: 1,
        scope: "session",
        initial: () => ({ seen: false }),
        checkpointWhen: () => false,
      });
      let runFirst: number | undefined;
      const echo: durable.ToolRegistration = {
        name: "echo",
        description: "Echo text",
        parameters: schema.obj({
          text: schema.str({ minLength: 1 }),
          times: schema.opt(schema.int({ minimum: 1, maximum: 3 })),
          mode: schema.oneOf(["plain", "loud"]),
        }),
        replay: "safe",
        execute: async (args: { text: string; times?: number }, api, context) => {
          // What `remember`'s fetch gate reads (M8): a running tool sees its run's first entry in `pi.live`.
          runFirst = (await api.snapshot(durable.LiveDoc, api.conversationId, context))?.run?.first;
          return { output: [{ type: "text" as const, text: args.text.repeat(args.times ?? 1) }] };
        },
      };
      const extension = durable.defineExtension({
        name: "contract",
        tasks: [DeliverScheduledInstruction],
        tools: [echo],
        sections: [durable.section("contract", () => "Contract test.", { tag: false })],
      });
      const registry = durable.createRegistry();
      registry.install(extension);

      const storage = await openDurableObjectSqliteStorage(state.storage);
      const harness = await durable.Harness.open(
        storage,
        {
          models,
          registry,
          settings: { extensions: [extension] },
          conversationCreated: (tx, conversation) =>
            conversation.parent === undefined
              ? durable.configure(tx, conversation.id, {
                  model: { provider: "faux", modelId: "faux-1" },
                  tools: [echo],
                })
              : undefined,
        },
        ctx,
      );
      try {
        const root = await harness.root(ctx);
        const submission = await root.submit(
          { type: "input", content: "Echo hi twice", requestId: "contract-1" },
          ctx,
        );
        await submission.wait(ctx);
        await harness.waitForIdle(ctx);

        await root.commit(async (tx) => {
          (await tx.doc(Notes)).count += 1;
          (await tx.doc(Marks, "a", null)).seen = true;
        }, ctx);
        expect(await harness.snapshot(Notes, ctx)).toEqual({ count: 1 });

        // The built-in documents conversation titles read and add to: the provider session id and the usage ledger.
        expect(typeof (await harness.snapshot(durable.ProviderDoc, root.id, ctx))?.sessionId).toBe(
          "string",
        );
        expect(
          Object.keys((await harness.snapshot(durable.UsageDoc, root.id, ctx))?.models ?? {}),
        ).toEqual(["faux/faux-1"]);

        const entries = (await root.entries({}, 50, undefined, ctx)).items;
        // `run.first` is the run's first entry: the user message the echo call answers.
        expect(runFirst).toBe(entries.find((entry) => durable.UserEntry.is(entry))?.id);
        expect(entries.some((entry) => durable.UserEntry.is(entry))).toBe(true);
        expect(entries.some((entry) => durable.AssistantEntry.is(entry))).toBe(true);
        const messages = (await root.context(ctx)).messages;
        expect(messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ role: "toolResult", isError: false })]),
        );

        // Telegram admission (M5): a document read, then `admit(tx, …)`, then document writes, in one commit; a table
        // write before the admit is refused. The settled record and its answer are read back in a commit, and a
        // submission is reacquired by id to wait for it.
        await expect(
          harness.commit(async (tx) => {
            await tx.createConversation({ ownership: { kind: "ownerless" } });
            await root.admit(tx, { type: "input", content: "Too late", requestId: "contract-x" });
          }, ctx),
        ).rejects.toThrow();
        const admittedId = await harness.commit(async (tx) => {
          const before = (await tx.doc(Notes)).count;
          expect(await tx.submissionByRequest(root.id, "contract-2")).toBeUndefined();
          const id = await root.admit(tx, {
            type: "input",
            content: "Admit me",
            requestId: "contract-2",
            whenBusy: "followUp",
          });
          (await tx.doc(Notes)).count = before + 1;
          return id;
        }, ctx);
        const reacquired = await harness.submission(admittedId, ctx);
        expect((await reacquired!.wait(ctx)).status).toBe("done");
        await harness.waitForIdle(ctx);
        const answer = await harness.commit(async (tx) => {
          const record = await tx.submission(admittedId);
          expect((await tx.submissionByRequest(root.id, "contract-2"))?.id).toBe(admittedId);
          if (record?.type !== "input" || record.status !== "done") return undefined;
          const entry = await tx.entry(record.answer);
          return entry?.model?.[0]?.role === "assistant" ? entry.model[0].content : undefined;
        }, ctx);
        expect(answer).toEqual([expect.objectContaining({ text: "Admitted in a commit." })]);
        expect(await harness.snapshot(Notes, ctx)).toEqual({ count: 2 });

        // Bursts (COD-174): an idle conversation refuses `whenIdle: "reject"` input with `ConversationIdle` before
        // anything is written, and the same commit goes on to write documents; `pi.live` and `pi.inbox` read idle.
        const staged = await harness.commit(async (tx) => {
          expect((await tx.doc(durable.LiveDoc, root.id)).run).toBeUndefined();
          expect((await tx.doc(durable.InboxDoc, root.id)).items).toEqual([]);
          try {
            await root.admit(tx, {
              type: "input",
              content: "Wait for the window",
              requestId: "contract-idle",
              whenIdle: "reject",
              whenBusy: "followUp",
            });
            return false;
          } catch (error) {
            expect(error).toBeInstanceOf(durable.ConversationIdle);
            (await tx.doc(Notes)).count += 1;
            return true;
          }
        }, ctx);
        expect(staged).toBe(true);
        expect(await harness.snapshot(Notes, ctx)).toEqual({ count: 3 });
        await harness.commit(async (tx) => {
          expect(await tx.submissionByRequest(root.id, "contract-idle")).toBeUndefined();
        }, ctx);

        // The storage readers the M2b guard depends on.
        expect(SUPPORTED_SCHEMA_VERSION).toBeGreaterThan(0);
        expect(storedSchemaVersion(state.storage.sql)).toBe(SUPPORTED_SCHEMA_VERSION);
        const stored = storedTaskVersions(state.storage.sql);
        expect(stored).toMatchObject({ "pi.tool": 4, "pi.generation": 3 });
        const supported = supportedTaskVersions([DeliverScheduledInstruction]);
        expect(supported).toMatchObject({
          "pi.tool": 4,
          "pi.generation": 3,
          "pi.compaction": 1,
          "app.deliver-scheduled-instruction": 1,
        });
        expect(tasksNewerThanSupported(stored, supported)).toEqual([]);

        // The backup copies Pi Durable's tables by rowid: every table has one, and an export restores row for row.
        const sql = state.storage.sql;
        expect(tablesWithoutRowid(sql)).toEqual([]);
        const header = exportHeader(sql);
        const rows: ExportRow[] = [];
        let cursor: ExportCursor | undefined;
        do {
          const page = exportPage(sql, header.schema, cursor);
          rows.push(...page.rows);
          cursor = page.next;
        } while (cursor !== undefined);
        exported = { header, rows, counts: rowCounts(sql) };
      } finally {
        await harness.close(ctx);
      }
    });

    // Into a fresh object, as a restore does: the same rows come back.
    await runInDurableObject(
      env.AGENT.getByName("contract-turn-copy"),
      async (_instance, state) => {
        await state.blockConcurrencyWhile(async () => {});
        await state.storage.deleteAll();
        restoreSchema(state.storage.sql, exported!.header);
        restoreRows(state.storage.sql, exported!.header.schema, exported!.rows);
        expect(rowCounts(state.storage.sql)).toEqual(exported!.counts);
      },
    );
    await evictDurableObject(stub);
  });

  it("runs hook tasks on a run: onYield sees the answer, afterTools can end the run", async () => {
    const stub = env.AGENT.getByName("contract-hooks");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      const faux = fauxProvider();
      faux.setResponses([
        // First input: one tool round, then the answer.
        fauxAssistantMessage([fauxToolCall("fail", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("First answer.")]),
        // Second input: its tool round is the last one allowed.
        fauxAssistantMessage([fauxToolCall("fail", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("Never asked for.")]),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);

      const Seen = durable.defineDoc<{
        yields: Array<{ answer: number; inputs: string[]; committed: boolean }>;
        rounds: Array<{ results: number; errors: number }>;
      }>({
        kind: "contract.seen",
        version: 1,
        scope: "session",
        initial: () => ({ yields: [], rounds: [] }),
        checkpointWhen: () => false,
      });
      const OnYield = durable.defineTask<
        Record<string, never>,
        { phase: "go" },
        Record<string, never>
      >({
        name: "contract.on-yield",
        version: 1,
        initial: () => ({ phase: "go" }),
        phases: {
          go: async (_task, runtime, taskContext) => {
            await runtime.commit(async (tx) => {
              const run = (await tx.doc(durable.LiveDoc, runtime.conversationId)).run;
              const answer = run?.yield?.answer;
              if (run !== undefined && answer !== undefined) {
                const seen = await tx.doc(Seen);
                seen.yields = [
                  ...seen.yields,
                  {
                    answer: Number(answer),
                    inputs: run.inputs.map(String),
                    committed: (await tx.entry(answer)) !== undefined,
                  },
                ];
              }
              return { status: "terminal", outcome: { status: "completed", result: {} } };
            }, taskContext);
          },
        },
        abort: async (_task, runtime, taskContext) => {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            taskContext,
          );
        },
      });
      const AfterTools = durable.defineTask<
        { readonly results: number[] },
        { phase: "go" },
        { terminate?: true }
      >({
        name: "contract.after-tools",
        version: 1,
        initial: () => ({ phase: "go" }),
        phases: {
          go: async (task, runtime, taskContext) => {
            let errors = 0;
            for (const id of task.input.results) {
              const message = (await runtime.entry(id as never, taskContext))?.model?.[0];
              if (message?.role === "toolResult" && message.isError) errors += 1;
            }
            await runtime.commit(async (tx) => {
              const seen = await tx.doc(Seen);
              seen.rounds = [...seen.rounds, { results: task.input.results.length, errors }];
              return {
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: seen.rounds.length >= 2 ? { terminate: true } : {},
                },
              };
            }, taskContext);
          },
        },
        abort: async (_task, runtime, taskContext) => {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            taskContext,
          );
        },
      });
      const fail: durable.ToolRegistration = {
        name: "fail",
        description: "Always fails",
        parameters: schema.obj({}),
        replay: "safe",
        execute: async () => {
          throw new Error("broken on purpose");
        },
      };
      const extension = durable.defineExtension({
        name: "contract-hooks",
        tasks: [OnYield, AfterTools],
        tools: [fail],
        hooks: [
          durable.hook(durable.GenerationTask, {
            onYield: async () => ({
              kind: "tasks" as const,
              tasks: [durable.hookTask(OnYield, {})],
            }),
            afterTools: async (_assistant, results) => ({
              tasks: [durable.hookTask(AfterTools, { results: results.map(Number) })],
            }),
          }),
        ],
      });
      const registry = durable.createRegistry();
      registry.install(extension);
      const storage = await openDurableObjectSqliteStorage(state.storage);
      const harness = await durable.Harness.open(
        storage,
        {
          models,
          registry,
          settings: { extensions: [extension] },
          conversationCreated: (tx, conversation) =>
            conversation.parent === undefined
              ? durable.configure(tx, conversation.id, {
                  model: { provider: "faux", modelId: "faux-1" },
                  tools: [fail],
                })
              : undefined,
        },
        ctx,
      );
      try {
        const root = await harness.root(ctx);
        const first = await root.submit(
          { type: "input", content: "One", requestId: "hooks-1" },
          ctx,
        );
        const done = await first.wait(ctx);
        await harness.waitForIdle(ctx);
        // The answer the onYield task read is the one the submission settled with, and was already committed.
        expect(done.status).toBe("done");
        const seen = await harness.snapshot(Seen, ctx);
        expect(seen?.yields).toHaveLength(1);
        expect(seen?.yields[0]).toMatchObject({ inputs: [String(first.id)], committed: true });
        expect(done.status === "done" ? Number(done.answer) : undefined).toBe(
          seen?.yields[0]?.answer,
        );
        expect(seen?.rounds).toEqual([{ results: 1, errors: 1 }]);

        // `{ terminate: true }` from afterTools ends the run: no further request, and the input settles unanswered.
        const second = await root.submit(
          { type: "input", content: "Two", requestId: "hooks-2" },
          ctx,
        );
        const stopped = await second.wait(ctx);
        await harness.waitForIdle(ctx);
        expect(stopped.status).toBe(TERMINATED_STATUS);
        expect((await harness.snapshot(Seen, ctx))?.rounds).toHaveLength(2);
        expect(faux.state.callCount).toBe(3);
      } finally {
        await harness.close(ctx);
      }
    });
    await evictDurableObject(stub);
  });

  it("renders a bot's purpose as one section after the rest, and keeps its prefix turn to turn (COD-197)", async () => {
    const stub = env.AGENT.getByName("contract-purpose");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      // Every request, as the model got it: two for each bot, a turn apart.
      const requests: Array<{ readonly system: SystemMessage[]; readonly messages: Message[] }> =
        [];
      const faux = fauxProvider();
      faux.setResponses(
        Array.from({ length: 4 }, (_, index) => (request: { messages: Message[] }) => {
          const messages = structuredClone(request.messages);
          requests.push({
            system: messages.filter(
              (message): message is SystemMessage => message.role === "system",
            ),
            messages,
          });
          return fauxAssistantMessage([fauxText(`Reply ${index + 1}`)]);
        }),
      );
      const models = createModels();
      models.setProvider(faux.provider);
      const harness = await durable.Harness.open(
        await openDurableObjectSqliteStorage(state.storage),
        createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
        ctx,
      );
      try {
        const make = (name: string, purpose?: string) =>
          harness.commit(
            (tx) =>
              createBot(
                tx,
                {
                  kind: "bot",
                  name,
                  ...(purpose === undefined ? {} : { purpose }),
                  profile: "default",
                  createdBy: "owner",
                },
                PROFILES,
              ),
            ctx,
          );
        const ask = async (id: durable.ConversationId, content: string) => {
          const conversation = (await harness.conversation(id, ctx))!;
          await (await conversation.submit({ type: "input", content }, ctx)).wait(ctx);
          await harness.waitForIdle(ctx);
        };
        const plain = await make("Plain");
        const groceries = await make("Groceries", "Keep the shopping list.");
        await ask(plain, "Hello");
        await ask(groceries, "Hello");
        await ask(groceries, "Add milk");
        await ask(plain, "Still there?");

        const sectionsOf = (system: readonly SystemMessage[]) =>
          Object.assign({}, ...system.map(({ sections }) => sections ?? {})) as Record<
            string,
            string | null
          >;
        const [plainFirst, groceriesFirst, groceriesSecond, plainSecond] = requests;
        const plainSections = sectionsOf(plainFirst!.system);
        const purposeSections = sectionsOf(groceriesFirst!.system);
        // The preamble and its stamp rule, exactly as every conversation has them.
        expect(plainSections["preamble"]).toBe(CORE_PREAMBLE);
        expect(plainSections["instructions"]).toBeUndefined();
        // The purpose is one more section, after every extension section; the rest is the plain bot's, unchanged.
        expect(Object.keys(purposeSections)).toEqual([
          ...Object.keys(plainSections),
          "instructions",
        ]);
        // Pi Durable renders it between tags of its own: pinned, so an upgrade that changes the form fails here.
        expect(purposeSections).toEqual({
          ...plainSections,
          instructions: "<instructions>\nKeep the shopping list.\n</instructions>",
        });
        // Turn to turn, each bot's earlier request is an exact prefix of its next: the purpose is part of the
        // cacheable prefix, not a message that moves.
        for (const [first, second] of [
          [plainFirst!, plainSecond!],
          [groceriesFirst!, groceriesSecond!],
        ] as const) {
          expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
          expect(second.system).toEqual(first.system);
        }
      } finally {
        await harness.close(ctx);
      }
    });
    await evictDurableObject(stub);
  });

  it("stores and publishes a task-owned subagent's link back to its bot (COD-200)", async () => {
    const stub = env.AGENT.getByName("contract-subagent-owner");
    const { cobot, child, latestEntryId } = await runInDurableObject(
      stub,
      async (_instance, state) => {
        await state.blockConcurrencyWhile(async () => {});
        const faux = fauxProvider();
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        faux.setResponses([
          fauxAssistantMessage(
            [fauxToolCall("search_history", { question: "What did we decide?" })],
            {
              stopReason: "toolUse",
            },
          ),
          async () => {
            started.resolve();
            await finish.promise;
            return fauxAssistantMessage([fauxText("We picked tea.")]);
          },
          fauxAssistantMessage([fauxText("The answer is tea.")]),
        ]);
        const models = createModels();
        models.setProvider(faux.provider);
        const harness = await durable.Harness.open(
          await openDurableObjectSqliteStorage(state.storage),
          createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
          ctx,
        );
        try {
          const bot = await harness.commit(
            (tx) =>
              createBot(
                tx,
                { kind: "bot", name: "Kitchen", profile: "default", createdBy: "owner" },
                PROFILES,
              ),
            ctx,
          );
          const cobot = await harness.commit((tx) => createCobot(tx, bot, "Tea", PROFILES), ctx);
          const conversation = (await harness.conversation(cobot, ctx))!;
          const submission = await conversation.submit(
            { type: "input", content: "Look up our decision." },
            ctx,
          );
          await Promise.race([started.promise, submission.wait(ctx)]);
          const child = await harness.commit(async (tx) => {
            const { items } = await tx.scanConversations({ ownerConversationId: cobot }, 10);
            expect(items).toHaveLength(1);
            const record = items[0]!;
            expect(record.owner).toEqual({ conversationId: cobot, taskId: expect.any(Number) });
            const byTask = await tx.scanConversations({ ownerTaskId: record.owner!.taskId }, 10);
            expect(byTask.items.map(({ id }) => id)).toEqual([record.id]);
            expect((await tx.doc(ConversationMeta, record.owner!.conversationId)).bot).toBe(bot);
            return record.id;
          }, ctx);
          finish.resolve();
          expect((await submission.wait(ctx)).status).toBe("done");
          const latestEntryId = await harness.commit((tx) => tx.latestEntryId(child), ctx);
          expect(latestEntryId).toEqual(expect.any(Number));
          return { cobot, child, latestEntryId };
        } finally {
          finish.resolve();
          await harness.close(ctx);
        }
      },
    );
    await evictDurableObject(stub);
    const response = await stub.fetch(
      new Request("https://example.com/api/sessions/contract-subagent-owner", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const message = new Promise<MessageEvent>((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    socket.accept();
    try {
      const snapshot = parseServerEventEnvelope(String((await message).data));
      expect(snapshot.type).toBe("session.snapshot");
      if (snapshot.type !== "session.snapshot") throw new Error("Expected a session snapshot");
      expect(snapshot.session.conversations.find(({ id }) => id === child)).toEqual({
        id: child,
        owner: { conversationId: cobot },
        latestEntryId,
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("aborts a conversation's run and withdraws its queued input (COD-198)", async () => {
    const stub = env.AGENT.getByName("contract-abort");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      const started = Promise.withResolvers<void>();
      const faux = fauxProvider();
      // The run's one request hangs until the abort cancels it.
      faux.setResponses([
        async (_request, options) => {
          started.resolve();
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
            if (options?.signal?.aborted) abort();
            else options?.signal?.addEventListener("abort", abort, { once: true });
          });
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const storage = await openDurableObjectSqliteStorage(state.storage);
      const harness = await durable.Harness.open(
        storage,
        {
          models,
          registry: durable.createRegistry(),
          conversationCreated: (tx, conversation) =>
            durable.configure(tx, conversation.id, {
              model: { provider: "faux", modelId: "faux-1" },
              thinkingLevel: "off",
              tools: [],
            }),
        },
        ctx,
      );
      try {
        const root = await harness.root(ctx);
        const running = await root.submit(
          { type: "input", content: "Hang", requestId: "abort-1" },
          ctx,
        );
        await started.promise;
        const queued = await root.submit(
          { type: "input", content: "Queued", requestId: "abort-2", whenBusy: "followUp" },
          ctx,
        );
        await durable.abortConversation(root, ctx);
        const [first, second] = await harness.commit(
          async (tx) => [await tx.submission(running.id), await tx.submission(queued.id)] as const,
          ctx,
        );
        // Settled, not left running: the run was aborted and the queued input withdrawn, unanswered both.
        expect(first?.status).toBe("unanswered");
        expect(second?.status).toBe("unanswered");
        expect(faux.state.callCount).toBe(1);
      } finally {
        await harness.close(ctx);
      }
    });
    await evictDurableObject(stub);
  });

  it("reports stored tasks newer than this build", () => {
    const supported = supportedTaskVersions([]);
    expect(BUILT_IN_TASKS.map(({ definition }) => definition.name)).toEqual([
      "pi.tool",
      "pi.generation",
      "pi.compaction",
    ]);
    expect(
      tasksNewerThanSupported({ "pi.tool": 5, "pi.generation": 3, "other.kind": 9 }, supported),
    ).toEqual([{ kind: "pi.tool", stored: 5, supported: 4 }]);
  });

  it("applies chord deltas the client receives", () => {
    const op: shared.Op = ["s", ["a"], 1];
    expect(() => shared.assertValidOp(op)).not.toThrow();
    expect(shared.applyImmutable({ a: 0, b: 2 }, [op])).toEqual({ a: 1, b: 2 });
  });
});
