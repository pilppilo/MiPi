/**
 * A bot secret's policy and the checks a request passes before its secret is decrypted (COD-255). Pure functions: the
 * vault (`vault.ts`) reads the stored policy, and these say whether a request may go.
 *
 * Core code: it names no door, extension or provider.
 */
import { normalHost } from "./settings.ts";
import { refusedUrl } from "./outbound.ts";

/** Who may use a bot secret without asking: nobody, each use asked, or reads allowed. */
export const BOT_ACCESS = ["none", "approve", "auto"] as const;
export type BotAccess = (typeof BOT_ACCESS)[number];

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that only read: the ones `auto` may allow, and the only ones that follow a redirect. */
export const READ_METHODS: readonly HttpMethod[] = ["GET", "HEAD"];

/** Categories that are personal only, in code: there is no policy that lets the assistant use them. */
export const PERSONAL_ONLY_CATEGORIES = ["payment", "login", "contact"] as const;

/** A bot secret's category: lowercase letters, digits and dashes, never a personal-only one. */
const CATEGORY = /^[a-z][a-z0-9-]{0,31}$/;

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

/** Headers the model may never set: the secret's own header is refused besides these. */
export const FORBIDDEN_HEADERS = [
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
] as const;

/** Headers a policy may not inject into: they mean something to the connection, not the API. */
const UNINJECTABLE = new Set<string>([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOST_LABELS = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Why a category can't hold a bot secret, or undefined. */
export function categoryRefusal(category: string): string | undefined {
  if ((PERSONAL_ONLY_CATEGORIES as readonly string[]).includes(category)) {
    return `"${category}" items are personal only; the assistant can never use them`;
  }
  if (!CATEGORY.test(category)) {
    return "a category is 1–32 lowercase letters, digits and dashes, starting with a letter";
  }
  return undefined;
}

/** Why a value can't be saved, or undefined. */
export function valueRefusal(value: string): string | undefined {
  if (value.length < MIN_SECRET_LENGTH) {
    return `a secret is at least ${MIN_SECRET_LENGTH} characters, so scrubbing it never changes ordinary text`;
  }
  if (value.length > MAX_SECRET_LENGTH)
    return `a secret is at most ${MAX_SECRET_LENGTH} characters`;
  if (/[\r\n\0]/.test(value)) return "a secret can't contain line breaks or NUL";
  return undefined;
}

/** Why a path prefix is refused, or undefined. */
function pathPrefixRefusal(prefix: string): string | undefined {
  if (!prefix.startsWith("/")) return `path "${prefix}" must start with /`;
  const raw = rawPathRefusal(prefix);
  if (raw !== undefined) return `path "${prefix}": ${raw}`;
  if (/[?#]/.test(prefix)) return `path "${prefix}" can't hold a query or fragment`;
  return undefined;
}

/**
 * The policy as given, checked (a save from the Vault space, a stored row read back). Returns the reason it's refused,
 * or the policy with hosts normalized and lists deduplicated.
 */
export function checkPolicy(
  input: unknown,
):
  | { readonly ok: true; readonly policy: SecretPolicy }
  | { readonly ok: false; readonly reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refuse("the policy isn't an object");
  }
  const value = input as Record<string, unknown>;
  const botAccess = value.botAccess;
  if (typeof botAccess !== "string" || !(BOT_ACCESS as readonly string[]).includes(botAccess)) {
    return refuse(`botAccess must be one of ${BOT_ACCESS.join(", ")}`);
  }
  const bots = value.bots;
  if (!Array.isArray(bots) || !bots.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return refuse("bots must be a list of conversation ids");
  }
  const hostsIn = value.hosts;
  if (!Array.isArray(hostsIn) || hostsIn.length === 0) {
    return refuse("a bot secret names at least one host");
  }
  const hosts: string[] = [];
  for (const host of hostsIn) {
    if (typeof host !== "string") return refuse("hosts must be host names");
    const normal = normalHost(host.trim());
    if (!HOST_LABELS.test(normal)) return refuse(`"${host}" isn't a host name`);
    const refused = refusedUrl(new URL(`https://${normal}/`));
    if (refused !== undefined) return refuse(`"${host}": ${refused}`);
    if (!hosts.includes(normal)) hosts.push(normal);
  }
  const port = value.port;
  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)
  ) {
    return refuse("port must be 1–65535");
  }
  const methodsIn = value.methods;
  if (!Array.isArray(methodsIn) || methodsIn.length === 0) {
    return refuse("a bot secret names at least one method");
  }
  const methods: HttpMethod[] = [];
  for (const method of methodsIn) {
    if (typeof method !== "string" || !(HTTP_METHODS as readonly string[]).includes(method)) {
      return refuse(`methods must be among ${HTTP_METHODS.join(", ")}`);
    }
    if (!methods.includes(method as HttpMethod)) methods.push(method as HttpMethod);
  }
  let paths: string[] | undefined;
  if (value.paths !== undefined) {
    if (!Array.isArray(value.paths) || value.paths.length === 0) {
      return refuse("paths, when given, is a non-empty list");
    }
    paths = [];
    for (const path of value.paths) {
      if (typeof path !== "string") return refuse("paths must be strings");
      const refused = pathPrefixRefusal(path);
      if (refused !== undefined) return refuse(refused);
      // A trailing slash adds nothing: matching is on whole segments.
      const trimmed = path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
      if (!paths.includes(trimmed)) paths.push(trimmed);
    }
  }
  const inject = value.inject;
  if (typeof inject !== "object" || inject === null)
    return refuse("inject names a header and a template");
  const { header, template } = inject as Record<string, unknown>;
  if (typeof header !== "string" || !HEADER_NAME.test(header)) {
    return refuse("inject.header must be a header name");
  }
  if (UNINJECTABLE.has(header.toLowerCase())) return refuse(`the value can't go in ${header}`);
  if (typeof template !== "string" || template.split("{}").length !== 2) {
    return refuse("inject.template holds {} exactly once, where the value goes");
  }
  if (/[\r\n\0]/.test(template)) return refuse("inject.template can't contain line breaks");
  const expiresAt = value.expiresAt;
  if (expiresAt !== undefined && !Number.isSafeInteger(expiresAt)) {
    return refuse("expiresAt must be a time in milliseconds");
  }
  return {
    ok: true,
    policy: {
      botAccess: botAccess as BotAccess,
      bots: [...new Set(bots as number[])],
      hosts,
      ...(port === undefined || port === 443 ? {} : { port: port as number }),
      methods,
      ...(paths === undefined ? {} : { paths }),
      inject: { header, template },
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
    },
  };
}

/** The path part of a URL as written, before `URL` normalizes it: from after the authority to `?` or `#`. */
export function rawPathOf(address: string): string | undefined {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/.exec(address)?.[1];
}

/**
 * Why an address as written is refused before anything parses it: ASCII control characters (tabs, newlines) or
 * spaces anywhere. `URL` drops tabs and newlines and trims spaces before it resolves dot segments, so `/a/.\t./b`
 * would pass a check on the raw path and still come out as `/b`. Spaces in a path are sent as `%20`.
 */
export function addressRefusal(address: string): string | undefined {
  for (let index = 0; index < address.length; index += 1) {
    const code = address.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return "control characters and spaces are refused";
  }
  return undefined;
}

/** Why a path as written is refused: a `..` or `.` segment, a backslash, or an encoded separator or dot. */
export function rawPathRefusal(path: string): string | undefined {
  const unsafe = addressRefusal(path);
  if (unsafe !== undefined) return unsafe;
  if (/%(2f|5c|2e)/i.test(path)) return "encoded separators and dots are refused";
  if (path.includes("\\")) return "backslashes are refused";
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    return "dot segments are refused";
  }
  return undefined;
}

