import type {
  BotSecretPatch,
  NewBotSecret,
  VaultAudit,
  VaultItem,
  VaultList,
} from "../protocol.ts";

const ITEMS = "/api/vault/items";
const itemPath = (id: string) => `${ITEMS}/${encodeURIComponent(id)}`;

async function request<T>(
  path: string,
  {
    method = "GET",
    body,
    signal,
  }: {
    method?: string;
    body?: BotSecretPatch;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal: signal ?? null,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    throw new Error(
      failure !== null &&
        typeof failure === "object" &&
        "error" in failure &&
        typeof failure.error === "string"
        ? failure.error
        : `Vault request failed (${response.status}).`,
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const vaultApi = {
  list: (signal?: AbortSignal) => request<VaultList>(ITEMS, { signal }),
  create: (body: NewBotSecret) => request<VaultItem>(ITEMS, { method: "POST", body }),
  update: (id: string, body: BotSecretPatch) =>
    request<VaultItem>(itemPath(id), { method: "PATCH", body }),
  remove: (id: string) => request<void>(itemPath(id), { method: "DELETE" }),
  audit: (id: string, limit: number, before?: number, signal?: AbortSignal) =>
    request<VaultAudit>(
      `${itemPath(id)}/audit?limit=${limit}${before === undefined ? "" : `&before=${before}`}`,
      { signal },
    ),
};
