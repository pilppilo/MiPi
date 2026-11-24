/**
 * Untrusted content (COD-209): output a page or another outside party wrote, which must not write itself into what MiPi
 * keeps (memory). An extension declares which of its tools return it (`MipiExtension.untrustedTools`); core answers
 * whether entries, or the run calling a tool, contain a call to one or its result. Core names no such tool.
 *
 * The declarations are kept by Pi Durable extension object, so a tool reads them back from its own registry snapshot
 * (`api.registry.installed()`) and nothing global is shared between agents.
 */
import {
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Extension,
  LiveDoc,
  type ToolRegistration,
  UserEntry,
} from "./pi/durable.ts";

const declared = new WeakMap<Extension, readonly string[]>();

/** Records that `extension`'s `tools` return untrusted content (`resolveExtensions` calls it for every extension). */
export function declareUntrustedTools(extension: Extension, tools: readonly string[]): void {
  if (tools.length > 0) declared.set(extension, [...tools]);
}

/** The untrusted tool names of `installed` (e.g. a tool's `api.registry.installed()`), whoever registered them. */
export function untrustedToolNames(installed: readonly Extension[]): ReadonlySet<string> {
  return new Set(installed.flatMap((extension) => declared.get(extension) ?? []));
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
