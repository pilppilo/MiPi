/**
 * The markdown the model writes, parsed for the doors that show it formatted: the web transcript renders the tree as
 * React elements (`src/client/Markdown.tsx`), and Telegram renders the inline part as its HTML subset
 * (`telegram-html.ts`). Nothing here produces markup: what a door makes of a node is up to the door, so text can never
 * become a tag.
 *
 * Inline: code is read before anything else, so `*` and `_` inside code stay as they are; `_` and `__` are emphasis
 * only at word boundaries, so `MIPI_DAILY_RUN_CAP` keeps its underscores; a marker without its partner stays literal,
 * so spans are always well nested. Links are `[text](http(s)://…)` only: any other scheme stays text.
 */

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "link"; readonly href: string; readonly children: readonly Inline[] }
  | { readonly type: "strong" | "em" | "strike"; readonly children: readonly Inline[] };

export const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)/;

const MARKERS = [
  { marker: "**", type: "strong" },
  { marker: "__", type: "strong" },
  { marker: "~~", type: "strike" },
  { marker: "*", type: "em" },
  { marker: "_", type: "em" },
] as const;

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);
const isWord = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);
const underscored = (marker: string): boolean => marker.startsWith("_");

function canOpen(text: string, at: number, marker: string): boolean {
  const after = text[at + marker.length];
  if (isSpace(after)) return false;
  // `**` is read before `*`: a lone `*` right before another is not an opener.
  if (marker.length === 1 && after === marker) return false;
  return !underscored(marker) || !isWord(text[at - 1]);
}

function canClose(text: string, at: number, marker: string): boolean {
  if (isSpace(text[at - 1])) return false;
  const after = text[at + marker.length];
  if (marker.length === 1 && (after === marker || text[at - 1] === marker)) return false;
  return !underscored(marker) || !isWord(after);
}

/**
 * Where the span opened just before `start` closes, or -1. The span holds at least one character, so `****` stays
 * literal. Code spans and links are opaque: a marker inside one closes nothing.
 */
function closing(text: string, start: number, marker: string): number {
  // From `start` itself, so a code span or link that opens the span is skipped whole too.
  for (let at = start; at <= text.length - marker.length; at++) {
    if (text[at] === "`") {
      const end = text.indexOf("`", at + 1);
      if (end !== -1) {
        at = end;
        continue;
      }
    }
    if (text[at] === "[") {
      const link = LINK.exec(text.slice(at));
      if (link !== null) {
        at += link[0].length - 1;
        continue;
      }
    }
    // Not right at the start: an empty span (`****`) stays literal.
    if (at === start) continue;
    if (!text.startsWith(marker, at) || !canClose(text, at, marker)) continue;
    // `***`: the double marker closes at its last two, leaving the first to close an inner single one.
    if (marker.length === 2 && text[at + 2] === marker[0]) continue;
    return at;
  }
  return -1;
}

/** One line's inline markdown, as nodes. Adjacent text is merged into one node. */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  const pushText = (value: string) => {
    const last = nodes.at(-1);
    if (last?.type === "text") nodes[nodes.length - 1] = { type: "text", text: last.text + value };
    else nodes.push({ type: "text", text: value });
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "`") {
      const end = text.indexOf("`", at + 1);
      if (end > at + 1) {
        nodes.push({ type: "code", text: text.slice(at + 1, end) });
        at = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = LINK.exec(text.slice(at));
      if (link !== null) {
        nodes.push({ type: "link", href: link[2]!, children: parseInline(link[1]!) });
        at += link[0].length;
        continue;
      }
    }
    const span = MARKERS.find(({ marker }) => text.startsWith(marker, at));
    if (span !== undefined && canOpen(text, at, span.marker)) {
      const end = closing(text, at + span.marker.length, span.marker);
      if (end !== -1) {
        nodes.push({
          type: span.type,
          children: parseInline(text.slice(at + span.marker.length, end)),
        });
        at = end + span.marker.length;
        continue;
      }
    }
    pushText(char);
    at += 1;
  }
  return nodes;
}

// ---- Blocks (the web door; Telegram has no lists or paragraphs of its own) ----

/** An opening fence: its info string has no backtick (CommonMark), so "```foo```" on one line is not a fence. */
export const OPEN_FENCE = /^\s*```([^`]*)$/;
/** A closing fence has nothing after it; a fence with an info string inside a block is content. */
export const CLOSE_FENCE = /^\s*```\s*$/;
/** A code block's language is kept only when it is this simple. */
const LANGUAGE = /^[A-Za-z0-9_+-]{1,20}$/;

/** A fence's language, when it is one a class name may carry. */
export const languageOf = (info: string): string | undefined => {
  const word = info.trim().split(/\s+/)[0] ?? "";
  return LANGUAGE.test(word) ? word : undefined;
};

export type Block =
  /** Lines of one paragraph, each its own inline run (shown with line breaks between). */
  | { readonly type: "paragraph"; readonly lines: readonly (readonly Inline[])[] }
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly Inline[];
    }
  | { readonly type: "code"; readonly language?: string; readonly text: string }
  | { readonly type: "quote"; readonly blocks: readonly Block[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      /** The first number of an ordered list. */
      readonly start: number;
      readonly items: readonly (readonly Inline[])[];
    }
  | { readonly type: "rule" };

/** A closing run of `#` is dropped only after a space (CommonMark), so `## C#` keeps its `#`. */
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Block quotes nested deeper than this are read as text, so `> > > …` can't recurse without end. */
export const MAX_QUOTE_DEPTH = 8;

/**
 * A reply's markdown as blocks: fenced code, headings, rules, block quotes, bullet and numbered lists (flat: an
 * indented item joins the list), and paragraphs. A fence still open at the end (a reply still streaming) runs to the
 * end as code.
 */
export function parseMarkdown(markdown: string, depth = 0): Block[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = OPEN_FENCE.exec(line);
    if (fence !== null) {
      let end = lines.findIndex((candidate, at) => at > index && CLOSE_FENCE.test(candidate));
      if (end === -1) end = lines.length;
      const language = languageOf(fence[1] ?? "");
      blocks.push({
        type: "code",
        ...(language === undefined ? {} : { language }),
        text: lines.slice(index + 1, end).join("\n"),
      });
      index = end + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2]!),
      });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push({ type: "quote", blocks: parseMarkdown(quoted.join("\n"), depth + 1) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index]!);
        if (item === null || RULE.test(lines[index]!)) break;
        items.push(parseInline(ordered ? item[2]! : item[1]!));
        index += 1;
      }
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? Number(numbered![1]) : 1,
        items,
      });
      continue;
    }
    const paragraph: Inline[][] = [];
    while (index < lines.length) {
      const next = lines[index]!;
      if (
        next.trim().length === 0 ||
        OPEN_FENCE.test(next) ||
        HEADING.test(next) ||
        RULE.test(next) ||
        (depth < MAX_QUOTE_DEPTH && QUOTE.test(next)) ||
        BULLET.test(next) ||
        NUMBERED.test(next)
      ) {
        break;
      }
      paragraph.push(parseInline(next.trim()));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
