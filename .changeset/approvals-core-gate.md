---
"mipi": minor
---

COD-237: approvals, core gate (COD-173 slice 1). A tool call can wait for the owner's yes.

**Added**

- A tool can declare an `approval` policy. With `gate`, core's `beforeTool` gate parks every call (or those `when` picks) before it runs. With `self`, the tool asks from `execute()` through `awaitApproval`, when only its own transaction knows it must. Either way the call holds no process while it waits, and other conversations run on.
- The owner's answer arrives on the `app.approval` signal under the call's task id: approve runs the call, deny gives the model "Denied by the owner." with the owner's note, and no answer within the deadline (24 hours unless the tool says otherwise) gives "Approval timed out without an answer; the action was not run." A restart or hibernation keeps the request and its deadline; the alarm wakes the object to time it out.
- The pending list is read off Pi Durable's task graph (`approvalsIn`), never stored: an aborted, archived or failed call leaves it by itself. `resolveApproval` answers only an approval the graph shows pending, and reports a second answer as already decided.
- While no web tab is open, the owner is told about each new request once, through the usual delivery (Telegram), also across restarts (`app.approval-notices`). A request is marked told only once a door could reach the owner. At each open the list is taken from the task graph as it stands, so a request waiting through a restart stays pending and one a crash kept untold is told then. Diagnostics log `approval.requested`, `approval.resolved`, `approval.expired` and `approval.canceled` (source `gate`).
- No tool asks yet, and there is no approval card or command yet: those come with `remember` after `web_fetch` and the web card (COD-238).

**Changed**

- A tool marked `writesOutside` may be offered outside `main` only if it has an `approval` policy; a profile table that breaks this refuses to compose. Before, such tools were kept out of every profile but `main` by a test alone.
- Core's approvals extension is the last in every conversation's default selection, so the gate sees the arguments a call will run with. It adds no tool and no section, so prompts don't change.

**Pi Durable**

- No version change (1.6.1). The seam adds `defineSignal`, `ToolTask` and the signal, park, wake, task-graph-node and tool-task-input types; the contract test parks a call at a gate and in `execute()` and wakes each with a signal on Durable Object SQLite.
- Ledger: L14 added (internals). The approval card reads a waiting call's name and arguments through its task's input, since the task graph doesn't carry them.

**Migration**

- One new optional document, `app.approval-notices`; nothing else is stored differently. Rolling back works: an older build has no approvals extension, so it never parks a call (none asks yet). Not one-way.
