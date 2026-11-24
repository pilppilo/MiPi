/** The markdown parse shared by the web and Telegram doors (COD-190): blocks for the web, inline nodes for both. */
import { describe, expect, it } from "vitest";
import { MAX_QUOTE_DEPTH, parseInline, parseMarkdown } from "../src/lib/markdown.ts";

describe("inline markdown", () => {
  it("reads code, links and emphasis, and leaves unmatched markers and other schemes as text", () => {
    expect(parseInline("**bold** and *it* and `a*b` and ~~gone~~")).toEqual([
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " and " },
      { type: "code", text: "a*b" },
      { type: "text", text: " and " },
      { type: "strike", children: [{ type: "text", text: "gone" }] },
    ]);
    expect(parseInline("[site](https://example.com/a)")).toEqual([
      { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "site" }] },
    ]);
    for (const text of [
      "[x](javascript:alert(1))",
      "[x](data:text/html,hi)",
      "2 * 3 = 6",
      "MIPI_DAILY_RUN_CAP",
      "**open",
    ]) {
      expect(parseInline(text), text).toEqual([{ type: "text", text }]);
    }
  });
});

describe("markdown blocks", () => {
  it("reads headings, paragraphs, lists, quotes, code and rules", () => {
    const blocks = parseMarkdown(
      [
        "## Title",
        "",
        "First line",
        "second line",
        "",
        "- one",
        "* two",
        "",
        "3. three",
        "4. four",
        "",
        "> quoted **bold**",
        "> more",
        "",
        "```ts",
        "const a = 1 * 2;",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(blocks.map(({ type }) => type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
      "rule",
    ]);
    expect(blocks[0]).toEqual({
      type: "heading",
      level: 2,
      children: [{ type: "text", text: "Title" }],
    });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      lines: [[{ type: "text", text: "First line" }], [{ type: "text", text: "second line" }]],
    });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      start: 1,
      items: [[{ text: "one" }], [{ text: "two" }]],
    });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[4]).toMatchObject({ type: "quote", blocks: [{ type: "paragraph" }] });
    expect(blocks[5]).toEqual({ type: "code", language: "ts", text: "const a = 1 * 2;" });
  });

  it("runs a fence still open at the end to the end as code, as a reply does while it streams", () => {
    expect(parseMarkdown("Here:\n```js\nlet x = 1;\nlet y")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "Here:" }]] },
      { type: "code", language: "js", text: "let x = 1;\nlet y" },
    ]);
  });

  it("keeps text that looks like HTML as text", () => {
    expect(parseMarkdown('<script>alert("x")</script>')).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: '<script>alert("x")</script>' }]] },
    ]);
  });
});

describe("markdown edge cases", () => {
  it("keeps a heading's own # and drops only a closing run after a space", () => {
    expect(parseMarkdown("## C#")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "C#" }] },
    ]);
    expect(parseMarkdown("### F# notes ###")).toEqual([
      { type: "heading", level: 3, children: [{ type: "text", text: "F# notes" }] },
    ]);
  });

  it("reads quotes nested past the limit as text", () => {
    const deep = parseMarkdown(`${"> ".repeat(MAX_QUOTE_DEPTH + 4)}deep`);
    let block = deep[0]!;
    let depth = 0;
    while (block.type === "quote") {
      depth += 1;
      block = block.blocks[0]!;
    }
    expect(depth).toBe(MAX_QUOTE_DEPTH);
    expect(block).toMatchObject({ type: "paragraph" });
  });
});
