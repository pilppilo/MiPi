/**
 * The vault (COD-254, COD-255): a core connector for secrets. It keeps two tiers of items in raw Durable Object SQLite,
 * outside Pi Durable, as ciphertext only:
 *
 * - **personal** items, encrypted and decrypted in the owner's browser. Core stores and serves their rows and never
 *   holds their key (COD-258).
 * - **bot** secrets, which tools use only through `fetchWithSecret`. A bot secret is decrypted in memory for one
 *   request, after every policy check passed, and its value leaves that function only in the outgoing request's header.
 *   Nothing the model reads ever holds it: the result is scrubbed, errors included.
 *
 * Keys are envelope keys: the lane's `MIPI_VAULT_KEY` (a Worker secret, never in the database) wraps one random data
 * key, and the data key encrypts the bot rows (AES-256-GCM, a fresh IV per write, AAD binding the row's id, tier,
 * provider and key version). Rotating the lane key rewraps that one row (`MIPI_VAULT_KEY_PREVIOUS` for one deploy). A
 * missing or wrong key locks the vault alone: every secret call refuses with the reason, and the rest of MiPi runs.
 *
 * Every use or refusal is an audit row, hash-chained to the one before it, kept for good.
 *
 * Another store can hold a bot secret's value (`VaultProviderRegistration`, registered by an extension): the row's
 * ciphertext then holds only the provider's reference, and the policy, approvals and audit stay here.
 *
 * Tools reach the agent's vault from their registry snapshot (`vaultOf(api.registry)`), bound on the agent's own core
 * extension, as connectors are (`vault-connector.ts`). Core code: it names no door, extension or provider.
 */
import { type ConversationId, type RegistrySnapshot, type Tx } from "./pi/durable.ts";
import {
  type AgentVault,
  boundVault,
  MIPI_PROVIDER,
  type VaultKeys,
  type VaultLock,
  type VaultProviderRegistration,
  type VaultProviders,
  type VaultStatus,
} from "./vault-connector.ts";
import { ConversationMeta } from "./conversations.ts";
import { connectorsOf } from "./connectors.ts";
import { runTouched, untrustedToolNames } from "./untrusted.ts";
import { FETCH_TIMEOUT_MS, MAX_RAW_BYTES, MAX_REDIRECTS, readCapped } from "./outbound.ts";
import { normalHost } from "./settings.ts";
import { type DiagSink, NOOP_DIAG } from "./diag.ts";
import {
  addressRefusal,
  type AskFacts,
  askDecision,
  categoryRefusal,
  checkPolicy,
  headerRefusal,
  methodRefusal,
  rawPathOf,
  rawPathRefusal,
  READ_METHODS,
  type HttpMethod,
  type SecretIntent,
  type SecretPolicy,
  urlRefusal,
  valueRefusal,
} from "./vault-policy.ts";
import { scrub, scrubPattern } from "./vault-scrub.ts";
import { parseVaultKey, vaultKeyFingerprint } from "../lib/vault-key.ts";
import { MIPI_VERSION } from "../version.ts";

export const VAULT_ITEMS_TABLE = "app_vault_items";
export const VAULT_KEYS_TABLE = "app_vault_keys";
export const VAULT_AUDIT_TABLE = "app_vault_audit";
export const VAULT_TABLES = [VAULT_ITEMS_TABLE, VAULT_KEYS_TABLE, VAULT_AUDIT_TABLE] as const;

/** The bot data key's row in `app_vault_keys`. */
const BOT_KEY_ID = "bot";

/** The previous hash of the first audit row. */
export const AUDIT_GENESIS = "0".repeat(64);

/** The most of a request body sent. */
export const MAX_REQUEST_BODY = 64 * 1024;

export type VaultTier = "personal" | "bot";

export {
  createVaultProviders,
  MIPI_PROVIDER,
  type VaultKeys,
  type VaultLock,
  type VaultProviderRegistration,
  type VaultProviders,
  type VaultStatus,
} from "./vault-connector.ts";

// ---- Status ----

const tableExists = (sql: SqlStorage, name: string): boolean =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length >
  0;

/**
 * The vault's row counts and stored key fingerprint, read without writing (no table is made), so it works in every
 * state: refused, maintenance, before the vault opened.
 */
