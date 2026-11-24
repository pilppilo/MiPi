/**
 * Untrusted content (COD-209): output a page or another outside party wrote, which must not write itself into what MiPi
 * keeps (memory). An extension declares which of its tools return it (`MipiExtension.untrustedTools`); core answers
 * whether entries, or the run calling a tool, contain a call to one or its result. Core names no such tool.
 *
 * What a composition declared is kept on its own core extension object (`bindUntrustedTools`), which `composeAgent`
 * makes fresh for every agent: a tool reads it back from its registry snapshot, and nothing is shared between
 * compositions or left behind by an earlier one.
 */
import {
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Extension,
  LiveDoc,
  type RegistrySnapshot,
  type ToolRegistration,
  UserEntry,
} from "./pi/durable.ts";

/** The name of core's own extension (the preamble), which carries the composition's untrusted tools. */
export const CORE_EXTENSION_NAME = "chat";

const bound = new WeakMap<Extension, ReadonlySet<string>>();

/** Records the composition's untrusted tool names on its core extension (`composeAgent`). */
export function bindUntrustedTools(core: Extension, tools: ReadonlySet<string>): void {
  bound.set(core, new Set(tools));
}

/** The untrusted tool names of the agent a registry belongs to (a tool's `api.registry`); none if it bound none. */
export function untrustedToolNames(
  registry: Pick<RegistrySnapshot, "extension">,
): ReadonlySet<string> {
  const core = registry.extension(CORE_EXTENSION_NAME);
  return (core === undefined ? undefined : bound.get(core)) ?? new Set();
}

/** Whether an entry is a call to one of `tools` or its result. */
export function entryTouches(entry: EntryRecord, tools: ReadonlySet<string>): boolean {
  if (tools.size === 0) return false;
  return (entry.model ?? []).some(
    (message) =>
      (message.role === "toolResult" && tools.has(message.toolName)) ||
      (message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && tools.has(part.name))),
  );
}

const PAGE = 100;

type ScanTx = Parameters<Parameters<Parameters<ToolRegistration["execute"]>[1]["commit"]>[0]>[0];

/**
 * Whether the run calling a tool has called one of `tools`: its entries from `run.first` on. A run without `first` (one
 * started before it was recorded) is read back to its last user message. A call in the same answer as the asking tool
 * counts too, since that answer is committed before its tools run.
 */
export async function runTouched(
  tx: ScanTx,
  conversationId: ConversationId,
  tools: ReadonlySet<string>,
): Promise<boolean> {
  if (tools.size === 0) return false;
  const first = (await tx.doc(LiveDoc, conversationId)).run?.first as EntryId | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries(
      first === undefined
        ? { conversationId, order: "descending" }
        : { conversationId, minEntryId: first, order: "ascending" },
      PAGE,
      cursor,
    );
    for (const entry of page.items) {
      if (entryTouches(entry, tools)) return true;
      if (first === undefined && UserEntry.is(entry)) return false;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}
