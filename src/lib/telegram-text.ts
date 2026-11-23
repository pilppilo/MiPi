/**
 * Splitting a reply into Telegram messages. Telegram caps a message at 4,096 characters of visible text. MiPi counts
 * UTF-16 code units (`string.length`), which is never fewer than code points, so a chunk fits whichever unit Telegram
 * counts in; emoji-heavy text just splits a little early. A split never lands inside a grapheme (a surrogate pair,
 * a ZWJ emoji, a letter with its combining marks).
 */

export const TELEGRAM_TEXT_LIMIT = 4096;

/** How far past the limit to segment, so the grapheme that straddles it is seen whole. */
const GRAPHEME_LOOKAHEAD = 64;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The largest grapheme boundary at or below `limit` in `text`; 0 when the first grapheme is longer than `limit`. */
function graphemeBoundary(text: string, limit: number): number {
  let boundary = 0;
  for (const { index, segment } of graphemes.segment(text.slice(0, limit + GRAPHEME_LOOKAHEAD))) {
    const end = index + segment.length;
    if (end > limit) break;
    boundary = end;
  }
  return boundary;
}

/** A code-point boundary at or below `limit`: the last resort for one grapheme longer than a whole message. */
function codePointBoundary(text: string, limit: number): number {
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/** Where to cut `text` (longer than `limit`): after a paragraph, then a line, then whitespace, then a grapheme. */
function cutPoint(text: string, limit: number): number {
  const safe = graphemeBoundary(text, limit);
  if (safe === 0) return codePointBoundary(text, limit);
  const window = text.slice(0, safe);
  // A cut in the first half would make many short messages; past that, prefer the most natural break.
  const floor = Math.floor(safe / 2);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= floor) return paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line >= floor) return line + 1;
  for (let index = safe - 1; index >= floor; index--) {
    if (/\s/.test(window[index]!)) return index + 1;
  }
  return safe;
}

/**
 * `text` as ordered chunks of at most `limit` UTF-16 code units, none empty or only whitespace (Telegram refuses
 * those). Trailing whitespace of a chunk and the line breaks that start the next are dropped.
 */
export function splitForTelegram(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("The chunk limit is too small");
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    const cut = cutPoint(rest, limit);
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    rest = rest.slice(cut).replace(/^[\r\n]+/, "");
  }
  return chunks;
}
