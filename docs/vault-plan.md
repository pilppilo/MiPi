# MiPi Vault: plan and design

> [!NOTE]
> Linear is the source of truth for the vault: the parent issue COD-254 and its issues COD-255 to COD-261. This file is
> the design they share, kept in the repo and updated in the same PR as each issue's code. Where the two disagree,
> Linear and the code win, and this file is fixed. The end-user guide will be `docs/vault.md` (COD-256).

**Status:** issue 1 (COD-255, vault core) is implemented. Issues 2 to 7 are planned.

## What the vault is

The vault keeps two kinds of secrets in your own MiPi. MiPi can use only the second kind, only where you allow it, and
never sees either kind's value.

|                              | Personal items                                                                 | Bot secrets                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Examples                     | Logins, payment cards, contact details, notes                                  | API keys and tokens, such as a GitHub token                           |
| Who can read the value       | Only you, in your browser, after you unlock the vault. Names are encrypted too | Nobody reads it. MiPi's server attaches it to requests you allowed    |
| Can the assistant use it?    | Never                                                                          | Only on the sites you list. Reading can be allowed; changes ask first |
| If you forget the passphrase | Your recovery key opens it. Without either, the items are gone                 | Not affected                                                          |
| Where you manage it          | The Vault space in the web app                                                 | The Vault space in the web app                                        |

Day to day:

- **You add and change secrets only in the web app**, never by typing them into a chat or Telegram: a secret typed
  into Telegram would sit on Telegram's servers. When the assistant needs a secret you haven't added, the web app shows
  a card where you paste it and check its rules, then choose Save & continue, Save locked, or Deny.
- **The assistant sees names, never values.** It knows you have "GitHub token, for api.github.com". It never sees the
  token in any chat, summary, log or backup.
- **Each bot secret works only on the sites you list**, and is refused anywhere else before it is decrypted. It also
  names which of your bots may use it: none by default, and a bot's side chats (cobots) share their bot's access.
- **You can ask for a yes every time.** For each bot secret: never usable, ask each time, or allowed for reading.
  Anything that changes data on the other site always asks. Even an allowed read asks when the request came from
  someone other than you (the relay, another bot), from a reminder, or after the assistant read a web page in that run.
- **Every use is recorded:** when, by which tool and conversation, for which site, and whether it was allowed.
- **Backups stay safe.** Backups contain only encrypted secrets. The key to bot secrets is kept apart from your data,
  and only you hold the key to your personal items.

## Security promises

Seven rules hold in every phase; a change that breaks one is a review finding. Taking a secret's value is blocked
everywhere. Misusing a bot secret on an allowed site is limited, not blocked.

1. **No value in model context.** Nothing the model reads holds a value: system sections, messages, tool arguments,
   tool results, errors, compaction summaries, the diagnostic log. The model sees a handle (`sec_…`) and safe metadata.
2. **No tool returns a value.** There is no `get_secret`. A bot secret is used only inside `fetchWithSecret`, which
   attaches it to a request and returns the scrubbed response.
3. **Every bot secret names its hosts, methods, paths and bots.** Nothing is valid for every host. A request outside
   the rules is refused before the value is decrypted.
4. **The server never holds a personal item's key.** Personal items are encrypted and decrypted in the browser.
5. **Ciphertext only, everywhere it is stored.** Plaintext never appears in exports, fixtures or the diagnostic log.
   The bot-secret key lives in GitHub Environment secrets, never in the database.
6. **Code in a sandbox never sees a value.** A future sandbox gets a placeholder, and the proxy outside it swaps in the
   value on the way out.
7. **Fail closed.** A missing key, a bad record, an unknown provider or a host mismatch refuses with a clear message.
   It never falls back to plaintext or to a wider rule.

