/** pi-ai types the server uses (messages). See `durable.ts` for why this seam exists. */
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Pi 1.6 only reads these two fields, including for errors from settled submissions. */
export const isRetryableErrorText = (errorMessage: string): boolean =>
  isRetryableAssistantError({ stopReason: "error", errorMessage } as AssistantMessage);
export type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
export type { MutableModels } from "@earendil-works/pi-ai/models";