export function readVaultRows(sql: SqlStorage): {
  readonly rows: VaultStatus["rows"];
  readonly keyFingerprint?: string;
} {
  const count = (table: string, where = ""): number =>
    tableExists(sql, table)
      ? sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} ${where}`).one().n
      : 0;
  const fingerprint = tableExists(sql, VAULT_KEYS_TABLE)
    ? (sql
        .exec<{ fingerprint: string | null }>(
          `SELECT fingerprint FROM ${VAULT_KEYS_TABLE} WHERE id = ?`,
          BOT_KEY_ID,
        )
        .toArray()[0]?.fingerprint ?? undefined)
    : undefined;
  return {
    rows: {
      personal: count(VAULT_ITEMS_TABLE, "WHERE tier = 'personal'"),
      bot: count(VAULT_ITEMS_TABLE, "WHERE tier = 'bot'"),
      audit: count(VAULT_AUDIT_TABLE),
    },
    ...(fingerprint === undefined ? {} : { keyFingerprint: fingerprint }),
  };
}

// ---- Items ----

/** A bot secret as the vault lists it: metadata only. */
export interface BotSecretInfo {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly hint?: string;
  readonly provider: string;
  readonly policy: SecretPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What saving a bot secret takes. `value` is the secret itself, or a provider's reference to it. */
export interface NewBotSecret {
  readonly category: string;
  readonly name: string;
  readonly hint?: string;
  readonly policy: unknown;
  readonly value: string;
  readonly provider?: string;
}

/** A personal item's row: encrypted in the browser, opaque here (COD-258). */
export interface PersonalRow {
  readonly category: string;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly keyVersion: number;
}

const MAX_NAME = 80;
const MAX_HINT = 120;

type ItemRow = {
  id: string;
  tier: string;
  category: string;
  name: string | null;
  hint: string | null;
  policy: string | null;
  provider: string;
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  key_version: number;
  created_at: number;
  updated_at: number;
};

/** The AAD of an item: its id, tier, provider and key version, so ciphertext can't move between rows. */
const itemAad = (id: string, tier: VaultTier, provider: string, keyVersion: number): Uint8Array =>
  new TextEncoder().encode(`mipi-vault:item:v1\0${id}\0${tier}\0${provider}\0${keyVersion}`);

const dataKeyAad = (keyVersion: number): Uint8Array =>
  new TextEncoder().encode(`mipi-vault:data-key:v1\0${BOT_KEY_ID}\0${keyVersion}`);

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A new item id: the handle the model sees (`sec_…`). */
export const newSecretId = (): string => `sec_${hex(randomBytes(12))}`;

const SECRET_ID = /^sec_[0-9a-f]{24}$/;

// ---- fetchWithSecret ----

/** One request a tool asks to send with a bot secret. */
export interface SecretCall {
  readonly secretId: string;
  /** `read` for `secret_get` (GET, HEAD), `change` for `secret_request` (every other method). */
  readonly intent: SecretIntent;
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Who is calling, and what the turn is: the policy and the ask read these. */
export interface SecretCaller {
  readonly conversationId: number;
  /** The calling bot's id (`resolveBotId`): a cobot's parent, none for a chat from before bots. */
  readonly botId: number | undefined;
  /** The tool's name, for the audit. */
  readonly tool: string;
  readonly facts: AskFacts;
  /** MiPi's own hostnames (`AgentSettings.ownHosts`): never sent a secret. */
  readonly ownHosts?: readonly string[];
}

/** What came of a call. Nothing in it holds the value. */
export type SecretFetchResult =
  | { readonly kind: "refused"; readonly reason: string }
  /** The owner must say yes first: what the card shows. Call again with `approved` after the yes. */
  | {
      readonly kind: "ask";
      readonly secretName: string;
      readonly method: string;
      readonly host: string;
      readonly path: string;
    }
  | {
      readonly kind: "response";
      readonly url: string;
      readonly status: number;
      readonly statusText: string;
      readonly headers: readonly (readonly [string, string])[];
      readonly body: string;
      /** The body was longer than `MAX_RAW_BYTES` and was cut. */
      readonly cut: boolean;
    }
  /** Sent, but no answer came (a timeout, a network error, a refused redirect): scrubbed. */
  | { readonly kind: "failed"; readonly reason: string };

/** An audit decision: allowed without asking, approved by the owner, refused by policy, denied by the owner. */
export type AuditDecision = "allowed" | "approved" | "refused" | "denied";

/** One audit row, as read back. */
export interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly secretId: string;
  readonly conversationId: number | null;
  readonly tool: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly decision: AuditDecision;
  readonly status: number | null;
  readonly reason: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

type AuditInput = Omit<AuditRow, "id" | "at" | "prevHash" | "hash">;

async function auditHash(
  prevHash: string,
  row: Omit<AuditRow, "prevHash" | "hash">,
): Promise<string> {
  const canonical = JSON.stringify([
    prevHash,
    row.id,
    row.at,
    row.secretId,
    row.conversationId,
    row.tool,
    row.method,
    row.host,
    row.path,
    row.decision,
    row.status,
    row.reason,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return hex(new Uint8Array(digest));
}

/** What a URL shows in the audit and on a card: its host and path, never its query. */
function where(address: string): { readonly host: string; readonly path: string } {
  try {
    const url = new URL(address);
    return { host: normalHost(url.hostname), path: url.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

const clipText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export interface VaultOptions {
  readonly providers?: VaultProviders;
  readonly diag?: DiagSink;
  /** The outbound fetch: the Worker's own. */
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => number;
  /** Tests only: a shorter deadline. */
  readonly timeoutMs?: number;
}

export class Vault implements AgentVault {
  readonly #sql: SqlStorage;
  readonly #providers: VaultProviders;
  readonly #diag: DiagSink;
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #lock: VaultLock = { state: "locked", reason: "the vault hasn't opened yet" };
  #dataKey: { readonly key: CryptoKey; readonly version: number } | undefined;
  /** Audit appends, one at a time, so each reads the hash the one before it wrote. */
  #auditTail: Promise<unknown> = Promise.resolve();

  constructor(sql: SqlStorage, options: VaultOptions = {}) {
    this.#sql = sql;
    this.#providers = options.providers ?? new Map();
    this.#diag = options.diag ?? NOOP_DIAG;
    this.#fetch = options.fetch ?? ((request) => fetch(request));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  get lock(): VaultLock {
    return this.#lock;
  }

  status(): VaultStatus {
    const { rows, keyFingerprint } = readVaultRows(this.#sql);
    return {
      state: this.#lock.state,
      ...(this.#lock.state === "locked" ? { reason: this.#lock.reason } : {}),
      ...(keyFingerprint === undefined ? {} : { keyFingerprint }),
      rows,
    };
  }

  /** Makes the tables (when the agent opens: never while maintenance runs, since an export fingerprints the schema). */
  #ensureTables(): void {
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${VAULT_ITEMS_TABLE} (
         id TEXT PRIMARY KEY,
         tier TEXT NOT NULL,
         category TEXT NOT NULL,
         name TEXT,
         hint TEXT,
         policy TEXT,
         provider TEXT NOT NULL,
         ciphertext BLOB NOT NULL,
         iv BLOB NOT NULL,
         key_version INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${VAULT_KEYS_TABLE} (
         id TEXT PRIMARY KEY,
         wrapped BLOB NOT NULL,
         iv BLOB NOT NULL,
         fingerprint TEXT,
         params TEXT,
         key_version INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${VAULT_AUDIT_TABLE} (
         id INTEGER PRIMARY KEY,
         at INTEGER NOT NULL,
         secret_id TEXT NOT NULL,
         conversation_id INTEGER,
         tool TEXT NOT NULL,
         method TEXT NOT NULL,
         host TEXT NOT NULL,
         path TEXT NOT NULL,
         decision TEXT NOT NULL,
         status INTEGER,
         reason TEXT,
         prev_hash TEXT NOT NULL,
         hash TEXT NOT NULL
       )`,
    );
  }

  #locked(reason: string): void {
    this.#lock = { state: "locked", reason };
    this.#dataKey = undefined;
    this.#diag.emit({
      level: "warn",
      source: "vault",
      kind: "vault.locked",
      outcome: "refused",
      summary: `The vault is locked: ${reason}`,
      detail: { botRows: readVaultRows(this.#sql).rows.bot },
    });
  }

  /**
   * Opens the vault with the lane's keys: makes the tables, then unwraps the data key. A first open makes the data key.
   * A key that matches `previous` is rotated: the data key is rewrapped with `current`. With no bot secrets stored, a
   * new key simply replaces the data key, since nothing is lost. Anything else locks the vault alone, with a reason.
   * Never throws: a failure is a lock.
   */
  async open(keys: VaultKeys): Promise<void> {
    try {
      await this.#open(keys);
    } catch (error) {
      this.#locked(`opening failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #open(keys: VaultKeys): Promise<void> {
    this.#ensureTables();
    const current = parseVaultKey(keys.current, "MIPI_VAULT_KEY");
    const previous = parseVaultKey(keys.previous, "MIPI_VAULT_KEY_PREVIOUS");
    if (current.kind === "invalid") return this.#locked(current.reason);
    if (previous.kind === "invalid") return this.#locked(previous.reason);
    if (current.kind === "unset") return this.#locked("MIPI_VAULT_KEY is not set");
    const fingerprint = await vaultKeyFingerprint(current.bytes);
    const stored = this.#sql
      .exec<{
        wrapped: ArrayBuffer;
        iv: ArrayBuffer;
        fingerprint: string | null;
        key_version: number;
      }>(
        `SELECT wrapped, iv, fingerprint, key_version FROM ${VAULT_KEYS_TABLE} WHERE id = ?`,
        BOT_KEY_ID,
      )
      .toArray()[0];
    const kek = await importAesKey(current.bytes, ["encrypt", "decrypt"]);
    const botRows = readVaultRows(this.#sql).rows.bot;
    if (stored === undefined) {
      await this.#newDataKey(kek, fingerprint, 1, "insert");
      return this.#opened("made the data key");
    }
    if (stored.fingerprint === fingerprint) {
      const dataKey = await unwrapDataKey(kek, stored);
      if (dataKey === undefined) {
        return botRows === 0
          ? this.#replaceEmpty(kek, fingerprint, stored.key_version)
          : this.#locked("the stored data key doesn't open with MIPI_VAULT_KEY");
      }
      dataKey.raw.fill(0);
      this.#dataKey = { key: dataKey.key, version: stored.key_version };
      return this.#opened();
    }
    if (
      previous.kind === "key" &&
      stored.fingerprint === (await vaultKeyFingerprint(previous.bytes))
    ) {
      const oldKek = await importAesKey(previous.bytes, ["decrypt"]);
      const dataKey = await unwrapDataKey(oldKek, stored);
      if (dataKey === undefined) {
        return this.#locked("the stored data key doesn't open with MIPI_VAULT_KEY_PREVIOUS");
      }
      const iv = randomBytes(12);
      const wrapped = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: dataKeyAad(stored.key_version) },
        kek,
        dataKey.raw,
      );
      this.#sql.exec(
        `UPDATE ${VAULT_KEYS_TABLE} SET wrapped = ?, iv = ?, fingerprint = ?, updated_at = ? WHERE id = ?`,
        wrapped,
        iv,
        fingerprint,
        this.#now(),
        BOT_KEY_ID,
      );
      dataKey.raw.fill(0);
      this.#dataKey = { key: dataKey.key, version: stored.key_version };
      return this.#opened("rewrapped the data key with the new MIPI_VAULT_KEY");
    }
    if (botRows === 0) return this.#replaceEmpty(kek, fingerprint, stored.key_version);
    return this.#locked(
      "MIPI_VAULT_KEY doesn't match the key this lane's bot secrets were saved with",
    );
  }

  /** No bot secret depends on the stored data key: a new one replaces it. */
  async #replaceEmpty(kek: CryptoKey, fingerprint: string, version: number): Promise<void> {
    await this.#newDataKey(kek, fingerprint, version + 1, "update");
    this.#opened("replaced the data key: no bot secrets were stored");
  }

  async #newDataKey(
    kek: CryptoKey,
    fingerprint: string,
    version: number,
    write: "insert" | "update",
  ): Promise<void> {
    const raw = randomBytes(32);
    const iv = randomBytes(12);
    const wrapped = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: dataKeyAad(version) },
      kek,
      raw,
    );
    const now = this.#now();
    if (write === "insert") {
      this.#sql.exec(
        `INSERT INTO ${VAULT_KEYS_TABLE} (id, wrapped, iv, fingerprint, params, key_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        BOT_KEY_ID,
        wrapped,
        iv,
        fingerprint,
        version,
        now,
        now,
      );
    } else {
      this.#sql.exec(
        `UPDATE ${VAULT_KEYS_TABLE} SET wrapped = ?, iv = ?, fingerprint = ?, key_version = ?, updated_at = ?
         WHERE id = ?`,
        wrapped,
        iv,
        fingerprint,
        version,
        now,
        BOT_KEY_ID,
      );
    }
    this.#dataKey = { key: await importAesKey(raw, ["encrypt", "decrypt"]), version };
    raw.fill(0);
  }

  #opened(change?: string): void {
    this.#lock = { state: "open" };
    this.#diag.emit({
      level: "info",
      source: "vault",
      kind: "vault.open",
      outcome: "ok",
      summary: change === undefined ? "The vault opened" : `The vault opened and ${change}`,
      detail: { botRows: readVaultRows(this.#sql).rows.bot },
    });
  }

  // ---- Items ----

  /** Saves a new bot secret, checked: its category, name, policy, provider and value. Returns its id. */
  async saveBotSecret(
    input: NewBotSecret,
  ): Promise<
    { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }
  > {
    const refused = this.#botSecretRefusal(input);
    if (refused !== undefined) return { ok: false, reason: refused };
    const checked = checkPolicy(input.policy);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if (this.#dataKey === undefined || this.#lock.state !== "open") {
      return { ok: false, reason: this.#lockReason() };
    }
    const provider = input.provider ?? MIPI_PROVIDER;
    const id = newSecretId();
    const { key, version } = this.#dataKey;
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: itemAad(id, "bot", provider, version) },
      key,
      new TextEncoder().encode(input.value),
    );
    const now = this.#now();
    this.#sql.exec(
      `INSERT INTO ${VAULT_ITEMS_TABLE}
         (id, tier, category, name, hint, policy, provider, ciphertext, iv, key_version, created_at, updated_at)
       VALUES (?, 'bot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.category,
      input.name.trim(),
      input.hint?.trim() || null,
      JSON.stringify(checked.policy),
      provider,
      ciphertext,
      iv,
      version,
      now,
      now,
    );
    return { ok: true, id };
  }

  #botSecretRefusal(input: NewBotSecret): string | undefined {
    const category = categoryRefusal(input.category);
    if (category !== undefined) return category;
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME) return `a name is 1–${MAX_NAME} characters`;
    if ((input.hint?.length ?? 0) > MAX_HINT) return `a hint is at most ${MAX_HINT} characters`;
    const provider = input.provider ?? MIPI_PROVIDER;
    if (provider !== MIPI_PROVIDER && !this.#providers.has(provider)) {
      return `the provider "${provider}" isn't installed`;
    }
    // A provider's reference isn't the value, so only the built-in store's values have a minimum length.
    if (provider === MIPI_PROVIDER) return valueRefusal(input.value);
    return input.value.length === 0 ? "a provider reference can't be empty" : undefined;
  }

  /** Replaces a bot secret's policy, checked. */
  updatePolicy(
    id: string,
    policy: unknown,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const checked = checkPolicy(policy);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const changed = this.#sql.exec(
      `UPDATE ${VAULT_ITEMS_TABLE} SET policy = ?, updated_at = ? WHERE id = ? AND tier = 'bot'`,
      JSON.stringify(checked.policy),
      this.#now(),
      id,
    ).rowsWritten;
    return changed > 0 ? { ok: true } : { ok: false, reason: "no such bot secret" };
  }

  /** Deletes an item of either tier. Its audit rows stay. */
  remove(id: string): boolean {
    return this.#sql.exec(`DELETE FROM ${VAULT_ITEMS_TABLE} WHERE id = ?`, id).rowsWritten > 0;
  }

  /** Stores a personal item's row as the browser encrypted it: no name, hint or policy here (COD-258). */
  putPersonal(row: PersonalRow, id: string = newSecretId()): string {
    const now = this.#now();
    this.#sql.exec(
      `INSERT INTO ${VAULT_ITEMS_TABLE}
         (id, tier, category, name, hint, policy, provider, ciphertext, iv, key_version, created_at, updated_at)
       VALUES (?, 'personal', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      id,
      row.category,
      MIPI_PROVIDER,
      row.ciphertext,
      row.iv,
      row.keyVersion,
      now,
      now,
    );
    return id;
  }

  /** The bot secrets, metadata only. A row that doesn't read back is left out (and refused when used). */
  listBotSecrets(): BotSecretInfo[] {
    if (!tableExists(this.#sql, VAULT_ITEMS_TABLE)) return [];
    return this.#sql
      .exec<ItemRow>(
        `SELECT * FROM ${VAULT_ITEMS_TABLE} WHERE tier = 'bot' ORDER BY created_at, id`,
      )
      .toArray()
      .flatMap((row) => {
        const read = botInfo(row);
        return read.kind === "ok" ? [read.info] : [];
      });
  }

  #row(id: string): ItemRow | undefined {
    if (!tableExists(this.#sql, VAULT_ITEMS_TABLE)) return undefined;
    return this.#sql
      .exec<ItemRow>(`SELECT * FROM ${VAULT_ITEMS_TABLE} WHERE id = ?`, id)
      .toArray()[0];
  }

  #lockReason(): string {
    return this.#lock.state === "locked" ? `locked: ${this.#lock.reason}` : "locked";
  }

  // ---- fetchWithSecret ----

  /**
   * Sends one request with a bot secret, by the policy. Every check runs before the value is decrypted: the lock, the
   * row, the bot, the expiry, the provider, the method, the URL (as written and parsed), the caller's headers. Then
   * the ask: a call that must ask returns `ask` unless `approved` (the owner said yes; the tool calls again, and every
   * check runs again). Then the value is decrypted, put in the policy's header, and sent with redirects followed by
   * hand, each hop checked again; a hop to another host refuses and the secret goes nowhere else. The response, its
   * headers and any error are scrubbed. Every outcome but `ask` writes an audit row.
   */
  async fetchWithSecret(
    call: SecretCall,
    caller: SecretCaller,
    options: { readonly approved?: boolean } = {},
  ): Promise<SecretFetchResult> {
    const method = call.method.toUpperCase();
    const { host, path } = where(call.url);
    const audit = (decision: AuditDecision, status: number | null, reason: string | null) =>
      this.#appendAudit({
        secretId: clipText(call.secretId, 64),
        conversationId: caller.conversationId,
        tool: clipText(caller.tool, 64),
        method: clipText(method, 16),
        host: clipText(host, 253),
        path: clipText(path, 512),
        decision,
        status,
        reason: reason === null ? null : clipText(reason, 300),
      });
    const refuse = async (reason: string): Promise<SecretFetchResult> => {
      await audit("refused", null, reason);
      return { kind: "refused", reason };
    };

    if (this.#lock.state !== "open" || this.#dataKey === undefined)
      return refuse(this.#lockReason());
    if (!SECRET_ID.test(call.secretId)) return refuse("no such secret");
    const row = this.#row(call.secretId);
    if (row === undefined) return refuse("no such secret");
    if (row.tier !== "bot") return refuse("that item is personal; the assistant can never use it");
    const read = botInfo(row);
    if (read.kind === "bad") return refuse(`the stored secret is unreadable: ${read.reason}`);
    const { info } = read;
    const { policy } = info;
    if (policy.botAccess === "none") return refuse(`${info.name} is not usable by the assistant`);
    if (caller.botId === undefined || !policy.bots.includes(caller.botId)) {
      return refuse(`this bot may not use ${info.name}`);
    }
    if (policy.expiresAt !== undefined && this.#now() >= policy.expiresAt) {
      return refuse(`${info.name} has expired`);
    }
    const provider =
      info.provider === MIPI_PROVIDER ? undefined : this.#providers.get(info.provider);
    if (info.provider !== MIPI_PROVIDER && provider === undefined) {
      return refuse(`${info.name}'s provider "${info.provider}" isn't installed`);
    }
    const methodRefused = methodRefusal(method, call.intent, policy);
    if (methodRefused !== undefined) return refuse(methodRefused);
    if (call.body !== undefined && READ_METHODS.includes(method as HttpMethod)) {
      return refuse(`${method} sends no body`);
    }
    if (call.body !== undefined && new TextEncoder().encode(call.body).length > MAX_REQUEST_BODY) {
      return refuse(`the body is longer than ${MAX_REQUEST_BODY / 1024} KB`);
    }
    const ownHosts = caller.ownHosts ?? [];
    const checked = urlRefusal(call.url, policy, ownHosts);
    if (checked.kind === "refused") return refuse(checked.reason);
    const headerRefused = headerRefusal(call.headers ?? {}, policy);
    if (headerRefused !== undefined) return refuse(headerRefused);

    const decision = askDecision(policy.botAccess, call.intent, caller.facts);
    if (decision === "ask" && options.approved !== true) {
      return {
        kind: "ask",
        secretName: info.name,
        method,
        host: normalHost(checked.url.hostname),
        path: checked.url.pathname,
      };
    }
    const allowed: AuditDecision = decision === "ask" ? "approved" : "allowed";

    // Every check passed: only now is the value decrypted.
    let value: string;
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: row.iv,
          additionalData: itemAad(row.id, "bot", row.provider, row.key_version),
        },
        this.#dataKey.key,
        row.ciphertext,
      );
      const stored = new TextDecoder().decode(plain);
      value = provider === undefined ? stored : await this.#resolve(provider, stored);
    } catch {
      // Never the error text of a provider: it could hold what it resolved.
      return refuse(
        provider === undefined
          ? "the stored secret doesn't decrypt"
          : `${provider.label} couldn't resolve ${info.name}`,
      );
    }
    if (provider !== undefined && valueRefusal(value) !== undefined) {
      return refuse(`${provider.label} returned a value MiPi can't scrub safely`);
    }
    const pattern = scrubPattern(value);
    const result = await this.#send(call, method, checked.url, policy, ownHosts, value, (text) =>
      scrub(text, pattern, row.id),
    );
    switch (result.kind) {
      case "response":
        await audit(allowed, result.status, null);
        return result;
      case "failed":
        await audit(allowed, null, result.reason);
        return result;
      default: {
        const _: never = result;
        return result;
      }
    }
  }

  /** A provider's value for one call, within the request deadline: a provider that hangs refuses. */
  async #resolve(provider: VaultProviderRegistration, reference: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resolving = provider.resolve(reference, (input, init) =>
        this.#fetch(new Request(input, { ...init, signal: controller.signal })),
      );
      void resolving.catch(() => undefined);
      return await Promise.race([
        resolving,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error("timeout"));
            reject(new Error("timeout"));
          }, this.#timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Records the owner's no (or a timeout) to an asked call. */
  async recordDenied(
    call: SecretCall,
    caller: Pick<SecretCaller, "conversationId" | "tool">,
    reason: string,
  ): Promise<void> {
    const { host, path } = where(call.url);
    await this.#appendAudit({
      secretId: clipText(call.secretId, 64),
      conversationId: caller.conversationId,
      tool: clipText(caller.tool, 64),
      method: clipText(call.method.toUpperCase(), 16),
      host: clipText(host, 253),
      path: clipText(path, 512),
      decision: "denied",
      status: null,
      reason: clipText(reason, 300),
    });
  }

  async #send(
    call: SecretCall,
    method: string,
    first: URL,
    policy: SecretPolicy,
    ownHosts: readonly string[],
    value: string,
    clean: (text: string) => string,
  ): Promise<Extract<SecretFetchResult, { kind: "response" | "failed" }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.#timeoutMs);
    const failed = (reason: string) => ({ kind: "failed" as const, reason: clean(reason) });
    let url = first;
    try {
      for (let hop = 0; ; hop++) {
        const headers = new Headers(call.headers ?? {});
        if (!headers.has("User-Agent")) headers.set("User-Agent", `mipi/${MIPI_VERSION}`);
        // A function, so `$&`, `$$` and the like in a value are never read as replacement patterns.
        headers.set(
          policy.inject.header,
          policy.inject.template.replace("{}", () => value),
        );
        const response = await this.#fetch(
          new Request(url, {
            method,
            headers,
            redirect: "manual",
            signal: controller.signal,
            ...(call.body === undefined || hop > 0 ? {} : { body: call.body }),
          }),
        );
        const location = response.headers.get("Location");
        const redirect = response.status >= 300 && response.status < 400 && location !== null;
        // Only reads follow a redirect: a change is answered with the redirect itself.
        if (redirect && READ_METHODS.includes(method as HttpMethod)) {
          await response.body?.cancel().catch(() => undefined);
          if (hop >= MAX_REDIRECTS) return failed(`more than ${MAX_REDIRECTS} redirects`);
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            return failed("it redirects to an address that isn't a URL");
          }
          // `URL` drops tabs and newlines and trims spaces before it resolves dot segments: refused as written.
          const unsafe = addressRefusal(location);
          if (unsafe !== undefined) return failed(`it redirects to a refused address: ${unsafe}`);
          const rawPath = rawPathOf(location) ?? location.split(/[?#]/)[0]!;
          const rawRefused = rawPathRefusal(rawPath);
          if (rawRefused !== undefined)
            return failed(`it redirects to a refused path: ${rawRefused}`);
          if (normalHost(next.hostname) !== normalHost(url.hostname)) {
            return failed(
              `it redirects to ${normalHost(next.hostname)}; the secret was not sent there`,
            );
          }
          const checked = urlRefusal(next.toString(), policy, ownHosts);
          if (checked.kind === "refused")
            return failed(`it redirects where the secret can't go: ${checked.reason}`);
          url = checked.url;
          continue;
        }
        const { bytes, cut } = await readCapped(response, MAX_RAW_BYTES);
        const body = new TextDecoder().decode(bytes);
        const headersOut: [string, string][] = [];
        response.headers.forEach((headerValue, name) => {
          // A session cookie is a credential of its own: never shown to the model.
          if (name.toLowerCase() !== "set-cookie") headersOut.push([name, clean(headerValue)]);
        });
        return {
          kind: "response",
          url: clean(url.toString()),
          status: response.status,
          statusText: clean(response.statusText),
          headers: headersOut,
          body: clean(body),
          cut,
        };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return failed(`no full answer within ${Math.round(this.#timeoutMs / 1000)} seconds`);
      }
      return failed(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Audit ----

  #appendAudit(input: AuditInput): Promise<void> {
    const append = async () => {
      const last = this.#sql
        .exec<{ id: number; hash: string }>(
          `SELECT id, hash FROM ${VAULT_AUDIT_TABLE} ORDER BY id DESC LIMIT 1`,
        )
        .toArray()[0];
      const prevHash = last?.hash ?? AUDIT_GENESIS;
      const row = { ...input, id: (last?.id ?? 0) + 1, at: this.#now() };
      const hash = await auditHash(prevHash, row);
      this.#sql.exec(
        `INSERT INTO ${VAULT_AUDIT_TABLE}
           (id, at, secret_id, conversation_id, tool, method, host, path, decision, status, reason, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.at,
        row.secretId,
        row.conversationId,
        row.tool,
        row.method,
        row.host,
        row.path,
        row.decision,
        row.status,
        row.reason,
        prevHash,
        hash,
      );
    };
    const next = this.#auditTail.then(append, append);
    this.#auditTail = next.catch(() => undefined);
    return next;
  }

  /** The audit rows, oldest first, after `after` (an id). */
  readAudit({
    after = 0,
    limit = 100,
  }: { readonly after?: number; readonly limit?: number } = {}): AuditRow[] {
    if (!tableExists(this.#sql, VAULT_AUDIT_TABLE)) return [];
    return this.#sql
      .exec<{
        id: number;
        at: number;
        secret_id: string;
        conversation_id: number | null;
        tool: string;
        method: string;
        host: string;
        path: string;
        decision: string;
        status: number | null;
        reason: string | null;
        prev_hash: string;
        hash: string;
      }>(`SELECT * FROM ${VAULT_AUDIT_TABLE} WHERE id > ? ORDER BY id LIMIT ?`, after, limit)
      .toArray()
      .map((row) => ({
        id: row.id,
        at: row.at,
        secretId: row.secret_id,
        conversationId: row.conversation_id,
        tool: row.tool,
        method: row.method,
        host: row.host,
        path: row.path,
        decision: row.decision as AuditDecision,
        status: row.status,
        reason: row.reason,
        prevHash: row.prev_hash,
        hash: row.hash,
      }));
  }

  /**
   * Checks the whole chain: ids without a gap from 1, each row's previous hash the hash before it, each hash its own.
   * Returns the first row that doesn't hold. The audit is never trimmed; a later cap must keep a pruning anchor.
   */
  async verifyAudit(): Promise<
    { readonly ok: true; readonly rows: number } | { readonly ok: false; readonly at: number }
  > {
    let prevHash = AUDIT_GENESIS;
    let expected = 1;
    for (;;) {
      const page = this.readAudit({ after: expected - 1, limit: 500 });
      for (const row of page) {
        if (row.id !== expected || row.prevHash !== prevHash) return { ok: false, at: expected };
        if ((await auditHash(prevHash, row)) !== row.hash) return { ok: false, at: row.id };
        prevHash = row.hash;
        expected += 1;
      }
      if (page.length < 500) return { ok: true, rows: expected - 1 };
    }
  }
}

/** A stored bot row read back: the trust boundary for what an older or broken build wrote. */
function botInfo(
  row: ItemRow,
):
  | { readonly kind: "ok"; readonly info: BotSecretInfo }
  | { readonly kind: "bad"; readonly reason: string } {
  const bad = (reason: string) => ({ kind: "bad" as const, reason });
  if (row.name === null) return bad("it has no name");
  if (row.policy === null) return bad("it has no policy");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.policy);
  } catch {
    return bad("its policy isn't JSON");
  }
  const checked = checkPolicy(parsed);
  if (!checked.ok) return bad(`its policy is invalid: ${checked.reason}`);
  if (categoryRefusal(row.category) !== undefined) return bad("its category is personal only");
  const info: BotSecretInfo = {
    id: row.id,
    category: row.category,
    name: row.name,
    ...(row.hint === null ? {} : { hint: row.hint }),
    provider: row.provider,
    policy: checked.policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { kind: "ok", info };
}

async function importAesKey(
  raw: Uint8Array,
  usages: ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

/** The data key, unwrapped; undefined when the key or the AAD doesn't match. */
async function unwrapDataKey(
  kek: CryptoKey,
  stored: { readonly wrapped: ArrayBuffer; readonly iv: ArrayBuffer; readonly key_version: number },
): Promise<{ readonly key: CryptoKey; readonly raw: Uint8Array } | undefined> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: stored.iv, additionalData: dataKeyAad(stored.key_version) },
        kek,
        stored.wrapped,
      ),
    );
  } catch {
    return undefined;
  }
  if (raw.length !== 32) return undefined;
  return { key: await importAesKey(raw, ["encrypt", "decrypt"]), raw };
}

// ---- Who is calling ----

/**
 * The bot a conversation acts for: MiPi or a purpose bot is itself, a cobot is its bot (`meta.bot`). A chat from before
 * bots, a fork and a subagent act for none, so they match no grant.
 */
export async function resolveBotId(
  tx: Tx,
  conversationId: ConversationId,
): Promise<number | undefined> {
  const meta = await tx.doc(ConversationMeta, conversationId);
  switch (meta.kind) {
    case "main":
    case "bot":
      return conversationId;
    case "cobot":
      return meta.bot;
    case undefined:
      return undefined;
    default: {
      const _: never = meta.kind;
      return undefined;
    }
  }
}

/**
 * What the ask decision needs to know about the running turn: whether it read untrusted content, whether any input
 * has authority other than the owner's (or there is none), and whether any is automated. Read in the tool's commit.
 */
export async function askFacts(
  tx: Parameters<typeof runTouched>[0] & Tx,
  registry: Pick<RegistrySnapshot, "extension">,
  conversationId: ConversationId,
): Promise<AskFacts> {
  const inputs = await connectorsOf(registry).origins.runInputs(tx, conversationId);
  return {
    untrustedRun: await runTouched(tx, conversationId, untrustedToolNames(registry)),
    nonOwnerInput: inputs.length === 0 || inputs.some(({ authority }) => authority !== "owner"),
    automated: inputs.some(({ origin }) => origin.automated),
  };
}

// ---- Binding ----

/** The vault of the agent a registry belongs to (a tool's `api.registry`). Throws when it has none. */
export function vaultOf(registry: Pick<RegistrySnapshot, "extension">): Vault {
  const vault = boundVault(registry);
  if (!(vault instanceof Vault)) throw new Error("This agent has no vault");
  return vault;
}