| Threat                                                 | Covered?                                                                  | How                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection tries to read a secret                | Yes                                                                       | Rules 1 and 2: there is nothing to read                                                                                                                             |
| Prompt injection sends a secret to another site        | Yes                                                                       | Rule 3: host and port checked before decrypting. Redirects are followed by hand and checked on every hop                                                            |
| Prompt injection misuses a secret on an allowed site   | Partly                                                                    | Method and path rules on segment boundaries, least-privilege tokens. Every change goes through `secret_request`, which always asks. Reads ask in untrusted runs too |
| An API echoes the secret back                          | Mostly                                                                    | The scrubber replaces the value and its encoded forms. An API asked to transform it differently can beat this, so it is never relied on alone                       |
| Another website makes your signed-in browser change it | Yes                                                                       | Changing vault routes check the request comes from MiPi's own page (`Origin`, `Sec-Fetch-Site`) and take JSON only on POST, PUT and PATCH. No response is cached    |
| A leaked export, backup or fixture                     | Yes                                                                       | Rule 5                                                                                                                                                              |
| Someone reaches the vault routes without signing in    | Yes                                                                       | The Cloudflare Access check every web route uses (`src/worker/auth.ts`)                                                                                             |
| Code running in MiPi's Worker is compromised           | Bot secrets: no. Personal items: yes, unless it also serves bad page code | The Worker holds the bot-secret key. It never holds a personal-item key, but it serves the page that does (see Tier A)                                              |
| Cloudflare itself                                      | No                                                                        | MiPi runs on Cloudflare; this is the accepted trust base                                                                                                            |

## Where it fits in MiPi

The vault is a core connector plus one built-in extension. Providers are optional extensions, and the web door only
manages items, following the tiers in [`AGENTS.md`](../AGENTS.md).

- **Why core.** Extensions can't import each other, and tools in several extensions need `fetchWithSecret`, so the
  vault is a connector, like providers and approvals. It names no extension, door or provider.
- **Why the tools are an extension.** `vault_list`, `secret_get` and `secret_request` are a feature: they go in
  `src/extensions/builtin/vault/` plus one line in `builtins.ts`, and reach a conversation only once `profiles.ts`
  names them.
- **Why the web door.** Managing items is a screen, not agent behaviour, and a secret typed in Telegram would sit on
  Telegram's servers. This is a deliberate difference between doors.

Telegram and the relay have no vault screens.

## Tier A: personal items, encrypted in the browser (COD-258)

The server stores and syncs personal items but can never read them: the browser derives the key from your passphrase,
and only ciphertext leaves it.

- The passphrase goes through Argon2id (a WASM build) to make a wrapping key. If the WASM package fails review,
  PBKDF2-SHA-256 from Web Crypto is the fallback. Both at OWASP's minimums: Argon2id with m ≥ 19 MiB, t ≥ 2, p = 1, or
  PBKDF2-HMAC-SHA256 with 600,000 iterations. The parameters are stored with the vault so they can be raised later.
- A random 256-bit vault key encrypts every item (AES-256-GCM, a fresh 96-bit IV per write, the item id as AAD). The
  server stores it only wrapped by the passphrase key, and a second copy wrapped by a recovery key.
- The recovery key is shown once at setup. MiPi can't recover the vault without it.
- After unlocking, the vault key stays in the tab's memory only, never in `localStorage`, and locks after an idle time.
- **What the server stores per item:** id, category, timestamps and the ciphertext. The name and hint are encrypted with
  the item (`name`, `hint` and `policy` are `NULL` on personal rows). On unlock the browser decrypts every header for
  search. While locked, the Vault space can still show counts per category.
- **Where the code goes.** The crypto is plain Web Crypto plus Argon2id in `src/lib/vault-crypto.ts`, with no Pi
  imports and no door, so a later native door can reuse it; it takes the `SubtleCrypto` it uses as a parameter. Unlock
  state lives in the web view layer, outside `src/client/session/`. Core only stores and serves opaque rows (today:
  `Vault.putPersonal`).

**Limits, stated plainly**

- The same Worker serves the page's JavaScript, so a compromised Worker could serve code that captures your
  passphrase. Subresource Integrity can't stop that, because the Worker serves both the page and its hashes. A separate
  static deploy for the Vault UI would close it, and is deferred (see Decisions).
- A strict Content Security Policy still limits injected script. It is set on the SPA's `index.html` response and tested
  against Vite's production build. Argon2id in WASM needs `'wasm-unsafe-eval'` in `script-src`, and nothing wider; if
  PBKDF2 ships instead, that is left out too.
- Categories `payment`, `login` and `contact` are personal only, in code (`PERSONAL_ONLY_CATEGORIES`). No setting lets
  the assistant use them.

## Tier B: bot secrets, used only through fetchWithSecret (COD-255)

A bot secret is decrypted in memory for one request, inside core, after every policy check has passed. Its value
leaves that function only in the outgoing request's header.

**Each secret's policy** (plaintext metadata, owner-edited in the Vault space; `src/agent/vault-policy.ts`)

