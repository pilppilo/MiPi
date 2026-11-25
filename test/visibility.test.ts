/**
 * Conversation visibility (COD-211): the owner's conversations are the ownerless ones, and the memory pass plans its
 * wake from conversation records alone, reading no conversation's documents (so COD-198's archive can't turn every
 * plan into a read of every conversation).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type Harness as HarnessType,
  Harness,
  MemoryStorage,
  UserEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Origins } from "../src/agent/origin.ts";
import { composeMipi } from "../src/agent/composition.ts";
import { ConversationMeta } from "../src/agent/conversations.ts";
import { listVisible, OWNER_SCOPE, visiblePage } from "../src/agent/visibility.ts";
import { MEMORY_IDLE_MS, MemoryPassRuntime } from "../src/extensions/builtin/memory/memory-pass.ts";

const ctx = BACKGROUND_CONTEXT;

type Record_ = { id: number; owner?: { conversationId: number; taskId: number } };

/** A transaction that only scans the given conversation records, a page at a time, with the session's archive index. */
const scanning = (
  records: readonly Record_[],
  pageSize: number,
  archived: Record<string, number> = {},
) =>
  ({
    doc: async () => ({ archived }),
    scanConversations: async (_query: unknown, limit: number, cursor?: number) => {
      const start = cursor ?? 0;
      const size = Math.min(limit, pageSize);
      const items = records.slice(start, start + size);
      return start + size < records.length ? { items, next: start + size } : { items };
    },
  }) as never;

describe("conversation visibility", () => {
  it("lists ownerless conversations only, across pages, and pages with none still go on", async () => {
    const records: Record_[] = [
      { id: 1 },
      { id: 2, owner: { conversationId: 1, taskId: 9 } },
      { id: 3, owner: { conversationId: 1, taskId: 10 } },
      { id: 4 },
    ];
    const tx = scanning(records, 2);
    expect((await listVisible(tx, OWNER_SCOPE)).map(({ id }) => id)).toEqual([1, 4]);
    const first = await visiblePage(tx, OWNER_SCOPE, 1, undefined);
    expect(first.items.map(({ id }) => id)).toEqual([1]);
    const second = await visiblePage(tx, OWNER_SCOPE, 1, first.next as never);
    // A subagent's conversation: an empty page, with more to come.
    expect(second.items).toEqual([]);
    expect(second.next).toBeDefined();
  });

  it("leaves archived conversations out, from the session's index alone (COD-198)", async () => {
    const tx = scanning([{ id: 1 }, { id: 2 }, { id: 3 }], 10, { "2": 1_000 });
    expect((await listVisible(tx, OWNER_SCOPE, { recordsOnly: true })).map(({ id }) => id)).toEqual(
      [1, 3],
    );
  });

  it("plans the memory pass's wake without reading any conversation's document", async () => {
    const composition = composeMipi({
      models: createModels(),
      model: { provider: "faux", modelId: "faux-1" },
    });
    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      const at = Date.now();
      for (const text of ["first", "second"]) {
        await harness.commit(async (tx) => {
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await tx.appendEntry(UserEntry, conversation.id, {
            model: [{ role: "user", content: text, timestamp: at }],
          });
        }, ctx);
      }

      // Every document the planner asks for, by kind: in commits and through snapshots.
      const kinds: string[] = [];
      const recordDoc =
        (doc: (...args: unknown[]) => unknown) =>
        (token: unknown, ...rest: unknown[]) => {
          kinds.push((token as { definition: { kind: string } }).definition.kind);
          return doc(token, ...rest);
        };
      const watched = new Proxy(harness, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "commit") {
            return (change: (tx: unknown, ...rest: unknown[]) => unknown, context: unknown) =>
              target.commit(
                (tx, ...rest) =>
                  change(
                    new Proxy(tx, {
                      get(inner, name) {
                        const member = Reflect.get(inner, name, inner) as unknown;
                        if (typeof member !== "function") return member;
                        const bound = (member as (...args: unknown[]) => unknown).bind(inner);
                        return name === "doc" ? recordDoc(bound) : bound;
                      },
                    }),
                    ...rest,
                  ) as never,
                context as never,
              );
          }
          if (typeof value !== "function") return value;
          const bound = (value as (...args: unknown[]) => unknown).bind(target);
          return property === "snapshot" ? recordDoc(bound) : bound;
        },
      }) as HarnessType;

      const pass = new MemoryPassRuntime({
        harness: watched,
        models: createModels(),
        origins: new Origins([]),
        untrustedTools: new Set(),
        onWakeChange: () => {},
        report: (message, error) => {
          throw new Error(`${message}: ${String(error)}`);
        },
        now: () => at,
      });
      try {
        await pass.start();
        // It did plan: both conversations are due after their idle time.
        expect(pass.wake()).toEqual({ at: at + MEMORY_IDLE_MS, active: false });
        expect(kinds.length).toBeGreaterThan(0);
        expect(kinds).not.toContain(ConversationMeta.definition.kind);
        expect(kinds.every((kind) => kind.startsWith("app."))).toBe(true);
      } finally {
        pass.close();
      }
    } finally {
      await harness.close(ctx);
    }
  });
});
