---
"mipi": patch
---

**Added**

- Admin heartbeat status reports schedules, overdue work, gate holds, lost alarms, and the last proactive outcome. A daily check monitors staging and production.
- Weekly proactive prompt evals use OpenCode Go and mocked page contents. Run them locally with `pnpm eval:proactive --env-file .dev.vars`.

**Migration**

- The last proactive outcome and local alarm-loss marker are additive. Exports omit the alarm-loss marker.