- `botAccess`: `none` | `approve` | `auto`. `auto` covers reads (`secret_get`) only; `secret_request` always asks.
- `bots`: the conversation ids of the bots that may use it (MiPi, purpose bots), default `[]`. Ids, never names, so
  renaming or archiving a bot never breaks or hands over a grant. A cobot uses its bot's id (`meta.bot`); a plain chat
  from before bots, a fork and a subagent match none (`resolveBotId`).
- `hosts`: exact hostnames, normalized like `normalHost`. `https` only, on port 443 unless the policy names one other
  `port`. IP literals, local names and MiPi's own hosts are refused by `refusedUrl`, which moved from `web_fetch` into
  core (`src/agent/outbound.ts`) so both share it.
- `methods`: such as `GET` only, or `GET, POST`.
- `paths`: optional path prefixes matched on whole segments: `/repos/pilppilo` matches `/repos/pilppilo/mipi`, never
  `/repos/pilppilo-other`.
- `inject`: a header name plus a template with `{}` once, such as `Authorization: Bearer {}`. Never the URL. The model
  can't set that header, nor `Authorization`, `Cookie`, `Host`, `Proxy-Authorization` or the connection's own headers.
- `expiresAt`: optional. An expired secret is refused.
- Saving refuses a value shorter than 8 characters, so scrubbing it can never mangle ordinary text, and a category
  that is personal only.

**fetchWithSecret, step by step** (`Vault.fetchWithSecret` in `src/agent/vault.ts`)

1. Refuse when the vault is locked (with its reason), the id is unknown, the row is personal or doesn't read back,
   `botAccess` is `none`, the calling bot's id isn't in `bots`, the secret has expired, or its provider isn't installed.
2. Check the request, all before decrypting: refuse a raw path with a `.` or `..` segment, a backslash, or an encoded
   separator or dot (`%2f`, `%5c`, `%2e`, any case), as written and after parsing; check host, port, method (and that
   it fits the tool: reads for `secret_get`, changes for `secret_request`) and path; refuse any header the model may
   not set, and a body on a read.
3. Decide whether to ask (`askDecision`). A change always asks. A read asks under `approve`, and under `auto` too when
   the run touched an untrusted tool, any input of the turn has authority other than `owner` (the relay, a bot hop), or
   any input is automated (a reminder). `askFacts` reads these in the tool's commit.
