---
"mipi": patch
---

COD-252: show cached prompt tokens for the latest recorded model response in bot details.

**Added**

- Show the provider, model, and cached share of prompt tokens for the latest recorded model response. Show when prompt usage is unavailable.

**Changed**

- Label cumulative usage as All time.

**Fixed**

- Correct the percentage in the staging cache measurement.

**Pi Durable**

- Uses the usage attached to existing assistant entries.

**Migration**

- None.
