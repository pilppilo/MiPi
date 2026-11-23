---
"mipi": patch
---

COD-190: the web transcript formats replies, and collapses long tool results.

**Changed**

- The web door shows assistant replies and context summaries as formatted markdown. That covers paragraphs, headings, bold, italic, strikethrough, inline and fenced code, bullet and numbered lists, block quotes, rules and links. Before, it printed the `**`, `- ` and backticks as written. A reply still streaming is formatted as it arrives.
- Links open only for `http(s)`, in a new tab with no referrer. Anything else, including HTML or a `javascript:` link in a reply, shows as text.
- User, scheduled and queued messages still show exactly as typed.
- A tool result longer than 600 characters or 12 lines starts collapsed. Its one-line summary gives the fetched page's URL (or the result's first line) and its length. Short results and failures stay open.
- The inline markdown parse moved from `telegram-html.ts` to `src/lib/markdown.ts`. Both doors use it, and Telegram's output is unchanged.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. Only the web page changes.
