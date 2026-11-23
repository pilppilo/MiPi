// Copied from pi-pocket src/server/fence.ts @ 2f060f2, MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
/**
 * Text from elsewhere (a relay message from PiDu, later a fetched page) reaches the model between tags, as data. Nothing
 * inside may end the fence early: every `<` with a `/` soon after it loses its `<` (whatever lies between: spaces,
 * invisible characters, JSON's `\n`), and attribute values lose what would end them.
 */

/**
 * Characters that show as nothing (controls, format characters, lone surrogates, private and unassigned ones, variation
 * selectors, joiners, and the blank letters), for a regular expression's `[…]`: `defang` sees through them.
 */
export const INVISIBLE_CLASS =
  "\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u2800\\u3164\\uFFA0";

/** A `<` that starts a closing tag: a `/` after spaces and invisible characters, or within 80 others. */
const CLOSER = new RegExp("<(?=[\\s" + INVISIBLE_CLASS + "]*\\/|[^<>]{0,80}\\/)", "gu");

/**
 * Text made safe to put between tags: no closing tag of any kind survives in it. A `<` goes when a `/` follows after
 * any run of spaces and invisible characters (`INVISIBLE_CLASS`), or within 80 characters with no `<` or `>` between,
 * so `Vec<T>` and `<div>` stay, and `a < b/2` loses its `<` harmlessly.
 */
export function defang(text: string): string {
  return text.replace(CLOSER, "‹");
}

/** A value made safe for a tag's attribute: one line, without quotes or angle brackets. */
export function attribute(value: string): string {
  return value.replace(/[<>"\r\n]+/g, " ").trim();
}

/** A short single-line snippet of a text (pi-pocket `projection.ts`, inlined). */
function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Text from elsewhere where the model reads it outside a fence: one line (control characters too), without invisible
 * ones (zero-width, bidi, tags), cut to `max`, with no tag of any kind (every `<` becomes `‹`), in quotes it cannot
 * close.
 */
export function quoted(text: string, max = 120): string {
  const line = snippet(text.replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " "), max);
  return `“${line.replace(/</g, "‹").replace(/[“”]/g, '"')}”`;
}

/** Text cut to `max` characters, keeping its lines (`snippet` makes one line). */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
