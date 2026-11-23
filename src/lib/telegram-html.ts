/**
 * Model markdown as Telegram's HTML subset (M6). The model writes markdown; Telegram shows `**bold**` with its
 * asterisks unless it gets HTML. Only what Telegram accepts is emitted: `<b> <i> <s> <code> <pre> <a> <blockquote>`.
 * Everything else is escaped text, as written.
 *
 * A reply is split before it is rendered, and each chunk is rendered on its own, so no tag ever spans two messages.
 * Code (fenced, then inline) is read before anything else, so `*` and `_` inside code stay as they are. `_` and `__`
 * are emphasis only at word boundaries, so `MIPI_DAILY_RUN_CAP` keeps its underscores. Spans are parsed recursively
 * and a marker without its partner stays literal, so tags are always well nested (Telegram refuses crossing tags).
 */
import { splitForTelegram, TELEGRAM_TEXT_LIMIT } from "./telegram-text.ts";

/** Room the splitter keeps for a code fence closed at a chunk's end and reopened at the next one's start. */
export const FENCE_RESERVE = 32;
/** A code block's language is shown only when it is this simple, so it can never break the attribute. */
const LANGUAGE = /^[A-Za-z0-9_+-]{1,20}$/;
const FENCE = /^\s*```(.*)$/;

export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (text: string): string => escapeHtml(text).replaceAll('"', "&quot;");

/** A fence's language, when it is one the class may carry. */
const languageOf = (info: string): string | undefined => {
  const word = info.trim().split(/\s+/)[0] ?? "";
  return LANGUAGE.test(word) ? word : undefined;
};

const MARKERS = [
  { marker: "**", tag: "b" },
  { marker: "__", tag: "b" },
  { marker: "~~", tag: "s" },
  { marker: "*", tag: "i" },
  { marker: "_", tag: "i" },
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

function closing(text: string, from: number, marker: string): number {
  for (let at = from + 1; at <= text.length - marker.length; at++) {
    // Code spans are opaque: a marker inside one closes nothing.
    if (text[at] === "`") {
      const end = text.indexOf("`", at + 1);
      if (end !== -1) {
        at = end;
        continue;
      }
    }
    if (text.startsWith(marker, at) && canClose(text, at, marker)) return at;
  }
  return -1;
}

const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)/;

/** One line's inline markdown as HTML. */
export function renderInline(text: string): string {
  let html = "";
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "`") {
      const end = text.indexOf("`", at + 1);
      if (end > at + 1) {
        html += `<code>${escapeHtml(text.slice(at + 1, end))}</code>`;
        at = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = LINK.exec(text.slice(at));
      if (link !== null) {
        html += `<a href="${escapeAttribute(link[2]!)}">${renderInline(link[1]!)}</a>`;
        at += link[0].length;
        continue;
      }
    }
    const span = MARKERS.find(({ marker }) => text.startsWith(marker, at));
    if (span !== undefined && canOpen(text, at, span.marker)) {
      const end = closing(text, at + span.marker.length - 1, span.marker);
      if (end !== -1) {
        const inner = text.slice(at + span.marker.length, end);
        html += `<${span.tag}>${renderInline(inner)}</${span.tag}>`;
        at = end + span.marker.length;
        continue;
      }
    }
    html += escapeHtml(char);
    at += 1;
  }
  return html;
}

/** A chunk of markdown as Telegram HTML. Fences in it are balanced (see `splitMarkdownForTelegram`). */
export function renderTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const end = lines.findIndex((candidate, at) => at > index && FENCE.test(candidate));
      if (end !== -1) {
        flushQuote();
        const code = escapeHtml(lines.slice(index + 1, end).join("\n"));
        const language = languageOf(fence[1] ?? "");
        out.push(
          language === undefined
            ? `<pre>${code}</pre>`
            : `<pre><code class="language-${language}">${code}</code></pre>`,
        );
        index = end;
        continue;
      }
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted !== null) {
      quote.push(renderInline(quoted[1]!));
      continue;
    }
    flushQuote();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    out.push(heading === null ? renderInline(line) : `<b>${renderInline(heading[1]!)}</b>`);
  }
  flushQuote();
  const html = out.join("\n");
  // Nothing visible (only fences, an empty block, bare markers): Telegram refuses an empty message, so send the text.
  const visible = html.replaceAll(/<[^>]*>/g, "").trim();
  return visible.length === 0 && markdown.trim().length > 0 ? escapeHtml(markdown) : html;
}

/**
 * Markdown split into chunks of at most `limit` UTF-16 units, with every code block balanced in each chunk: one cut
 * by a boundary is closed at the end of its chunk and reopened, with its language, at the start of the next. The
 * splitter keeps `FENCE_RESERVE` free for that, so the chunk fits as plain text too.
 */
export function splitMarkdownForTelegram(
  text: string,
  limit: number = TELEGRAM_TEXT_LIMIT,
): string[] {
  const pieces = splitForTelegram(text, Math.max(2, limit - FENCE_RESERVE));
  const chunks: string[] = [];
  let open: string | undefined;
  for (const piece of pieces) {
    let chunk = open === undefined ? piece : `\`\`\`${open}\n${piece}`;
    for (const line of piece.split("\n")) {
      const fence = FENCE.exec(line);
      if (fence === null) continue;
      open = open === undefined ? (languageOf(fence[1] ?? "") ?? "") : undefined;
    }
    if (open !== undefined) chunk += "\n```";
    chunks.push(chunk);
  }
  return chunks;
}
