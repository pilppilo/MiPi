---
"mipi": minor
---

COD-183 (M8 slice 2, part of COD-154): `web_fetch` reads one web page.

**Added**

- The `web_fetch(url)` tool, on the `default` and `pidu` profiles.
  - It sends a GET with `User-Agent: mipi/<version>`.
  - It follows at most 3 redirects, by hand, checking each one.
  - One 10-second deadline covers every hop and the body.
- Refused hosts, checked again on every redirect:
  - IP literals in any form: dotted, hex, octal, one number, or IPv6.
  - `localhost`, including with a trailing dot.
  - `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.lan` and `*.intranet`.
  - Single-label names.
  - URLs with a username or password.
  - Any scheme other than http and https.
- Content: only text types are read (`text/*`, JSON, XML, `+json` and `+xml`). For anything else the body is cancelled and the tool says what it was.
  - The raw body is read up to 1 MB and the rest is cancelled.
  - The text is cut at 50,000 characters, and a cut page says so.
- HTML becomes text through HTMLRewriter (`src/lib/html-text.ts`).
  - Scripts, styles, `noscript`, `svg`, `template`, `iframe` and `object` are dropped.
  - Block elements become line breaks, and entities are decoded.
- The page reaches the model inside `<fetched url="…">` tags it can't close, with a line saying it is data, not instructions. `remember` already refuses in a run that fetched (slice 1).

**Changed**

- The `default` and `pidu` profiles gain `web_fetch`. Existing conversations get it on the next start.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None.
