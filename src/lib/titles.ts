// Adapted from pi-pocket src/server/titles.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
/**
 * Conversation titles, the parts with no Pi types. A conversation is named after its first message at once; when that
 * message is long or has several lines, the conversation's own model writes a short title in its place (see
 * `src/agent/titles.ts`), unless the title changed in the meantime. A reply that is no title (the model thinking
 * aloud, or cut off) keeps the first one.
 */

/** First messages this long or longer get a written title; shorter ones are a title already. */
const LONG_WORDS = 9;
const MAX_TITLE = 60;
/**
 * More words than this is no title but prose, such as a model thinking aloud. The model is asked for 3 to 6 words, but
 * some languages put spaces between syllables, and some models are wordy.
 */
const MAX_WORDS = 15;
/** Reasoning some servers send at the start of the reply's text: a block in tags, or one whose closing tag never came. */
const REASONING = /^\s*<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/i;
/** Reasoning whose opening tag the server left out: up to a closing tag that ends its line. */
const REASONING_END = /^[\s\S]*?<\/(think|thinking|reasoning)>[^\S\n]*(\n|$)/i;
/** How much of the first message the model reads. */
export const TITLE_READ_CHARS = 3000;

/** What the model is asked, before the first message. */
export const TITLE_PROMPT =
  "You name chat conversations. Reply with only a title of 3 to 6 words for a conversation that starts with the message below: plain words, no quotes, no punctuation at the end, in the message's language.";

/** Whether the title a first message gives is worth replacing: it is long, or more than one line. */
export function wantsTitle(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.split(/\s+/).length >= LONG_WORDS || trimmed.includes("\n");
}

const shorten = (line: string): string =>
  line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;

/** The title a first message gives at once: its first line, shortened. */
export function firstTitle(text: string): string {
  return shorten(text.trim().split("\n")[0]!.trim()) || "New conversation";
}

/**
 * A model's reply as a title: its first line, without quotes or a label, and not too long. Undefined when that is
 * empty, or is a sentence rather than a title. Reasoning at its start, in `<think>` tags (or `<thinking>`,
 * `<reasoning>`), is left out.
 */
export function cleanTitle(reply: string): string | undefined {
  const line = reply
    .replace(REASONING, "")
    .replace(REASONING_END, "")
    .trim()
    .split("\n")[0]!
    .replace(/^(title|conversation title|session title)\s*:\s*/i, "")
    .replace(/^["'“‘*#\s]+|["'”’*\s.!?:;,]+$/g, "")
    .trim();
  if (line === "" || line.split(/\s+/).length > MAX_WORDS) return undefined;
  return shorten(line);
}
