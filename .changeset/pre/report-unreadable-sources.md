---
"mipi": patch
---

COD-215: a check reports a source it couldn't read instead of staying quiet.

**Fixed**

- A reminder's notes now tell the model to say so when it couldn't read or verify a source (a fetch error, a login wall, or a blank or JavaScript-only page) instead of answering `NO_SEND`. A page that loads but shows nothing (HTTP 200) leaves no tool error for MiPi to catch, so such a check used to look healthy while it had read nothing. Found by the first live run of the proactive evals (`javascript-shell` and `fetch-503`).

**Pi Durable**

- No change.

**Migration**

- None. The note is on each reminder's message, so the system prompt prefix stays the same.