4. An ask returns `{ kind: "ask" }` with what the card shows (the secret's name, method, host and path). Issue 3 parks
   the tool with the approval gate's `self` path and calls again with `approved` after the yes; every check runs again.
   A no or a timeout is recorded with `recordDenied`.
5. Decrypt with AES-256-GCM under the lane's data key. The AAD binds the row id, tier, provider and key version, so
   ciphertext can't move between rows, tiers or providers. For another provider, the decrypted text is its reference,
   resolved at send time.
6. Send with `redirect: "manual"`. Only `GET` and `HEAD` follow redirects; a change gets the redirect back unfollowed.
   Every hop is checked again, and a hop to another host drops the secret and fails. The redirect limit, deadline and
   body cap are `web_fetch`'s.
7. Scrub the body, response headers, URL and any error text: the value and its encoded forms (JSON-escaped,
   percent-encoded in any case, base64 and base64url, padded or not) become `[REDACTED:<id>]`. `Set-Cookie` is dropped.
8. Write an audit row: secret id, calling conversation, tool, method, host, path (never the query), decision
   (`allowed`, `approved`, `refused`, `denied`), status or reason, time.

**Rules that come from MiPi's code**

- **Two tools, because replay is fixed per tool** (Pi Durable 1.6.1 `ToolRegistration.replay`): `secret_get` handles
  `GET` and `HEAD` with `replay: "safe"` and is the only tool `auto` applies to. `secret_request` handles every other
  method, with `replay: "unsafe"`, `writesOutside: true` and a `self` approval.
- **Inject in `execute()`, never in `beforeTool`** (ledger L14): approval cards show the arguments as the model sent
  them. Arguments hold the secret id, never the value.
- **Scrub inside `execute()`, errors included**, so Pi Durable only ever stores clean results. No ledger entry.
- **Results are untrusted.** Both tools are declared in `untrustedTools` and fenced like a web page.

## Storage, keys, backups and upgrades (COD-255)

The vault lives in its own raw SQLite tables next to `app_meta` and `app_diag_events`, made when the agent opens (never
while maintenance runs). They are included in every export as ciphertext. No Pi Durable documents, so no ledger entry.

| Table             | Holds                                                                                                                                                                                                                    | In exports?        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `app_vault_items` | One row per item: id, tier (`personal` or `bot`), category, name and hint (NULL on personal rows), policy (bot rows; name, hint and policy are nullable from day one), provider, ciphertext, IV, key version, timestamps | Yes, as ciphertext |
| `app_vault_keys`  | The bot data key wrapped by `MIPI_VAULT_KEY`, with the key's fingerprint; later the personal vault key wrapped twice (passphrase, recovery key), with the Argon2id parameters                                            | Yes, wrapped only  |
| `app_vault_audit` | One row per use or refusal, with the calling conversation. Each row carries the hash of the one before it, so a gap or edit shows (`verifyAudit`). Kept for good                                                         | Yes                |

**Keys: envelope encryption**

- `MIPI_VAULT_KEY` (32 random bytes, base64) is a secret in each GitHub Environment, `staging` and `production`, never
  the same value in both. `deploy.yml` passes it like the other lane secrets.
- It wraps one random data key per lane, and the data key encrypts the bot rows, so rotating the lane key rewraps one
  row instead of re-encrypting every secret.
- Rotation follows the `_PREVIOUS` pattern: set the new key, put the old one in `MIPI_VAULT_KEY_PREVIOUS` for one
  deploy, and the agent rewraps the data key on open. Then delete the previous one.
- `deploy.yml` always writes both names, an unset one as `off`, as it does for `RELAY_TOKEN_PREVIOUS`:
  `wrangler deploy --secrets-file` only adds. Core accepts only a valid 32-byte base64 key, so `off` is never one.
- `app_vault_keys` stores the key's fingerprint (16 bytes of SHA-256 over a fixed label and the key), so a wrong or
  missing key is caught when the agent opens and before a deploy, not on first use.
- With no bot secrets stored, a new key simply replaces the data key: nothing is lost.

**Failing clearly**

- A missing, invalid or wrong key locks the vault alone (`locked: <reason>`), and every secret call refuses with that
  reason. Chat, Telegram and reminders keep working while you fix the key.
- `scripts/deploy.ts vault-check` runs before the backup and `wrangler deploy`. It reads the running agent's admin
  status (`vault`: state, key fingerprint, row counts) and refuses a lane that has bot secrets when the deploy's
  `MIPI_VAULT_KEY` is missing, isn't a key, or matches neither the stored fingerprint nor `MIPI_VAULT_KEY_PREVIOUS`.

**Backups and restore**

- The vault is the agent's data, not operational state, so unlike `app_diag_events` it stays in exports. An export
  holds no usable secret without the lane's key.
- A production backup restored to staging can't open production's bot secrets, because the lanes have different keys.
  That is intended. Personal items open anywhere with your passphrase.

**Fixtures (from 0.1.0-beta.1 on)**

- The release that adds the tables runs `pnpm fixture:capture`. `test/fixture-capture.test.ts` seeds a personal row, a
  bot secret and an audit row under the test lane key (`vitest.config.ts`).
- `test/fixtures.test.ts` then checks that a restored fixture unlocks with that key, that its audit chain verifies, and
  that the bot secret's policy still refuses a wrong host. Every fixture, older ones too, must open with the vault open.
- Adding tables is not one-way: an older build ignores them. Removing or reshaping them later would be.

## Optional providers and sandboxes

MiPi's own vault is always there and is the default. Another store, such as Bitwarden, can only hold a bot secret's
value: the policy, approvals and audit stay in MiPi, so removing a provider changes nothing about security.

**The provider seam** (follows `providers.ts`; `src/agent/vault-connector.ts`)

- Core defines `VaultProviderRegistration`: a provider id, a label, and `resolve(reference, fetcher)`, which returns
  the value for one request or throws a short reason. It names no provider.
- A provider registers through `vaultProviders` on `MipiExtension`. One registered twice, or named `mipi`, refuses to
  compose.
- A bot row's `provider` is `mipi` (built in) or a registered id; its ciphertext then holds only the provider's
  reference, encrypted like a value.
- A row whose provider isn't installed or fails refuses with that reason (never the provider's error text). Values are
  never stored, only held in memory for one call.

**Bitwarden, as `src/extensions/optional/bitwarden/`** (COD-260)

- Bitwarden Secrets Manager with a machine-account access token limited to one Bitwarden project. The token is one more
  lane secret (`BITWARDEN_ACCESS_TOKEN`); the extension is off when it's missing.
