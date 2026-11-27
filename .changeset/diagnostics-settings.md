---
"mipi": minor
---

COD-236: diagnostics slice 3, the **Settings → Diagnostics** page in the web app.

**Added**

- Settings has a **Diagnostics** section beside Archived. It shows the agent's diagnostic log live while it's open:
  - A summary strip: how many events, how many `ok`, `warn / held` and `error`, when the next alarm is (or `Idle`), any hold with its end time, whether it's live, and a **Refresh** button.
  - A banner for what's wrong or waiting now: the agent refused or in maintenance, a lost alarm in the last 26 hours, a hold, late schedules, or errors in the last hour.
  - Severity and source filters, and **Pause scroll**, which keeps the rows still and counts the events that arrive meanwhile.
  - A table with time, severity, source, event and outcome, with a red or amber edge for errors and warnings. An event with more to it opens to its detail and its ids as JSON.
- **Ask MiPi** in the banner opens MiPi with a draft in the message box: the health and the last 15 events shown, under the current filters. It closes Settings and puts the cursor in the box. Nothing is sent until you send it, and no model runs in the background.
- The web app keeps up to 500 events, one per id, apart from the conversation's state, so a live event never redraws the transcript. Opening Diagnostics subscribes. Closing Settings or switching to Archived unsubscribes. After a reconnect it subscribes again from the newest event it has.

**Pi Durable**

- No version change (1.6.1). No ledger changes.

**Migration**

- Nothing stored changes.
