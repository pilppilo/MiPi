/**
 * The vault's scrubber (COD-255): replaces a secret's value, and the forms an API is likely to echo it in, with
 * `[REDACTED:<id>]` before anything reaches the model or storage. It covers the value as is, JSON-escaped,
 * percent-encoded (hex digits in any case, the usual form and every byte encoded), and base64 and base64url, padded or
 * not. An API asked to transform the value some other way can beat it, so it is never the only guard: the value never
 * goes anywhere the model can choose but the listed hosts.
 *
 * Core code.
 */
import { toBase64 } from "../lib/vault-key.ts";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A percent-encoded form as a pattern whose hex digits match in any case. */
function percentPattern(encoded: string): string {
  return encoded
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part) =>
      /^%[0-9A-Fa-f]{2}$/.test(part)
        ? `%[${part[1]!.toLowerCase()}${part[1]!.toUpperCase()}][${part[2]!.toLowerCase()}${part[2]!.toUpperCase()}]`
        : escapeRegExp(part),
    )
    .join("");
}

/** Every form of `value` the scrubber looks for, as one pattern, longest first so a longer form wins. */
export function scrubPattern(value: string): RegExp {
  const bytes = new TextEncoder().encode(value);
  const base64 = toBase64(bytes);
  const base64url = base64.replaceAll("+", "-").replaceAll("/", "_");
  const json = JSON.stringify(value).slice(1, -1);
  const literals = new Set<string>([
    value,
    json,
    json.replaceAll("/", "\\/"),
    base64,
    base64.replace(/=+$/, ""),
    base64url,
    base64url.replace(/=+$/, ""),
  ]);
  const percent = new Set<string>([
    encodeURIComponent(value),
    [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
  ]);
  const patterns = [
    ...[...literals].map((literal) => ({ length: literal.length, source: escapeRegExp(literal) })),
    ...[...percent].map((encoded) => ({ length: encoded.length, source: percentPattern(encoded) })),
  ]
    .filter(({ length }) => length > 0)
    .sort((a, b) => b.length - a.length);
  return new RegExp(patterns.map(({ source }) => source).join("|"), "g");
}

/** `text` with every form of the secret replaced. */
export function scrub(text: string, pattern: RegExp, secretId: string): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, `[REDACTED:${secretId}]`);
}
