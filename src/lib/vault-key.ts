/**
 * A lane's vault key (`MIPI_VAULT_KEY`, COD-255): 32 random bytes, base64. Shared by core, which wraps the lane's data
 * key with it, and the deploy script, which checks a lane's key before it deploys. Plain Web Crypto: runs in a Worker
 * and in Node.
 */

/** How many bytes a vault key is. */
export const VAULT_KEY_BYTES = 32;

/** What a binding holds: no key (empty or `off`), a value that isn't a key, or a key. */
export type VaultKeyValue =
  | { readonly kind: "unset" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "key"; readonly bytes: Uint8Array };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Bytes from standard base64; undefined when it isn't. */
export function fromBase64(text: string): Uint8Array | undefined {
  if (!BASE64.test(text) || text.length % 4 !== 0) return undefined;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reads a binding. Empty and `off` mean no key (the deploy writes `off` for an unset secret, since `--secrets-file`
 * only adds). Anything else must be exactly 32 bytes of standard base64, or it is refused, never used.
 */
export function parseVaultKey(value: string | undefined, name = "MIPI_VAULT_KEY"): VaultKeyValue {
  const text = (value ?? "").trim();
  if (text === "" || text.toLowerCase() === "off") return { kind: "unset" };
  const bytes = fromBase64(text);
  if (bytes === undefined) return { kind: "invalid", reason: `${name} is not base64` };
  if (bytes.length !== VAULT_KEY_BYTES) {
    return {
      kind: "invalid",
      reason: `${name} is ${bytes.length} bytes; it must be ${VAULT_KEY_BYTES}`,
    };
  }
  return { kind: "key", bytes };
}

const FINGERPRINT_LABEL = new TextEncoder().encode("mipi-vault-key-fingerprint:v1\0");

/**
 * A key's fingerprint: the first 16 bytes of SHA-256 over a fixed label and the key, as hex. Stored beside the wrapped
 * data key and shown in the admin status, so a wrong key is caught on open and before a deploy. A 256-bit random key
 * can't be found from it.
 */
export async function vaultKeyFingerprint(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(FINGERPRINT_LABEL.length + bytes.length);
  input.set(FINGERPRINT_LABEL, 0);
  input.set(bytes, FINGERPRINT_LABEL.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
