/**
 * The `history-search` built-in: `search_history`, which hands a question about earlier conversations to a subagent.
 * The subagent's own tool (`search_conversations`) is a helper extension: installed, never in the default selection,
 * selected only by the subagent the tool creates.
 *
 * Its code still lives in `src/tools/search.ts`; COD-211 moves it here and onto core's conversation visibility.
 */
import { defineExtension } from "../../../agent/pi/durable.ts";
import type { MipiExtension } from "../../../agent/extensions.ts";
import { conversationSearchExtension, searchHistoryTool } from "../../../tools/search.ts";

export const historySearchExtension: MipiExtension = {
  name: "history-search",
  tier: "builtin",
  replaceable: true,
  pi: defineExtension({ name: "history-search", tools: [searchHistoryTool] }),
  helpers: [conversationSearchExtension],
};
