/**
 * What a reminder's answer says, read the same way by the agent and the web door (M6). A reminder that finds nothing
 * worth sending answers exactly `NO_SEND`. Structured thinking never reaches this text; a provider that writes its
 * reasoning into the text as a leading `<think>…</think>` has that envelope removed, and nothing else.
 */

/** The answer that means "nothing to send". */
export const NO_SEND = "NO_SEND";

/** `text` without a leading `<think>…</think>` envelope, trimmed. */
export function visibleAnswer(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
}

/** Whether an answer is exactly the sentinel, once a leading thinking envelope is set aside. */
export function isNoSend(text: string): boolean {
  return visibleAnswer(text) === NO_SEND;
}
