/** Who may use a bot secret without asking: nobody, each use asked, or reads allowed. */
export const BOT_ACCESS = ["none", "approve", "auto"] as const;
export type BotAccess = (typeof BOT_ACCESS)[number];

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Saving refuses a shorter value, so scrubbing it can never mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8;
/** A value longer than this isn't a key or a token. */
export const MAX_SECRET_LENGTH = 8192;

/** Where the value goes: a header, with `{}` standing for the value. Never the URL. */
export type SecretInjection = { readonly header: string; readonly template: string };

export type SecretPolicy = {
  readonly botAccess: BotAccess;
  /** The conversation ids of the bots that may use it (MiPi, purpose bots). Ids, never names. */
  readonly bots: readonly number[];
  /** Exact hostnames, normalized like `normalHost`. */
  readonly hosts: readonly string[];
  /** The one port, when not 443. */
  readonly port?: number;
  readonly methods: readonly HttpMethod[];
  /** Path prefixes matched on whole segments; absent: every path. */
  readonly paths?: readonly string[];
  readonly inject: SecretInjection;
  /** Refused from this time (ms since the epoch). */
  readonly expiresAt?: number;
};

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
  readonly lastUsedAt?: number;
}

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

/** Whether bot secrets can be used, and why not. */
export type VaultLock =
  | { readonly state: "open" }
  | { readonly state: "locked"; readonly reason: string };

export const SECRET_ID = /^sec_[0-9a-f]{24}$/;
export const MAX_SECRET_AUDIT_ROWS = 200;

export interface VaultProviderInfo {
  readonly id: string;
  readonly label: string;
}

export interface VaultList {
  readonly status: VaultLock;
  readonly providers: readonly VaultProviderInfo[];
  readonly items: readonly BotSecretInfo[];
}

export interface VaultItem {
  readonly item: BotSecretInfo;
}

export interface VaultAudit {
  readonly rows: readonly AuditRow[];
}

/** A checked request shape. The core validates metadata and policy before writing. */
export interface NewBotSecret {
  readonly category: string;
  readonly name: string;
  readonly hint?: string | null;
  readonly policy: unknown;
  readonly value: string;
  readonly provider?: string;
}

export type BotSecretPatch = Partial<NewBotSecret>;

export interface SecretAuditQuery {
  readonly before?: number;
  readonly limit?: number;
}

export type VaultResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "missing" | "locked" | "unavailable";
      readonly reason: string;
    };
