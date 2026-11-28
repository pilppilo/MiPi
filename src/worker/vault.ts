import type { MipiAgent } from "../agent/agent-do.ts";
import { logRefusedRequest } from "../agent/diag.ts";
import {
  MAX_SECRET_AUDIT_ROWS,
  SECRET_ID,
  type BotSecretPatch,
  type NewBotSecret,
  type SecretAuditQuery,
} from "../protocol.ts";
import type { VaultResult } from "../lib/vault.ts";
import { isSameOriginBrowserRequest } from "./auth.ts";
import { readBounded } from "./body.ts";

const ROOT = "/api/vault";
const ITEMS = ROOT + "/items";
const ITEM_PATH = /^\/api\/vault\/items\/([^/]+)(\/audit)?$/;
const BODY_LIMIT = 32 * 1024;
const JSON_METHODS = new Set(["POST", "PUT", "PATCH"]);
const FAILURE_STATUS = { invalid: 400, missing: 404, locked: 409, unavailable: 503 } as const;

export const isVaultPath = (path: string): boolean => path === ROOT || path.startsWith(ROOT + "/");

export function withVaultHeaders(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.append("Vary", "Origin, Sec-Fetch-Site");
  return response;
}

const error = (message: string, status: number, headers?: HeadersInit): Response =>
  Response.json({ error: message }, { status, headers });

function result<T>(reply: VaultResult<T>, status = 200): Response {
  if (!reply.ok) return error(reply.reason, FAILURE_STATUS[reply.kind]);
  return status === 204 ? new Response(null, { status }) : Response.json(reply.data, { status });
}

const methodNotAllowed = (allow: string): Response =>
  error("Method not allowed", 405, { Allow: allow });

function auditQuery(params: URLSearchParams): SecretAuditQuery | undefined {
  const query: { before?: number; limit?: number } = {};
  for (const [name, value] of params) {
    if (name !== "before" && name !== "limit") return undefined;
    if (query[name] !== undefined || !/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    const max = name === "limit" ? MAX_SECRET_AUDIT_ROWS : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(number) || number < (name === "limit" ? 1 : 0) || number > max) {
      return undefined;
    }
    query[name] = number;
  }
  return query;
}

const TEXT_FIELDS = new Set(["category", "name", "value", "provider"]);

function secretPatch(input: unknown): BotSecretPatch | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  for (const [name, value] of entries) {
    if (name === "policy") continue;
    if (name === "hint" && value === null) continue;
    if (!(name === "hint" || TEXT_FIELDS.has(name)) || typeof value !== "string") return undefined;
  }
  return input as BotSecretPatch;
}

function newSecret(input: BotSecretPatch): input is NewBotSecret {
  return (
    input.category !== undefined &&
    input.name !== undefined &&
    input.value !== undefined &&
    input.policy !== undefined
  );
}

export async function handleVault(
  request: Request,
  url: URL,
  agent: () => DurableObjectStub<MipiAgent>,
): Promise<Response> {
  const method = request.method;
  const hasBody = JSON_METHODS.has(method);
  if ((hasBody || method === "DELETE") && !isSameOriginBrowserRequest(request)) {
    logRefusedRequest("vault.csrf", request, 403, "Cross-origin vault mutation refused");
    return error("Cross-origin vault mutation refused", 403);
  }

  try {
    let patch: BotSecretPatch | undefined;
    if (hasBody) {
      const type = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== "application/json") return error("Expected application/json", 415);
      const bytes = await readBounded(request, BODY_LIMIT);
      if (bytes === undefined) return error("Vault request is too large", 413);
      let input: unknown;
      try {
        input = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
        );
      } catch {
        return error("Expected a JSON body", 400);
      }
      patch = secretPatch(input);
      if (patch === undefined) return error("Invalid bot secret fields", 400);
    }

    if (url.pathname === ITEMS) {
      if (method === "GET") return result(await agent().vaultListBotSecrets());
      if (method === "POST" && patch !== undefined) {
        return newSecret(patch)
          ? result(await agent().vaultCreateBotSecret(patch), 201)
          : error("Category, name, policy and value are required", 400);
      }
      return methodNotAllowed("GET, POST");
    }

    const match = ITEM_PATH.exec(url.pathname);
    const id = match?.[1];
    if (id === undefined) return error("Not found", 404);
    if (!SECRET_ID.test(id)) return error("Invalid secret ID", 400);
    if (match?.[2] !== undefined) {
      if (method !== "GET") return methodNotAllowed("GET");
      const query = auditQuery(url.searchParams);
      return query === undefined
        ? error("Invalid audit query", 400)
        : result(await agent().vaultReadAudit(id, query));
    }
    if (method === "DELETE") return result(await agent().vaultDeleteBotSecret(id), 204);
    if (method === "PATCH" && patch !== undefined) {
      return result(await agent().vaultUpdateBotSecret(id, patch));
    }
    return methodNotAllowed("PATCH, DELETE");
  } catch {
    // Runtime errors here may originate on a path that received a value.
    return error("The agent's vault is unavailable", 503);
  }
}
