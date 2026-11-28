/**
 * Outbound requests (COD-255): the rules every request MiPi sends for the model shares, whichever part sends it.
 * `web_fetch` reads public pages by them, and the vault's `fetchWithSecret` sends a bot secret by them. Moved here from
 * `web_fetch` unchanged, so both refuse the same hosts and keep the same limits.
 *
 * Core code: it names no extension.
 */
import { normalHost } from "./settings.ts";

/** At most this many redirects are followed, each one checked again. */
export const MAX_REDIRECTS = 3;
/** One deadline for every hop and the body. */
export const FETCH_TIMEOUT_MS = 10_000;
/** The most of a response body read; past it the rest is cancelled and the response is marked cut. */
export const MAX_RAW_BYTES = 1024 * 1024;

/** Host names that only mean something on a local network, or to the machine itself. */
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "home.arpa", "lan", "intranet"];

/**
 * Why a URL may not be fetched, or undefined when it may. `ownHosts` are the hostnames MiPi itself answers on: fetching
 * them would show a page its own Access login or open routes.
 */
export function refusedUrl(url: URL, ownHosts: readonly string[] = []): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "only http and https URLs can be fetched";
  }
  if (url.username !== "" || url.password !== "")
    return "URLs with a username or password are refused";
  // `URL` lowercases the host and normalizes IPv4 written in hex, octal or as one number to dotted decimal.
  const host = normalHost(url.hostname);
  if (host.startsWith("[") || host.includes(":"))
    return "IP addresses are refused; use a host name";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "IP addresses are refused; use a host name";
  if (!host.includes(".")) return "single-label and local host names are refused";
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return "local and internal host names are refused";
  }
  if (ownHosts.some((own) => normalHost(own) === host)) return "MiPi doesn't fetch its own address";
  return undefined;
}

/** A response body, read up to `limit` bytes; the rest is cancelled. */
export async function readCapped(
  response: Response,
  limit: number,
): Promise<{ readonly bytes: Uint8Array; readonly cut: boolean }> {
  if (response.body === null) return { bytes: new Uint8Array(), cut: false };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      // More than the limit: keep what fits, and stop the download.
      parts.push(value.subarray(0, limit - size));
      size = limit;
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    parts.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, cut };
}
