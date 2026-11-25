/**
 * The deploy scripts' client for a deployed Worker's admin API. Kept apart from `deploy.ts` (which runs on import) so
 * tests can drive it with a fake `fetch`.
 */

export class AdminError extends Error {
  /** The HTTP status, or undefined when the Worker couldn't be reached. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
export type AdminCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** A Cloudflare Access service token: its headers get a request through Access to the admin routes. */
export interface ServiceToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The deployed lane's credentials, shared by deploy and heartbeat. */
export function adminClientFromEnv(url: string, env: NodeJS.ProcessEnv): AdminCall {
  const { CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret } = env;
  return adminClient(
    url,
    [env.ADMIN_TOKEN ?? "", env.ADMIN_TOKEN_PREVIOUS ?? ""],
    fetch,
    clientId && clientSecret ? { clientId, clientSecret } : undefined,
  );
}

/**
 * Calls the admin API with the first token, and on a 401 tries the next ones in order (`ADMIN_TOKEN`, then
 * `ADMIN_TOKEN_PREVIOUS` while a lane's token is being rotated: the running Worker still has the old one). The first
 * token that works is kept for later calls. With Access on, the service token's headers go with every call: Access
 * lets the request through and the Worker checks the JWT Access adds; a Worker from before Access checks the bearer.
 */
export function adminClient(
  url: string,
  tokens: readonly string[],
  fetcher: Fetch = fetch,
  service?: ServiceToken,
): AdminCall {
  const usable = tokens.filter((token) => token.length > 0);
  if (usable.length === 0 && service === undefined) {
    throw new AdminError("Neither ADMIN_TOKEN nor the Access service token is set");
  }
  const accessHeaders: Record<string, string> =
    service === undefined
      ? {}
      : {
          "CF-Access-Client-Id": service.clientId,
          "CF-Access-Client-Secret": service.clientSecret,
        };
  let current = 0;
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    for (;;) {
      let response: Response;
      try {
        response = await fetcher(new URL(path, url), {
          method,
          headers: {
            ...accessHeaders,
            ...(usable[current] === undefined
              ? {}
              : { Authorization: `Bearer ${usable[current]}` }),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new AdminError(
          `${method} ${path}: ${url} could not be reached (${(error as Error).message})`,
        );
      }
      if (response.status === 401 && current + 1 < usable.length) {
        await response.body?.cancel();
        current += 1;
        continue;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 200) };
      }
      if (!response.ok) {
        const hint =
          response.status === 401 || response.status === 403
            ? " (check this lane's ADMIN_TOKEN, or its Access service token and ACCESS_SERVICE_CLIENT_ID; while rotating ADMIN_TOKEN, set ADMIN_TOKEN_PREVIOUS to the old one)"
            : "";
        throw new AdminError(
          `${method} ${path}: HTTP ${response.status} ${(parsed as { error?: string }).error ?? ""}${hint}`,
          response.status,
        );
      }
      return parsed as T;
    }
  };
}

/**
 * Whether there is an agent to back up. Only a 404 means there isn't (a first deploy: no Worker, or one without the
 * admin API). Anything else that fails, such as a wrong token, a 5xx or no answer, throws: a deploy must not go ahead
 * without the backup it was supposed to take.
 */
export async function hasAgentToBackUp(call: AdminCall): Promise<boolean> {
  try {
    await call("GET", "/api/admin/status");
    return true;
  } catch (error) {
    if (error instanceof AdminError && error.status === 404) return false;
    throw error;
  }
}
