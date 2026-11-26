/**
 * The Pi Durable seam for server code. Everything MiPi's server uses from `@earendil-works/pi-durable` is named here,
 * so a breaking upgrade (a rename, a moved export, a changed shape) fails to compile in this folder first and is fixed
 * here. The lint rule in `.oxlintrc.json` keeps other folders from importing the package directly; the contract test
 * (`test/contract.test.ts`) calls each value once.
 *
 * Adding a name: export it here, then use it through this file.
 */
import type { Conversation } from "@earendil-works/pi-durable";
import type { Context } from "./context.ts";

/**
 * `Conversation.abort()` (COD-198): withdraws the queued inputs, aborts the run and waits until the conversation is
 * idle. Background tasks (reminders) survive. Named here so an upgrade that changes it fails in this folder.
 */
export function abortConversation(conversation: Conversation, context: Context): Promise<void> {
  return conversation.abort(context);
}

export {
  AssistantEntry,
  configure,
  ConversationIdle,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  hookTask,
  Harness,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  section,
  UsageDoc,
  UserEntry,
} from "@earendil-works/pi-durable";

export type {
  Conversation,
  ConversationId,
  ConversationRecord,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  Extension,
  HarnessOptions,
  HookApi,
  RegistrySnapshot,
  SubmissionId,
  SubmissionRecord,
  TaskGraph,
  ToolExecutionApi,
  ToolRegistration,
  Tx,
  Wake,
  WatchHandle,
} from "@earendil-works/pi-durable";
