---
"mipi": minor
---

COD-238: approvals in use (COD-173 slice 2). `remember` asks the owner after a web page was read, and the web shows the request.

**Added**

- `remember` in a turn that read a web page asks the owner before saving, instead of refusing. Approve saves that exact lesson; deny or no answer within 24 hours saves nothing, and the model is told which. A relay or bot turn is still refused outright.
- Chat shows approval cards above the composer. Workbench lists requests for the bot, its side chats, and its helpers under **Waiting on you**. Amber dots mark waiting bots and the phone drawer toggle when another chat needs approval. The drawer links to each waiting chat.
- The `approvals` capability controls whether the web shows approvals and sends decisions. Protocol: `approvals.list` (every waiting request, sent on connect and to every tab when the list changes) and `approval.decide { approvalId, decision, note? }`, answered with `command.result`. A request already answered, timed out or ended is refused with "That approval was already answered or has ended."
- The owner gets one text notice through the usual delivery (Telegram) for a background request or when no web tab is open.

**Changed**

- `remember`'s description tells the model that after a page was read the owner is asked to confirm.
- A new socket gets one more frame on connect: `approvals.list`, right after `session.snapshot`.

**Pi Durable**

- No version change (1.6.1). No ledger changes.

**Migration**

- Nothing new is stored. A `remember` waiting for approval is a parked Pi Durable tool task: an older build can open the data, but a parked call should be allowed to settle before rollback.
