/**
 * The Pi Durable seam for server code. Everything MiPi's server uses from `@earendil-works/pi-durable` is named here,
 * so a breaking upgrade (a rename, a moved export, a changed shape) fails to compile in this folder first and is fixed
 * here. The lint rule in `.oxlintrc.json` keeps other folders from importing the package directly; the contract test
 * (`test/contract.test.ts`) calls each value once.
 *
 * Adding a name: export it here, then use it through this file.
 */
import type {
  Conversation,
  ToolRegistration as PiToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "./context.ts";

/** A call's arguments as a policy reads them: a model's call (pi-ai) and a nested call (Pi Durable) alike. */
export type CallArguments = Readonly<Record<string, unknown>>;

/** What the owner is asked about one call: one line of what it will do, and why it needs a yes. */
export type ApprovalAsk = { readonly summary: string; readonly reason: string };

/**
 * How a tool asks the owner before it acts (COD-173, `src/agent/approvals.ts`). `gate`: core's `beforeTool` gate parks
 * every call (or those `when` picks) before it runs. `self`: the tool decides in `execute()` and asks through
 * `awaitApproval`, for a need only its own transaction can see. `describe` words the request either way.
 */
export type ApprovalPolicy =
  | {
      readonly kind: "gate";
      readonly describe: (args: CallArguments) => ApprovalAsk;
      /** Which calls ask. Default: every call. */
      readonly when?: (args: CallArguments) => boolean;
      /** How long the owner has to answer. Default: `DEFAULT_APPROVAL_TTL_MS`. */
      readonly ttlMs?: number;
    }
  | {
      readonly kind: "self";
      readonly describe: (args: CallArguments) => ApprovalAsk;
      readonly ttlMs?: number;
    };

/**
 * A Pi Durable tool plus MiPi's metadata: `writesOutside` marks a tool that changes something outside MiPi, and
 * `approval` how it asks the owner first. A `writesOutside` tool needs an `approval` to be offered outside `main`.
 */
export type ToolRegistration = PiToolRegistration & {
  readonly writesOutside?: boolean;
  readonly approval?: ApprovalPolicy;
};

/**
 * `Conversation.abort()` (COD-198): withdraws the queued inputs, aborts the run and waits until the conversation is
 * idle. Background tasks (reminders) survive. Named here so an upgrade that changes it fails in this folder.
 */
export function abortConversation(
  conversation: Pick<Conversation, "abort">,
  context: Context,
): Promise<void> {
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
  defineSignal,
  defineTask,
  GenerationTask,
  hook,
  hookTask,
  Harness,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  section,
  ToolTask,
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
  ReportInfo,
  SignalKey,
  SignalResult,
  SignalState,
  SignalToken,
  SubmissionId,
  SubmissionRecord,
  TaskGraph,
  TaskGraphNode,
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolPark,
  ToolTaskInput,
  Tx,
  Wake,
  WakeReason,
  WatchHandle,
} from "@earendil-works/pi-durable";