- The free Secrets Manager plan covers 2 users, 3 projects and 3 machine accounts, enough for MiPi.
- **Spike first:** its HTTP API with Web Crypto decryption. The Rust SDK only if the API falls short, checking its
  bundle size in a Worker and whether its licence fits an MIT project.
- Personal items are not synced with Bitwarden's password manager: its vault API exists only through `bw serve`, a
  local server that can't run in a Worker.

**Sandboxes (COD-191 / COD-261), once MiPi moves to Workers Paid**

- Cloudflare's Sandbox SDK and Containers support outbound Workers: per-host handlers outside the sandbox that add
  credentials to its HTTPS requests. The sandbox gets a placeholder; the handler runs the same policy as
  `fetchWithSecret`, then injects the value.
- A handler runs while the container's request is in flight, so it can't park for an approval. It allows only grants
  approved before the sandbox runs, or `auto` reads in a clean owner run, and answers 403 to anything else.

## Phases and issues

Seven issues, one branch and PR each, under COD-254. 1 to 3 make bot secrets usable, 4 adds personal items, and 5 to 7
build on them. Each PR carries a changeset and its docs, and updates this file.

| #           | Issue                               | Scope                                                                                                                                                                                                                                          | Needs         | Status  |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------- |
| 1 · COD-255 | Vault core                          | Tables, envelope keys and AAD, `MIPI_VAULT_KEY` and `_PREVIOUS` in `deploy.yml`, the deploy's vault check, vault status in admin status. `fetchWithSecret` with bot scoping, URL, header and redirect rules, the ask decision, scrubber, audit | —             | Done    |
| 2 · COD-256 | Vault routes and space              | `/api/vault/*` behind the owner check, same-origin checks on changes, JSON only on POST, PUT and PATCH, `no-store`. The Vault space: bot secrets and their policy, the bots checklist, the audit view, **Make a lane key**                     | 1             | Planned |
| 3 · COD-257 | Vault extension                     | `vault_list`, `secret_get`, `secret_request`, approval cards that name the secret, offered in `main` and `default`                                                                                                                             | 1             | Planned |
| 4 · COD-258 | Personal items                      | `src/lib/vault-crypto.ts`, encrypted names and hints, unlock, recovery key, idle lock, CSP on `index.html`                                                                                                                                     | 2             | Planned |
| 5 · COD-259 | Assistant asks for a missing secret | A masked input card with the policy pre-filled: Save & continue, Save locked, Deny                                                                                                                                                             | 2, 3          | Planned |
| 6 · COD-260 | Bitwarden spike, then extension     | HTTP API with Web Crypto first; the Rust SDK only if needed. Then `optional/bitwarden/`                                                                                                                                                        | 1             | Planned |
| 7 · COD-261 | Sandbox egress (COD-191)            | Outbound Worker handler using the same policy; only pre-approved grants or clean `auto` reads pass                                                                                                                                             | 1, containers | Planned |

**Owner setup, once issue 1 merges:** make a key per lane (`node -e "console.log(crypto.randomBytes(32).toString('base64'))"`),
then GitHub → the MiPi repo → **Settings** → **Environments** → **staging** → **Add environment secret**, name
`MIPI_VAULT_KEY`; the same in **production** with a **different** key. See [Deployment](deployment.md#the-vault-key).

## Decisions

Resolved on 28 Nov 2026 and recorded on COD-254.

- **Missing or wrong key:** the vault alone refuses (`locked: <reason>`). Chat, Telegram and reminders keep working.
- **Vault UI hosting:** no separate static deploy for now.
- **Who can use secrets:** the tools are offered in `main` and `default`, and each secret names its bots. Cobots
  inherit their bot's grants; plain chats from before bots have none.
- **Reads without approval:** only `auto` secrets through `secret_get`, on listed hosts, in owner runs that touched no
  untrusted content. Every write and every bot hop asks.
- **Missing-secret card:** policy is set on the card itself, with Save & continue or Save locked.
- **Bitwarden:** HTTP API with Web Crypto first.
- **Audit log:** kept for good, with no trimming. A later cap must store a pruning anchor (the last pruned id and its
  hash), or the chain stops verifying.

Made while building COD-255:

- A policy names one port at most; 443 is the default and isn't stored.
- A change (`secret_request`) gets a redirect back unfollowed; only reads follow.
- `Set-Cookie` is dropped from what the model sees: a session cookie is a credential of its own.
- A provider's error text never reaches a refusal: it could hold what the provider resolved.
- The deploy compares the key's fingerprint, not only its presence, so a wrong key is refused before it ships.
