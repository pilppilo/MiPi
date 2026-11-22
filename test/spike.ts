/** The spike token `vitest.config.ts` binds as `MIPI_SPIKE_TOKEN`. */
export const SPIKE_TOKEN = "test-spike-token";

/** A request that carries the spike token, as a script would (`Authorization: Bearer`). */
export function withSpikeToken(input: RequestInfo | URL, init?: RequestInit): Request {
  const request = new Request(input, init);
  request.headers.set("Authorization", `Bearer ${SPIKE_TOKEN}`);
  return request;
}
