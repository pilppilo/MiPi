import { useEffect, useState } from "react";
import type {
  AuditRow,
  BotSecretInfo,
  ConversationSummary,
  VaultItem,
  VaultList,
} from "../protocol.ts";
import { toBase64, VAULT_KEY_BYTES } from "../lib/vault-key.ts";
import { toolName } from "./names.ts";
import { vaultApi } from "./vault-api.ts";
import { accessLabel, VaultSecretForm } from "./VaultSecretForm.tsx";

const AUDIT_PAGE_SIZE = 25;
const dateText = (at: number) => new Date(at).toLocaleString();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Vault request failed.";

type BotNames = {
  readonly conversations: readonly ConversationSummary[];
  readonly label: (conversation: ConversationSummary) => string;
};

function botName(id: number, { conversations, label }: BotNames, showArchived = false): string {
  const bot = conversations.find((conversation) => conversation.id === id);
  if (bot === undefined) return `#${id}`;
  return label(bot) + (showArchived && bot.archivedAt !== undefined ? " (archived)" : "");
}

/** Generated on demand in this tab and cleared when the panel is dismissed or unmounted. */
export function makeLaneKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES));
  const key = toBase64(bytes);
  bytes.fill(0);
  return key;
}

function LaneKey({ value, close }: { readonly value: string; readonly close: () => void }) {
  const [feedback, setFeedback] = useState<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback("Copied.");
    } catch {
      setFeedback("Select and copy the key manually.");
    }
  };
  return (
    <section className="vault-card vault-key" aria-label="Lane key">
      <h3>New lane key</h3>
      <p>
        In the MiPi GitHub repository, open <strong>Settings → Environments</strong>. Choose the
        lane and add an environment secret named <code>MIPI_VAULT_KEY</code>. Generate a different
        key for each lane.
      </p>
      <label>
        Lane key
        <input
          readOnly
          value={value}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <div className="vault-actions">
        <button className="pill-button" type="button" onClick={copy}>
          Copy
        </button>
        <button className="pill-button" type="button" onClick={close}>
          Dismiss key
        </button>
        {feedback === undefined ? null : <span role="status">{feedback}</span>}
      </div>
    </section>
  );
}

function SecretAudit({ id, names }: { readonly id: string; readonly names: BotNames }) {
  const [rows, setRows] = useState<readonly AuditRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [firstPage, setFirstPage] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void vaultApi.audit(id, AUDIT_PAGE_SIZE, undefined, controller.signal).then(
      ({ rows }) => {
        if (controller.signal.aborted) return;
        setRows(rows);
        setMore(rows.length === AUDIT_PAGE_SIZE);
        setLoaded(true);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(errorText(failure));
      },
    );
    return () => controller.abort();
  }, [id, firstPage]);

  const loadMore = async () => {
    const before = rows.at(-1)?.id;
    if (busy || before === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await vaultApi.audit(id, AUDIT_PAGE_SIZE, before);
      setRows((current) => [...current, ...page.rows]);
      setMore(page.rows.length === AUDIT_PAGE_SIZE);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="vault-audit" aria-label="Secret audit">
      {!loaded && error === undefined ? <p role="status">Loading audit…</p> : null}
      {loaded && rows.length === 0 ? <p className="vault-muted">No audit entries.</p> : null}
      {error === undefined ? null : (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
      {error === undefined || loaded ? null : (
        <button
          type="button"
          className="pill-button"
          onClick={() => {
            setError(undefined);
            setFirstPage((attempt) => attempt + 1);
          }}
        >
          Retry audit
        </button>
      )}
      {rows.length === 0 ? null : (
        <ol className="vault-audit-rows">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="vault-audit-heading">
                <time>{dateText(row.at)}</time>
                <span className={`vault-badge vault-badge--${row.decision}`}>{row.decision}</span>
              </div>
              <p>
                {row.conversationId === null ? "Unknown bot" : botName(row.conversationId, names)} ·{" "}
                {toolName(row.tool)}
              </p>
              <p className="vault-audit-target">
                {row.method} {row.host}
                {row.path}
              </p>
              {row.status === null && row.reason === null ? null : (
                <p>{[row.status, row.reason].filter((part) => part !== null).join(" · ")}</p>
              )}
            </li>
          ))}
        </ol>
      )}
      {more ? (
        <button type="button" className="pill-button" disabled={busy} onClick={loadMore}>
          {busy ? "Loading…" : "Load older entries"}
        </button>
      ) : null}
    </section>
  );
}

