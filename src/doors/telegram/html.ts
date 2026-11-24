/**
 * Model markdown as Telegram's HTML subset (M6). The model writes markdown; Telegram shows `**bold**` with its
 * asterisks unless it gets HTML. Only what Telegram accepts is emitted: `<b> <i> <s> <code> <pre> <a> <blockquote>`.
 * Everything else is escaped text, as written.
 *
 * A reply is split before it is rendered, and each chunk is rendered on its own, so no tag ever spans two messages.
 * Fenced code is read before anything else; inline markdown is parsed by `markdown.ts`, shared with the web door, and
 * a marker without its partner stays literal there, so tags are always well nested (Telegram refuses crossing tags).
 */
import {
  CLOSE_FENCE,
  type Inline,
  languageOf,
  OPEN_FENCE,
  parseInline,
} from "../../lib/markdown.ts";
import { splitForTelegram, TELEGRAM_TEXT_LIMIT } from "./text.ts";

/** Room the splitter keeps for a code fence closed at a chunk's end and reopened at the next one's start. */
export const FENCE_RESERVE = 32;

export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (text: string): string => escapeHtml(text).replaceAll('"', "&quot;");

const TAGS = { strong: "b", em: "i", strike: "s" } as const;

/** Inline nodes (`markdown.ts`) as Telegram HTML: every text escaped, so text never becomes a tag. */
function inlineHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.text);
        case "code":
          return `<code>${escapeHtml(node.text)}</code>`;
        case "link":
          return `<a href="${escapeAttribute(node.href)}">${inlineHtml(node.children)}</a>`;
        case "strong":
        case "em":
        case "strike":
          return `<${TAGS[node.type]}>${inlineHtml(node.children)}</${TAGS[node.type]}>`;
        default: {
          const _: never = node;
          throw new Error("Unknown inline node");
        }
      }
    })
    .join("");
}

/** One line's inline markdown as HTML. */
export const renderInline = (text: string): string => inlineHtml(parseInline(text));

/** A chunk of markdown as Telegram HTML. Fences in it are balanced (see `splitMarkdownForTelegram`). */
export function renderTelegramHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = OPEN_FENCE.exec(line);
    if (fence !== null) {
      const end = lines.findIndex((candidate, at) => at > index && CLOSE_FENCE.test(candidate));
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
  // CRLF from a tool or a model would leave a stray `\r` in headings, quotes and fences.
  const pieces = splitForTelegram(
    text.replaceAll("\r\n", "\n"),
    Math.max(2, limit - FENCE_RESERVE),
  );
  const chunks: string[] = [];
  /** The language of a block still open at the end of the last piece; `""` for one without. */
  let open: string | undefined;
  for (const piece of pieces) {
    let lines = piece.split("\n");
    const head: string[] = [];
    if (open !== undefined) {
      // The block's closing fence starts this piece: it ends here, with nothing to reopen.
      if (CLOSE_FENCE.test(lines[0] ?? "")) {
        lines = lines.slice(1);
        open = undefined;
      } else {
        head.push(`\`\`\`${open}`);
      }
    }
    let openedAt: number | undefined;
    lines.forEach((line, index) => {
      if (open === undefined) {
        const fence = OPEN_FENCE.exec(line);
        if (fence !== null) {
          open = languageOf(fence[1] ?? "") ?? "";
          openedAt = index;
        }
      } else if (CLOSE_FENCE.test(line)) {
        open = undefined;
      }
    });
    // A block that opens on this piece's last line has no body here: it opens in the next piece instead.
    if (open !== undefined && openedAt === lines.length - 1) lines = lines.slice(0, -1);
    else if (open !== undefined) lines.push("```");
    const chunk = [...head, ...lines].join("\n");
    if (chunk.trim().length > 0) chunks.push(chunk);
  }
  return chunks;
}
