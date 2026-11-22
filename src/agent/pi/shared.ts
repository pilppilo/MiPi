/**
 * The Pi seam for code that also runs in the browser: `src/protocol.ts` and `src/client/`. Only browser-safe values
 * (transcript entry kinds, chord's delta helpers, the background context) and types. See `durable.ts` for why the
 * seam exists.
 */
export { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
export { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta";
export type { JsonValue } from "@earendil-works/chord/json";
export type { AssistantMessage, Message, NestedToolCalls } from "@earendil-works/pi-ai";
export {
  CompactionEntry,
  ConversationTranscript,
  ResetEntry,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
export type {
  AgentState,
  BlockedReason,
  CompactionReason,
  ConversationView,
  Cursor,
  EntryRecord,
  InboxState,
  LiveState,
  Page,
  RunFailure,
  TaskGraph,
  TaskGraphNode,
  TaskGraphState,
  ToolDiagnostic,
  TranscriptItem,
  TranscriptView,
  UsageState,
} from "@earendil-works/pi-durable";
