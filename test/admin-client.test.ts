import { describe, expect, it } from "vitest";
import { AdminError, adminClient, type Fetch, hasAgentToBackUp } from "../scripts/admin-client.ts";

const url = "https://mipi.example.workers.dev";

/** A Worker that answers every call with `status`, and accepts only `accepts` as a token when one is given. */
function worker(status: number, accepts?: string) {
  const seen: string[] = [];
  const fetcher: Fetch = async (_input, init) => {
    const token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
    seen.push(token);
    if (accepts !== undefined && token !== accepts) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return status === 200
      ? Response.json({ state: { kind: "open" } })
      : Response.json({ error: "x" }, { status });
  };
  return { fetcher, seen };
}

describe("deploy backup preflight", () => {
  it("backs up a Worker that answers", async () => {
    const { fetcher } = worker(200);
    expect(await hasAgentToBackUp(adminClient(url, ["token"], fetcher))).toBe(true);
  });

  it("skips the backup only when there is no agent yet (404)", async () => {
    const { fetcher } = worker(404);
    expect(await hasAgentToBackUp(adminClient(url, ["token"], fetcher))).toBe(false);
  });

  it.each([401, 403, 500, 503])("stops the deploy on HTTP %i", async (status) => {
    const { fetcher } = worker(status);
    await expect(hasAgentToBackUp(adminClient(url, ["token"], fetcher))).rejects.toThrow(
      `HTTP ${status}`,
    );
  });

  it("stops the deploy when the Worker can't be reached", async () => {
    const fetcher: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const failure = hasAgentToBackUp(adminClient(url, ["token"], fetcher));
    await expect(failure).rejects.toBeInstanceOf(AdminError);
    await expect(failure).rejects.toThrow("could not be reached");
  });

  it("tries ADMIN_TOKEN_PREVIOUS on a 401 while a token is rotated, then keeps it", async () => {
    const { fetcher, seen } = worker(200, "old");
    const call = adminClient(url, ["new", "old"], fetcher);
    expect(await hasAgentToBackUp(call)).toBe(true);
    await call("GET", "/api/admin/status");
    expect(seen).toEqual(["new", "old", "old"]);
  });

  it("names the token when every token is refused", async () => {
    const { fetcher } = worker(200, "neither");
    await expect(hasAgentToBackUp(adminClient(url, ["new", "old"], fetcher))).rejects.toThrow(
      /HTTP 401.*ADMIN_TOKEN/,
    );
  });

  it("refuses to run without a token", () => {
    expect(() => adminClient(url, ["", ""])).toThrow("ADMIN_TOKEN is not set");
  });
});
