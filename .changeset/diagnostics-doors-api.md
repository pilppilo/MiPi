---
"mipi": minor
---

COD-235: diagnostics slice 2. The doors and providers write to the diagnostic log, the admin API can read it, web sockets can follow it live, and a failed heartbeat shows its latest faults.

**Added**

- `GET /api/admin/events?after=&source=&level=&limit=` (admin credentials) returns `{ events, health }`.
  - Every parameter is checked strictly; an unknown parameter or an out-of-range value is a 400.
  - `level` takes a comma-separated list such as `warn,error`. `limit` is 1 to 500, 100 by default.
  - It works in every state, refused and maintenance included, and writes nothing.
  - `health` (`DiagHealth`) gives the state and why, the alarm's time, a lost alarm, the hold and until when, the overdue schedules, and the last proactive run.
- A WebSocket live tail.
  - `diag.subscribe` (`limit` 1 to 500, 200 by default, or `after`) answers with `{ events, health }`. From then on, each new event arrives as `diag.event`.
  - `diag.unsubscribe` stops it.
  - The subscription is kept in the socket's attachment, so it survives hibernation and switching conversations. A socket that hasn't subscribed gets no extra frames.
- Door events, with ids and outcomes only, never message text:
  - Telegram: `telegram.admit`, `telegram.outbox_enqueued`, `telegram.send_ok`, `telegram.send_retry`, `telegram.send_failed`, `telegram.send_unknown`.
  - Relay: `relay.admitted`, `relay.refused`, `relay.settled`.
  - Web: `ws.connect` and `ws.command_failed`.
  - Door calls the agent turns away or fails (`telegram.admit`, `relay.admit`, `relay.poll`).
- Provider events: `provider.usage_ok` and `provider.usage_failed` for each real usage read (never a cached one), and `provider.models_failed`. They come from core's usage cache and model list, so every provider gets them without code of its own.
- Worker-only refusals go to Cloudflare's logs as `"source":"worker"` events and never reach the agent: `auth.refused`, `telegram.webhook_refused`, `relay.auth_refused`, `ws.cross_origin`. They carry the route, status and reason, never the token.
- A failed heartbeat lists the agent's last 10 warnings and errors in its output and step summary. If those can't be read, it says so in one line.

**Changed**

- The log keeps `debug` rows separately: 200 of them beside 800 of everything else, so the per-minute `alarm.fired` can't push out a fault.

**Pi Durable**

- No version change (1.6.1). No ledger changes.

**Migration**

- Nothing stored changes. The log's table and its rows stay as they are, and trimming in two tiers starts with the next event.
