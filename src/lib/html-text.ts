/**
 * An HTML page as plain text, for `web_fetch` (M8), with the Workers runtime's HTMLRewriter. Scripts, styles and other
 * content that isn't text are dropped, block elements become line breaks so words don't run together, and entities
 * are decoded: HTMLRewriter hands text chunks over as they appear in the source.
 */

/** Elements whose content is never text a person reads. */
const SKIPPED = ["script", "style", "noscript", "svg", "template", "iframe", "object"];
/** Elements that start and end a line. */
const BLOCKS = [
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "td",
  "th",
  "table",
  "blockquote",
  "pre",
  "title",
  "figcaption",
  "hr",
];

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

/** Decodes numeric entities and the common named ones; anything else is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** Lines trimmed, runs of spaces made one, and at most one empty line in a row. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The readable text of an HTML document. */
export async function htmlToText(html: string): Promise<string> {
  const parts: string[] = [];
  let skipping = 0;
  const rewriter = new HTMLRewriter()
    .on(SKIPPED.join(", "), {
      element(element) {
        skipping += 1;
        element.onEndTag(() => {
          skipping -= 1;
        });
      },
    })
    .on("br", {
      element() {
        parts.push("\n");
      },
    })
    .on(BLOCKS.join(", "), {
      element(element) {
        parts.push("\n");
        // A void element (`hr`) has no end tag to wait for.
        if (element.tagName !== "hr") {
          element.onEndTag(() => {
            parts.push("\n");
          });
        }
      },
    })
    .onDocument({
      text(chunk) {
        if (skipping === 0) parts.push(chunk.text);
      },
    });
  await rewriter.transform(new Response(html)).arrayBuffer();
  return tidyText(decodeEntities(parts.join("")));
}
