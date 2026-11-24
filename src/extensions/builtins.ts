/**
 * MiPi's built-in extensions: shipped on by default, each written only against core's connectors. A new feature is an
 * extension plus one line here (or in an optional list); wiring it anywhere else is a review finding (COD-208).
 */
import type { MipiExtension } from "../agent/extensions.ts";
import { historySearchExtension } from "./builtin/history-search/index.ts";
import { memoryExtension } from "./builtin/memory/index.ts";
import { remindersExtension } from "./builtin/reminders/index.ts";
import { webFetchExtension } from "./builtin/web-fetch/index.ts";

export const BUILT_IN_EXTENSIONS: readonly MipiExtension[] = [
  memoryExtension,
  remindersExtension,
  historySearchExtension,
  webFetchExtension,
];