/** Whether `path` is `prefix` or under it, on whole segments: `/a/b` matches `/a/b/c`, never `/a/bc`. */
export function pathMatches(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** What a call asks for: a read (`secret_get`) or a change (`secret_request`). */
export type SecretIntent = "read" | "change";

/**
 * Why a URL is refused for this policy, on the first request and on every redirect hop: https only, the policy's port,
 * the core URL rules, a listed host, and a listed path on whole segments. The raw path is checked as written and again
 * after parsing.
 */
export function urlRefusal(
  address: string,
  policy: SecretPolicy,
  ownHosts: readonly string[],
):
  | { readonly kind: "ok"; readonly url: URL }
  | { readonly kind: "refused"; readonly reason: string } {
  const refuse = (reason: string) => ({ kind: "refused" as const, reason });
  const unsafe = addressRefusal(address);
  if (unsafe !== undefined) return refuse(unsafe);
  const raw = rawPathOf(address);
  if (raw === undefined) return refuse("that is not a full https URL");
  const rawRefused = rawPathRefusal(raw);
  if (rawRefused !== undefined) return refuse(rawRefused);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return refuse("that is not a URL");
  }
  if (url.protocol !== "https:") return refuse("only https is allowed with a secret");
  const refused = refusedUrl(url, ownHosts);
  if (refused !== undefined) return refuse(refused);
  const parsedRefused = rawPathRefusal(url.pathname);
  if (parsedRefused !== undefined) return refuse(parsedRefused);
  const host = normalHost(url.hostname);
  if (!policy.hosts.includes(host)) return refuse(`${host} is not a host this secret is for`);
  const port = url.port === "" ? 443 : Number(url.port);
  if (port !== (policy.port ?? 443)) return refuse(`port ${port} is not allowed for this secret`);
  if (
    policy.paths !== undefined &&
    !policy.paths.some((prefix) => pathMatches(url.pathname, prefix))
  ) {
    return refuse(`${url.pathname} is not a path this secret is for`);
  }
  return { kind: "ok", url };
}