function SecretCard({
  item,
  names,
  edit,
  remove,
}: {
  readonly item: BotSecretInfo;
  readonly names: BotNames;
  readonly edit: () => void;
  readonly remove: () => Promise<void>;
}) {
  const [audit, setAudit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { policy } = item;
  const deleteSecret = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await remove();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="vault-card vault-item" aria-label={item.name}>
      <header className="vault-item-heading">
        <div>
          <h3>{item.name}</h3>
          <p className="vault-muted">{item.category}</p>
        </div>
        <span className={`vault-badge vault-badge--${policy.botAccess}`}>
          {accessLabel[policy.botAccess]}
        </span>
      </header>
      {item.hint === undefined ? null : <p>{item.hint}</p>}
      <dl>
        <dt>Hosts</dt>
        <dd>
          {policy.hosts
            .map((host) => (policy.port === undefined ? host : `${host}:${policy.port}`))
            .join(", ")}
        </dd>
        <dt>Granted bots</dt>
        <dd>
          {policy.bots.length === 0
            ? "None"
            : policy.bots.map((id) => botName(id, names, true)).join(", ")}
        </dd>
        <dt>Expires</dt>
        <dd>{policy.expiresAt === undefined ? "No expiry" : dateText(policy.expiresAt)}</dd>
        <dt>Last used</dt>
        <dd>{item.lastUsedAt === undefined ? "Never used" : dateText(item.lastUsedAt)}</dd>
      </dl>
      <div className="vault-actions">
        <button type="button" className="pill-button" disabled={busy} onClick={edit}>
          Edit
        </button>
        <button
          type="button"
          className="pill-button"
          aria-expanded={audit}
          onClick={() => setAudit(!audit)}
        >
          {audit ? "Hide audit" : "View audit"}
        </button>
        {confirm ? null : (
          <button type="button" className="pill-button" onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
      {confirm ? (
        <div className="vault-delete" role="group" aria-label="Confirm deletion">
          <p>Delete {item.name}? The audit stays.</p>
          <div className="vault-actions">
            <button
              type="button"
              className="pill-button vault-danger"
              disabled={busy}
              onClick={deleteSecret}
            >
              {busy ? "Deleting…" : "Delete secret"}
            </button>
            <button
              type="button"
              className="pill-button"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                setError(undefined);
              }}
            >
              Cancel
            </button>
          </div>
          {error === undefined ? null : (
            <p className="vault-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : null}
      {audit ? <SecretAudit id={item.id} names={names} /> : null}
    </article>
  );
}

type Editor = { readonly kind: "add" } | { readonly kind: "edit"; readonly id: string };

export function VaultSpace(names: BotNames) {
  const [vault, setVault] = useState<VaultList>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<Editor>();
  const [laneKey, setLaneKey] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void vaultApi.list(controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setVault(list);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(errorText(failure));
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const refresh = () => {
    setError(undefined);
    setAttempt((current) => current + 1);
  };
  const storeItem = ({ item }: VaultItem) => {
    setVault((current) =>
      current === undefined
        ? current
        : {
            ...current,
            items: current.items.some(({ id }) => id === item.id)
              ? current.items.map((entry) => (entry.id === item.id ? item : entry))
              : [...current.items, item],
          },
    );
  };
  const remove = async (id: string) => {
    await vaultApi.remove(id);
    setVault((current) =>
      current === undefined
        ? current
        : {
            ...current,
            items: current.items.filter((entry) => entry.id !== id),
          },
    );
  };
  const edited =
    editor?.kind === "edit" ? vault?.items.find(({ id }) => id === editor.id) : undefined;
  const locked = vault?.status.state === "locked";

  return (
    <section className="vault-scroll" aria-label="Vault">
      <div className="vault-content">
        {error === undefined ? null : (
          <div className="vault-card">
            <p className="vault-error" role="alert">
              {error}
            </p>
            <button className="pill-button" type="button" onClick={refresh}>
              Retry Vault
            </button>
          </div>
        )}
        {vault === undefined ? (
          error === undefined ? (
            <p role="status">Loading Vault…</p>
          ) : null
        ) : (
          <>
            <header className="vault-toolbar">
              <h2>Bot secrets</h2>
              <div className="vault-actions">
                <button
                  className="pill-button"
                  type="button"
                  disabled={laneKey !== undefined}
                  onClick={() => setLaneKey(makeLaneKey())}
                >
                  Make a lane key
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={locked || editor !== undefined}
                  onClick={() => setEditor({ kind: "add" })}
                >
                  Add secret
                </button>
              </div>
            </header>
            {vault.status.state === "locked" ? (
              <div className="vault-card vault-locked" role="status">
                <p>
                  <strong>Vault locked.</strong> {vault.status.reason}.
                </p>
              </div>
            ) : null}
            {laneKey === undefined ? null : (
              <LaneKey value={laneKey} close={() => setLaneKey(undefined)} />
            )}
            {editor?.kind === "add" || edited !== undefined ? (
              <VaultSecretForm
                key={edited?.id ?? "add"}
                {...(edited === undefined ? {} : { item: edited })}
                providers={vault.providers}
                {...names}
                locked={locked}
                create={async (input) => storeItem(await vaultApi.create(input))}
                update={async (id, patch) => storeItem(await vaultApi.update(id, patch))}
                close={() => setEditor(undefined)}
              />
            ) : null}
            {vault.items.length === 0 && editor === undefined ? (
              <p className="vault-muted">No bot secrets yet.</p>
            ) : null}
            <div className="vault-items">
              {vault.items.map((item) => (
                <SecretCard
                  key={item.id}
                  item={item}
                  names={names}
                  edit={() => setEditor({ kind: "edit", id: item.id })}
                  remove={() => remove(item.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
