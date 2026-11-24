/**
 * Conversation visibility (COD-211): which conversations count as the owner's own, for anything that looks across
 * them (history search, the memory pass). Today that is every ownerless conversation: a subagent's conversation belongs
 * to the tool that made it. 0.2 builds on this: archived conversations drop out (COD-198), and bots get a scope of their
 * own (COD-197). Core code: callers never scan conversations and filter themselves.
 *
 * `recordsOnly` is for planners that look often (the memory pass's wake): the answer comes from the conversation
 * records alone, never from a conversation's documents, so a look stays a short scan however many conversations there
 * are. Today every answer does; an archive must keep that true for this mode (a session-level index, not a field read
 * per conversation).
 */
import type { ConversationRecord, Cursor, Tx } from "./pi/durable.ts";

/** Whose conversations: the owner's (ownerless, not archived). Bots add theirs later. */
export type VisibilityScope = { readonly kind: "owner" };

export const OWNER_SCOPE: VisibilityScope = { kind: "owner" };

export interface VisibleOptions {
  /** Decide from conversation records (and session documents) only, reading no conversation's documents. */
  readonly recordsOnly?: boolean;
}

/** The scan's page size when the caller doesn't page itself. */
const PAGE = 100;

function visible(record: ConversationRecord, scope: VisibilityScope): boolean {
  switch (scope.kind) {
    case "owner":
      return record.owner === undefined;
    default: {
      const _: never = scope.kind;
      throw new Error("Unknown visibility scope");
    }
  }
}

/**
 * One page of the conversations visible in `scope`, for a caller that reads each page in a commit of its own (history
 * search), so a scan never holds the commit line for long. A page may hold fewer than `limit`, or none, with more to
 * come: go on while `next` is set.
 */
export async function visiblePage(
  tx: Tx,
  scope: VisibilityScope,
  limit: number,
  cursor: Cursor | undefined,
  // Every answer is from the records today; the option is the caller's promise to keep it so (see above).
  _options: VisibleOptions = {},
): Promise<{ readonly items: readonly ConversationRecord[]; readonly next?: Cursor }> {
  const page = await tx.scanConversations({}, limit, cursor);
  const items = page.items.filter((record) => visible(record, scope));
  return page.next === undefined ? { items } : { items, next: page.next };
}

/** Every conversation visible in `scope`, in one commit. */
export async function listVisible(
  tx: Tx,
  scope: VisibilityScope,
  options: VisibleOptions = {},
): Promise<ConversationRecord[]> {
  const found: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await visiblePage(tx, scope, PAGE, cursor, options);
    found.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}
