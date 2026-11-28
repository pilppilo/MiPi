/**
 * The vault connector (COD-255): what composition, extensions and the Durable Object see of the vault, without its
 * storage or crypto (`vault.ts`), so modules that only compose an agent (and the scripts that import them) stay free
 * of Worker types. An extension registers vault providers here; the composition binds the agent's vault to its core
 * extension, where tools find it (`vaultOf` in `vault.ts`).
 *
 * Core code: it names no door, extension or provider.
 */
import type { Extension, RegistrySnapshot } from "./pi/durable.ts";
import type { FetchLike } from "./providers.ts";
import { CORE_EXTENSION_NAME } from "./untrusted.ts";

/** The built-in provider: the value is in the row itself. */
export const MIPI_PROVIDER = "mipi";

/**
 * Another store for bot secrets' values, as an extension registers it (`MipiExtension.vaultProviders`). It only
 * resolves a value: the policy, the ask and the audit stay in MiPi, so removing a provider changes nothing about
 * security. Values are never cached in storage.
 */
export interface VaultProviderRegistration {
  /** The id a row names in `provider`; never `mipi`. */
  readonly provider: string;
  /** How a refusal names it. */
  readonly label: string;
  /** The value for one request, from the reference the row holds. Throws with a short reason. */
  resolve(reference: string, fetcher: FetchLike): Promise<string>;
}

export type VaultProviders = ReadonlyMap<string, VaultProviderRegistration>;

/** The registered vault providers. One registered twice, or one named `mipi`, is a wiring mistake and throws. */
export function createVaultProviders(
  registrations: readonly {
    readonly owner: string;
    readonly registration: VaultProviderRegistration;
  }[],
): VaultProviders {
  const providers = new Map<string, VaultProviderRegistration>();
  const owners = new Map<string, string>();
  for (const { owner, registration } of registrations) {
    if (registration.provider === MIPI_PROVIDER) {
      throw new Error(
        `"${owner}" registers a vault provider named "${MIPI_PROVIDER}", which is built in`,
      );
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(registration.provider)) {
      throw new Error(
        `"${owner}" registers a vault provider with an invalid id "${registration.provider}"`,
      );
    }
    const other = owners.get(registration.provider);
    if (other !== undefined) {
      throw new Error(
        `Vault provider "${registration.provider}" is registered by both "${other}" and "${owner}"`,
      );
    }
    owners.set(registration.provider, owner);
    providers.set(registration.provider, registration);
  }
  return providers;
}

/** Whether bot secrets can be used, and why not. */
export type VaultLock =
  | { readonly state: "open" }
  | { readonly state: "locked"; readonly reason: string };

/** The vault as the admin status shows it: never a key, a value or a name. */
export interface VaultStatus {
  readonly state: VaultLock["state"];
  readonly reason?: string;
  /** The fingerprint of the lane key the data key is wrapped with: the deploy checks its key against it. */
  readonly keyFingerprint?: string;
  readonly rows: { readonly personal: number; readonly bot: number; readonly audit: number };
}

/** The lane's keys, as the Worker's bindings hold them. */
export interface VaultKeys {
  readonly current: string | undefined;
  readonly previous: string | undefined;
}

/** The vault as the Durable Object drives it: open with the lane's keys, report its status. */
export interface AgentVault {
  open(keys: VaultKeys): Promise<void>;
  status(): VaultStatus;
}

const bound = new WeakMap<Extension, AgentVault>();

/** Records the agent's vault on its core extension (`composeAgent`). */
export function bindVault(core: Extension, vault: AgentVault): void {
  bound.set(core, vault);
}

/** The vault bound to the agent a registry belongs to, if any. */
export function boundVault(registry: Pick<RegistrySnapshot, "extension">): AgentVault | undefined {
  const core = registry.extension(CORE_EXTENSION_NAME);
  return core === undefined ? undefined : bound.get(core);
}
