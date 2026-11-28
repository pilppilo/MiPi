/**
 * The deploy's vault check (COD-255): before `wrangler deploy` ships a lane's `MIPI_VAULT_KEY`, it reads the running
 * agent's admin status and refuses a deploy that would lock bot secrets: a lane with bot secrets but no key, a key
 * that matches neither the stored fingerprint nor (while rotating) `MIPI_VAULT_KEY_PREVIOUS`, or a key that isn't a
 * key. Kept apart from `deploy.ts` (which runs on import) so tests can call it.
 */
import { parseVaultKey, vaultKeyFingerprint } from "../src/lib/vault-key.ts";

/** What the admin status says about the vault; absent on a build from before it. */
export interface DeployedVault {
  readonly state?: string;
  readonly keyFingerprint?: string;
  readonly rows?: { readonly bot?: number };
}

export type VaultCheck =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly reason: string };

export async function vaultDeployCheck(
  vault: DeployedVault | undefined,
  keys: { readonly current: string | undefined; readonly previous: string | undefined },
): Promise<VaultCheck> {
  const current = parseVaultKey(keys.current, "MIPI_VAULT_KEY");
  const previous = parseVaultKey(keys.previous, "MIPI_VAULT_KEY_PREVIOUS");
  if (current.kind === "invalid") return { ok: false, reason: current.reason };
  if (previous.kind === "invalid") return { ok: false, reason: previous.reason };
  if (current.kind === "unset" && previous.kind === "key") {
    return { ok: false, reason: "MIPI_VAULT_KEY_PREVIOUS is set without MIPI_VAULT_KEY" };
  }
  if (vault === undefined) return { ok: true, message: "The running build has no vault yet." };
  const bot = vault.rows?.bot ?? 0;
  if (bot === 0) return { ok: true, message: "The lane has no bot secrets." };
  const count = `The lane has ${bot} bot secret${bot === 1 ? "" : "s"}`;
  if (current.kind === "unset") {
    return {
      ok: false,
      reason: `${count} but MIPI_VAULT_KEY is not set: deploying would lock them. Set it in the lane's GitHub Environment.`,
    };
  }
  const stored = vault.keyFingerprint;
  if (stored === undefined) {
    return { ok: false, reason: `${count} but no stored key fingerprint: check the admin status` };
  }
  if ((await vaultKeyFingerprint(current.bytes)) === stored) {
    return { ok: true, message: `${count}; MIPI_VAULT_KEY matches.` };
  }
  if (previous.kind === "key" && (await vaultKeyFingerprint(previous.bytes)) === stored) {
    return {
      ok: true,
      message: `${count}; MIPI_VAULT_KEY_PREVIOUS matches, so the agent rewraps the data key with the new key on open.`,
    };
  }
  return {
    ok: false,
    reason:
      `${count} and MIPI_VAULT_KEY doesn't match the key they were saved with: deploying would lock them. ` +
      "To rotate, put the old key in MIPI_VAULT_KEY_PREVIOUS for one deploy.",
  };
}
