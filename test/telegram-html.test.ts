/** Markdown as Telegram HTML, and splitting that keeps code blocks balanced in every chunk. */
import { describe, expect, it } from "vitest";
import {
  FENCE_RESERVE,
  renderInline,
  renderTelegramHtml,
  splitMarkdownForTelegram,
} from "../src/lib/telegram-html.ts";

describe("renderTelegramHtml", () => {
  it("renders the constructs Telegram supports", () => {
    expect(renderInline("**bold** and __bold__")).toBe("<b>bold</b> and <b>bold</b>");
    expect(renderInline("*it* and _it_ and ~~gone~~")).toBe(
      "<i>it</i> and <i>it</i> and <s>gone</s>",
    );
    expect(renderInline("run `pnpm test` now")).toBe("run <code>pnpm test</code> now");
    expect(renderInline("[docs](https://example.com/a_b?x=1&y=2)")).toBe(
      '<a href="https://example.com/a_b?x=1&amp;y=2">docs</a>',
    );
    expect(renderTelegramHtml("# Title\nbody")).toBe("<b>Title</b>\nbody");
    expect(renderTelegramHtml("> one\n> two\nafter")).toBe(
      "<blockquote>one\ntwo</blockquote>\nafter",
    );
    expect(renderTelegramHtml("```ts\nconst a = 1 < 2;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
  });

  it("escapes everything else and leaves lists and tables as written", () => {
    expect(renderTelegramHtml("- a < b & c > d\n| x | y |")).toBe(
      "- a &lt; b &amp; c &gt; d\n| x | y |",
    );
  });

  it("keeps underscores inside words, and markers inside code", () => {
    expect(renderInline("set MIPI_DAILY_RUN_CAP and call search_history")).toBe(
      "set MIPI_DAILY_RUN_CAP and call search_history",
    );
    expect(renderInline("see https://x.dev/a_b_c")).toBe("see https://x.dev/a_b_c");
    expect(renderInline("`a*b*c` and `__init__`")).toBe(
      "<code>a*b*c</code> and <code>__init__</code>",
    );
    expect(renderTelegramHtml("```\n**not bold** _x_\n```")).toBe("<pre>**not bold** _x_</pre>");
  });

  it("never nests tags across each other: a crossing marker stays literal", () => {
    expect(renderInline("**bold _italic** end_")).toBe("<b>bold _italic</b> end_");
    expect(renderInline("**open only")).toBe("**open only");
    expect(renderInline("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(renderInline("**bold *and italic* inside**")).toBe(
      "<b>bold <i>and italic</i> inside</b>",
    );
  });

  it("drops a language that could break the attribute", () => {
    expect(renderTelegramHtml('```ts title="foo.ts"\nx\n```')).toBe(
      '<pre><code class="language-ts">x</code></pre>',
    );
    expect(renderTelegramHtml('```"><script>\nx\n```')).toBe("<pre>x</pre>");
    expect(renderTelegramHtml("```c++\nx\n```")).toBe(
      '<pre><code class="language-c++">x</code></pre>',
    );
  });

  it("links only http(s), and sends escaped text when nothing would render", () => {
    expect(renderInline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(renderTelegramHtml("```\n```")).toBe("```\n```");
  });
});

describe("splitMarkdownForTelegram", () => {
  it("closes a code block cut by a boundary and reopens it, with its language", () => {
    const code = Array.from({ length: 600 }, (_, index) => `line ${index};`).join("\n");
    const chunks = splitMarkdownForTelegram(`Here:\n\`\`\`ts\n${code}\n\`\`\`\nDone.`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      const fences = chunk.split("\n").filter((line) => line.trimStart().startsWith("```"));
      expect(fences.length % 2).toBe(0);
      expect(renderTelegramHtml(chunk)).not.toContain("```");
    }
    expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
  });

  it("keeps room for the fences, so a chunk fits as plain text too", () => {
    const code = "x".repeat(10_000);
    for (const chunk of splitMarkdownForTelegram(`\`\`\`python\n${code}\n\`\`\``)) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    expect(FENCE_RESERVE).toBeGreaterThanOrEqual("```".length * 2 + 20 + 2);
  });

  it("ends a block whose closing fence starts the next piece, with no empty block or stray fence", () => {
    const code = "x".repeat(4056);
    const chunks = splitMarkdownForTelegram(`\`\`\`ts\n${code}\n\`\`\`\nDone.`);
    expect(chunks).toEqual([`\`\`\`ts\n${code}\n\`\`\``, "Done."]);
    expect(renderTelegramHtml(chunks[1]!)).toBe("Done.");
    expect(splitMarkdownForTelegram(`\`\`\`ts\n${code}\n\`\`\``)).toEqual([
      `\`\`\`ts\n${code}\n\`\`\``,
    ]);
  });

  it("opens a block in the next piece when its fence is the last line of this one", () => {
    const before = "a".repeat(4050);
    const body = "c".repeat(100);
    const chunks = splitMarkdownForTelegram(`${before}\n\`\`\`ts\n${body}\n\`\`\``);
    expect(chunks).toEqual([before, `\`\`\`ts\n${body}\n\`\`\``]);
    expect(renderTelegramHtml(chunks[1]!)).toBe(
      `<pre><code class="language-ts">${body}</code></pre>`,
    );
  });
});

describe("the review's cases", () => {
  it("doesn't take backticks on one line for a fence, or a fence with an info string for a closing one", () => {
    expect(renderTelegramHtml("```foo``` and more\nnext")).not.toContain("<pre>");
    expect(renderTelegramHtml("```md\n```js\nx\n```")).toBe(
      '<pre><code class="language-md">```js\nx</code></pre>',
    );
  });

  it("keeps empty spans literal", () => {
    expect(renderInline("password: ****")).toBe("password: ****");
    expect(renderInline("____ and ~~~~")).toBe("____ and ~~~~");
  });

  it("reads triple markers and markers around links", () => {
    expect(renderInline("***bold italic***")).toBe("<b><i>bold italic</i></b>");
    expect(renderInline("**bold *italic***")).toBe("<b>bold <i>italic</i></b>");
    expect(renderInline("*see [docs](https://example.com/a*b) now*")).toBe(
      '<i>see <a href="https://example.com/a*b">docs</a> now</i>',
    );
  });

  it("skips a code span or link that opens an emphasis span", () => {
    expect(renderInline("**`a**b`**")).toBe("<b><code>a**b</code></b>");
    expect(renderInline("*[docs](https://example.com/a*b)*")).toBe(
      '<i><a href="https://example.com/a*b">docs</a></i>',
    );
  });

  it("reads CRLF line endings like LF", () => {
    expect(renderTelegramHtml("# Title\r\n> quote\r\nbody")).toBe(
      "<b>Title</b>\n<blockquote>quote</blockquote>\nbody",
    );
    expect(splitMarkdownForTelegram("```ts\r\nx\r\n```")).toEqual(["```ts\nx\n```"]);
  });
});