/** Why a method is refused for this policy and intent. */
export function methodRefusal(
  method: string,
  intent: SecretIntent,
  policy: SecretPolicy,
): string | undefined {
  if (!(HTTP_METHODS as readonly string[]).includes(method))
    return `${method} is not a method MiPi sends`;
  const reads = READ_METHODS.includes(method as HttpMethod);
  if (intent === "read" && !reads)
    return `${method} changes data; use the request tool, which asks first`;
  if (intent === "change" && reads) return `${method} only reads; use the read tool`;
  if (!policy.methods.includes(method as HttpMethod))
    return `${method} is not allowed for this secret`;
  return undefined;
}

/** Why the caller's headers are refused: one the model may never set, the secret's own, or a malformed one. */
export function headerRefusal(
  headers: Readonly<Record<string, string>>,
  policy: SecretPolicy,
): string | undefined {
  const own = policy.inject.header.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) return `"${name}" is not a header name`;
    const lower = name.toLowerCase();
    if ((FORBIDDEN_HEADERS as readonly string[]).includes(lower) || lower === own) {
      return `the ${name} header can't be set`;
    }
    if (/[\r\n\0]/.test(value)) return `the ${name} header can't contain line breaks`;
  }
  return undefined;
}

/** The facts the ask decision reads about the running turn (`askFacts` in `vault.ts`). */
export type AskFacts = {
  /** The run called a tool whose output is untrusted (a fetched page). */
  readonly untrustedRun: boolean;
  /** An input of the turn has authority other than `owner` (the relay, a bot hop), or there is none. */
  readonly nonOwnerInput: boolean;
  /** An input of the turn is automated (a reminder). */
  readonly automated: boolean;
};

/**
 * Whether a call that passed every check may go now or must ask the owner. A change always asks. A read asks under
 * `approve`, and under `auto` too when the run read untrusted content, answers a non-owner input, or is automated.
 * `none` never gets here: it is refused before.
 */
export function askDecision(
  botAccess: Exclude<BotAccess, "none">,
  intent: SecretIntent,
  facts: AskFacts,
): "allow" | "ask" {
  if (intent === "change") return "ask";
  switch (botAccess) {
    case "approve":
      return "ask";
    case "auto":
      return facts.untrustedRun || facts.nonOwnerInput || facts.automated ? "ask" : "allow";
    default: {
      const _: never = botAccess;
      return "ask";
    }
  }
}
