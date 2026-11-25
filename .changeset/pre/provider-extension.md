---
"mipi": patch
---

COD-212: OpenCode Go's provider pieces as an optional extension, and the boundary written down.

**Changed**

- Internal, no behaviour change for the owner. OpenCode Go's usage reader and live model list moved out of core into `src/extensions/optional/opencode-go/`, an optional extension listed in `src/extensions/optional.ts`. The usage readout (admin status, `/usage`, the web line), the web model picker and Telegram's `/model` read and set the same as before.
- Core's providers connector (`src/agent/providers.ts`, which replaces `usage-sources.ts`): an extension registers a provider's usage reader and model list, each under a static provider id. One provider's piece registered twice refuses to compose, with or without a key set. A replaced extension's providers aren't registered.
- `ModelList` takes the registered model lists and returns each model's provider from its source. With none (bare core) it lists nothing and refuses a model clearly.
- An extension may have no Pi Durable part (`MipiExtension.pi` is optional). OpenCode Go's has none, so it is never in a conversation's selection and can't be switched off; the admin status lists `opencode-go` among the extensions in use.
- The model list key is read through the agent's settings, so an empty `OPENCODE_API_KEY` now sends no `Authorization` header rather than an empty one.
- Docs: "Core, doors and extensions" in `docs/development.md` (tiers, imports, the extension contract, the connectors). `AGENTS.md` adds the rule that provider-specific code lives in the provider's optional extension or the model seam. A test keeps OpenCode URLs, settings and response shapes out of `src/agent/` outside `pi/`.

**Pi Durable**

- No version change (1.6.0). No ledger change: the model seam (`src/agent/pi/models.ts`, L1) stays as it is.

**Migration**

- None. No stored data changed.
