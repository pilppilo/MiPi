import { type SubmitEvent, useState } from "react";
import {
  BOT_ACCESS,
  HTTP_METHODS,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  type BotAccess,
  type BotSecretInfo,
  type BotSecretPatch,
  type ConversationSummary,
  type NewBotSecret,
  type SecretPolicy,
  type VaultProviderInfo,
} from "../protocol.ts";

const DEFAULT_POLICY: SecretPolicy = {
  botAccess: "none",
  bots: [],
  hosts: [],
  methods: ["GET"],
  inject: { header: "Authorization", template: "Bearer {}" },
};

export const accessLabel: Record<BotAccess, string> = {
  none: "No bot access",
  approve: "Ask for approval",
  auto: "Allow eligible reads",
};

const lines = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

function localDateTime(at: number | undefined): string {
  if (at === undefined) return "";
  const date = new Date(at);
  const local = new Date(at - date.getTimezoneOffset() * 60_000);
  return Number.isFinite(local.getTime())
    ? local
        .toISOString()
        .slice(0, -1)
        .replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")
        .replace(/:00$/, "")
    : "";
}

export function VaultSecretForm({
  item,
  providers,
  conversations,
  label,
  locked,
  create,
  update,
  close,
}: {
  readonly item?: BotSecretInfo;
  readonly providers: readonly VaultProviderInfo[];
  readonly conversations: readonly ConversationSummary[];
  readonly label: (conversation: ConversationSummary) => string;
  readonly locked: boolean;
  readonly create: (input: NewBotSecret) => Promise<void>;
  readonly update: (id: string, patch: BotSecretPatch) => Promise<void>;
  readonly close: () => void;
}) {
  const policy = item?.policy ?? DEFAULT_POLICY;
  const [replace, setReplace] = useState(false);
  const [provider, setProvider] = useState(item?.provider ?? providers[0]?.id ?? "mipi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const replacing = item === undefined || (replace && !locked);
  const builtIn = provider === "mipi";
  const eligible = conversations.filter(
    ({ kind, archivedAt, id }) =>
      (kind === "main" || kind === "bot") && (archivedAt === undefined || policy.bots.includes(id)),
  );
  const missingBots = policy.bots.filter((id) => !eligible.some((bot) => bot.id === id));

  const save = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || (locked && item === undefined)) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string): string => String(form.get(name) ?? "");
    const value = field("value");
    if (replacing && value.length < (builtIn ? MIN_SECRET_LENGTH : 1)) {
      setError(
        builtIn ? `Enter at least ${MIN_SECRET_LENGTH} characters.` : "Enter a provider reference.",
      );
      return;
    }
    const botAccess = BOT_ACCESS.find((access) => access === field("botAccess")) ?? "none";
    const methods = HTTP_METHODS.filter((method) => form.getAll("methods").includes(method));
    const hosts = lines(field("hosts"));
    if (hosts.length === 0 || methods.length === 0) {
      setError("Enter at least one host and select at least one method.");
      return;
    }
    const template = field("template");
    if (template.split("{}").length !== 2) {
      setError("Use {} exactly once in the header template.");
      return;
    }
    const port = field("port");
    const paths = lines(field("paths"));
    const expiry = field("expiresAt");
    const expiresAt =
      expiry === localDateTime(policy.expiresAt)
        ? policy.expiresAt
        : expiry === ""
          ? undefined
          : new Date(expiry).getTime();
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
      setError("Enter a valid expiry.");
      return;
    }
    const change = {
      category: field("category").trim(),
      name: field("name").trim(),
      hint: field("hint").trim() || null,
      policy: {
        botAccess,
        bots: form.getAll("bots").map(Number),
        hosts,
        methods,
        inject: { header: field("header").trim(), template },
        ...(port === "" ? {} : { port: Number(port) }),
        ...(paths.length === 0 ? {} : { paths }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    };
    setBusy(true);
    setError(undefined);
    try {
      if (item === undefined) await create({ ...change, provider, value });
      else await update(item.id, { ...change, ...(replacing ? { provider, value } : {}) });
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the secret.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="vault-card vault-form"
      aria-label={item === undefined ? "Add secret" : `Edit ${item.name}`}
      onSubmit={save}
    >
      <h3>{item === undefined ? "Add bot secret" : `Edit ${item.name}`}</h3>
      <fieldset className="vault-fields" disabled={busy}>
        <div className="vault-field-grid">
          <label>
            Name
            <input name="name" defaultValue={item?.name} maxLength={80} required />
          </label>
          <label>
            Category
            <input
              name="category"
              defaultValue={item?.category ?? "token"}
              pattern="[a-z][a-z0-9\x2d]{0,31}"
              maxLength={32}
              required
            />
          </label>
        </div>
        <label>
          Hint <span className="vault-muted">(optional)</span>
          <input name="hint" defaultValue={item?.hint} maxLength={120} />
        </label>
        {item === undefined ? null : (
          <label className="vault-check">
            <input
              type="checkbox"
              checked={replace && !locked}
              disabled={locked}
              onChange={(event) => {
                setReplace(event.currentTarget.checked);
                if (!event.currentTarget.checked) setProvider(item.provider);
              }}
            />
            Replace value
          </label>
        )}
        {replacing ? (
          <>
            {providers.length < 2 && builtIn ? null : (
              <label>
                Provider
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.currentTarget.value)}
                >
                  {providers.some(({ id }) => id === provider) ? null : (
                    <option value={provider} disabled>
                      {provider} (unavailable)
                    </option>
                  )}
                  {providers.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {builtIn ? "Secret value" : "Provider reference"}
              <input
                key={provider}
                name="value"
                type="password"
                autoComplete="off"
                spellCheck={false}
                minLength={builtIn ? MIN_SECRET_LENGTH : 1}
                maxLength={MAX_SECRET_LENGTH}
                required
              />
            </label>
          </>
        ) : null}
        <label>
          Bot access
          <select name="botAccess" defaultValue={policy.botAccess}>
            {BOT_ACCESS.map((access) => (
              <option key={access} value={access}>
                {accessLabel[access]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="vault-choices">
          <legend>Granted bots</legend>
          {eligible.length === 0 && missingBots.length === 0 ? (
            <p className="vault-muted">No bots available.</p>
          ) : null}
          {eligible.map((bot) => (
            <label key={bot.id} className="vault-check">
              <input
                type="checkbox"
                name="bots"
                value={bot.id}
                defaultChecked={policy.bots.includes(bot.id)}
              />
              {label(bot)}
              {bot.archivedAt === undefined ? "" : " (archived)"}
            </label>
          ))}
          {missingBots.map((id) => (
            <label key={id} className="vault-check">
              <input type="checkbox" name="bots" value={id} defaultChecked />#{id} (unavailable)
            </label>
          ))}
        </fieldset>
        <div className="vault-field-grid">
          <label>
            Hosts <span className="vault-muted">(comma or line separated)</span>
            <textarea name="hosts" rows={2} defaultValue={policy.hosts.join("\n")} required />
          </label>
          <label>
            Port <span className="vault-muted">(optional)</span>
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              placeholder="443"
              defaultValue={policy.port}
            />
          </label>
        </div>
        <fieldset className="vault-choices">
          <legend>HTTP methods</legend>
          {HTTP_METHODS.map((method) => (
            <label key={method} className="vault-check">
              <input
                type="checkbox"
                name="methods"
                value={method}
                defaultChecked={policy.methods.includes(method)}
              />
              {method}
            </label>
          ))}
        </fieldset>
        <label>
          Path prefixes <span className="vault-muted">(optional, comma or line separated)</span>
          <textarea name="paths" rows={2} defaultValue={policy.paths?.join("\n")} />
        </label>
        <div className="vault-field-grid">
          <label>
            Header
            <input name="header" defaultValue={policy.inject.header} required />
          </label>
          <label>
            Header template
            <input name="template" defaultValue={policy.inject.template} required />
          </label>
        </div>
        <label>
          Expires <span className="vault-muted">(optional, local time)</span>
          <input
            name="expiresAt"
            type="datetime-local"
            step="0.001"
            defaultValue={localDateTime(policy.expiresAt)}
          />
        </label>
      </fieldset>
      {error === undefined ? null : (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
      <div className="vault-actions">
        <button
          className="primary-button"
          type="submit"
          disabled={busy || (locked && item === undefined)}
        >
          {busy ? "Saving…" : "Save secret"}
        </button>
        <button className="pill-button" type="button" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
