---
"mipi": minor
---

COD-255: vault core (COD-254, issue 1). Core can keep bot secrets encrypted and send one only inside `fetchWithSecret`, by its policy. No tool or screen uses it yet: those are COD-256 and COD-257.

**Added**

- A vault connector in core (`src/agent/vault.ts`): raw SQLite tables `app_vault_items`, `app_vault_keys` and `app_vault_audit`, made when the agent opens. Bot secrets are AES-256-GCM ciphertext under a per-lane data key, with a fresh IV per write and AAD binding the row's id, tier, provider and key version. Personal rows are stored opaque, with `name`, `hint` and `policy` NULL (COD-258 fills them from the browser).
- Envelope keys: the new lane secret `MIPI_VAULT_KEY` (32 random bytes, base64) wraps the data key; `MIPI_VAULT_KEY_PREVIOUS` rotates it (the agent rewraps the data key on open). The stored key fingerprint catches a wrong key on open.
- `fetchWithSecret` checks everything before it decrypts: the lock, the row, the calling bot (`bots`: conversation ids; a cobot uses its bot's), expiry, the provider, the method for the tool's intent, https and the port, `refusedUrl`, listed hosts, paths on whole segments, dot segments and encoded separators as written and after parsing, and headers the model may never set. Then the ask decision: a change always asks; a read asks under `approve`, and under `auto` in a run that read untrusted content, answers a non-owner input or is automated. Redirects are followed by hand for reads only, each hop checked again; a hop to another host fails without sending the secret. The response, its headers, URL and errors are scrubbed (raw, JSON-escaped, percent-encoded in any case, base64 and base64url, padded or not) and `Set-Cookie` is dropped. Values shorter than 8 characters, and personal-only categories (`payment`, `login`, `contact`), are refused when saved.
- A hash-chained audit: one row per use or refusal with the calling conversation, never the query string, kept for good; `verifyAudit` finds an edit or a gap.
- The provider seam: `vaultProviders` on `MipiExtension` (`VaultProviderRegistration`), with only `mipi` built in. A provider registered twice, or named `mipi`, refuses to compose.
- The admin status gains `vault`: lock state and reason, the stored key's fingerprint, and row counts per tier.
- `node scripts/deploy.ts vault-check`, run by the deploy before the backup and `wrangler deploy`: it refuses a lane that has bot secrets when the deploy's `MIPI_VAULT_KEY` is missing, isn't a key, or matches neither the stored fingerprint nor `MIPI_VAULT_KEY_PREVIOUS`.
- `docs/vault-plan.md`: the vault's design and phases, updated with each vault issue (Linear stays the source of truth).

**Changed**

- `refusedUrl` and `web_fetch`'s redirect limit, deadline and body cap moved into core (`src/agent/outbound.ts`) so the vault shares them. `web_fetch` re-exports them and behaves the same.
- `deploy.yml` passes `MIPI_VAULT_KEY` and `MIPI_VAULT_KEY_PREVIOUS`, each written as `off` when unset, since `--secrets-file` only adds.

**Pi Durable**

- No version change (1.6.1) and no ledger change. The vault's tables are raw Durable Object SQLite, not Pi Durable documents. Injecting and scrubbing will happen in `execute()` (COD-257), so L14 holds.

**Migration**

- New lane secret `MIPI_VAULT_KEY`. Until it is set the vault is locked ("MIPI_VAULT_KEY is not set") and everything else works. Set it per lane, with a different value in each: make one with `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`, then GitHub → the MiPi repo → **Settings** → **Environments** → **staging** (then **production**) → **Add environment secret** `MIPI_VAULT_KEY`.
- Three new tables, included in exports as ciphertext. Not one-way: an older build ignores them. This release's fixture (`pnpm fixture:capture` after `pnpm bump`) seeds a personal row, a bot secret and an audit row, and the fixture test unlocks them with the test key and checks a wrong host is still refused.
