/**
 * The Pi Durable seam for server code. Everything MiPi's server uses from `@earendil-works/pi-durable` is named here,
 * so a breaking upgrade (a rename, a moved export, a changed shape) fails to compile in this folder first and is fixed
 * here. The lint rule in `.oxlintrc.json` keeps other folders from importing the package directly; the contract test
 * (`test/contract.test.ts`) calls each value once.
 *
 * Adding a name: export it here, then use it through this file.
 */
export {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  Harness,
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
  HarnessOptions,
  TaskGraph,
  ToolExecutionApi,
  ToolRegistration,
  Wake,
  WatchHandle,
} from "@earendil-works/pi-durable";
