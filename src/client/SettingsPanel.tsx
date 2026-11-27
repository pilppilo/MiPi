import { type RefObject, useState } from "react";
import type { ConversationSummary } from "../protocol.ts";
import { type ArchivedEntry, archivedEntries } from "./session/bots-list.ts";
import type { DiagState } from "./session/diag-buffer.ts";
import { DiagnosticsSection } from "./DiagnosticsSection.tsx";

/**
 * Settings (COD-201): a wide panel over the conversation and activity columns, with a section list: Archived, and
 * Diagnostics (COD-236). Later sections (model, Telegram and relay, usage) slot in beside them.
 */
export type SettingsSection = "archived" | "diagnostics";

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: "archived", label: "Archived" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** What the Diagnostics section needs from the session (`usePiSession`). */
export interface DiagnosticsProps {
  readonly diag: DiagState;
  readonly onSubscribe: (query?: { readonly after?: number }) => void;
  readonly onUnsubscribe: () => void;
  readonly onAskMiPi: (prompt: string) => void;
}

export function SettingsPanel({
  conversations,
  disabled,
  onOpen,
  onRestore,
  onClose,
  closeButtonRef,
  diagnostics,
  initialSection = "archived",
}: {
  readonly conversations: readonly ConversationSummary[];
  readonly disabled: boolean;
  /** Opens an archived conversation read-only. */
  readonly onOpen: (conversationId: number) => void;
  readonly onRestore: (conversationId: number) => void;
  readonly onClose: () => void;
  readonly closeButtonRef?: RefObject<HTMLButtonElement | null>;
  /** Without it, Settings has no Diagnostics section. */
  readonly diagnostics?: DiagnosticsProps;
  readonly initialSection?: SettingsSection;
}) {
  const [chosen, setSection] = useState<SettingsSection>(initialSection);
  const sections = SECTIONS.filter(({ id }) => id !== "diagnostics" || diagnostics !== undefined);
  // A section that went away while shown (an agent without diagnostics, COD-246) falls back to the first one.
  const section = sections.some(({ id }) => id === chosen) ? chosen : sections[0]!.id;
  return (
    <section id="settings-panel" className="settings-panel" aria-labelledby="settings-heading">
      <header className="settings-header">
        <h2 id="settings-heading">Settings</h2>
        <button ref={closeButtonRef} type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-sections" aria-label="Settings sections">
          <ul>
            {sections.map(({ id, label }) => (
              <li key={id}>
                <button
                  type="button"
                  className="text-button"
                  aria-current={section === id ? "page" : undefined}
                  onClick={() => setSection(id)}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-content">
          {section === "archived" ? (
            <ArchivedSection
              entries={archivedEntries(conversations)}
              disabled={disabled}
              onOpen={onOpen}
              onRestore={onRestore}
            />
          ) : null}
          {/* Mounted only while shown: leaving it (Archived, Close) unsubscribes the live tail. */}
          {section === "diagnostics" && diagnostics !== undefined ? (
            <DiagnosticsSection
              diag={diagnostics.diag}
              disabled={disabled}
              onSubscribe={diagnostics.onSubscribe}
              onUnsubscribe={diagnostics.onUnsubscribe}
              onAskMiPi={diagnostics.onAskMiPi}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

const archivedTime = (at: number | undefined): string =>
  at === undefined ? "" : new Date(at).toLocaleString();

const entryName = ({ summary, kind }: ArchivedEntry): string =>
  summary.name ??
  (kind === "earlier" ? (summary.title ?? `Chat ${summary.id}`) : `Conversation ${summary.id}`);

const kindLabel = {
  bot: "Bot",
  cobot: "Cobot",
  earlier: "Chat from before bots",
} as const;

function ArchivedSection({
  entries,
  disabled,
  onOpen,
  onRestore,
}: {
  readonly entries: readonly ArchivedEntry[];
  readonly disabled: boolean;
  readonly onOpen: (conversationId: number) => void;
  readonly onRestore: (conversationId: number) => void;
}) {
  return (
    <section aria-labelledby="archived-heading">
      <h3 id="archived-heading">Archived</h3>
      <p className="settings-note">
        Archived bots and chats keep everything but don't run. Open one to read it, or restore it. A
        chat from before bots comes back as a cobot under MiPi. Deleting isn't possible yet.
      </p>
      {entries.length === 0 ? (
        <p className="settings-empty">Nothing is archived.</p>
      ) : (
        <ul className="archived-list">
          {entries.map((entry) => {
            const name = entryName(entry);
            return (
              <li
                key={entry.summary.id}
                className={`archived-entry archived-entry--${entry.kind}`}
                data-conversation={entry.summary.id}
              >
                <div className="archived-entry-text">
                  <strong>{name}</strong>
                  <span className="archived-entry-kind">{kindLabel[entry.kind]}</span>
                  {entry.detail === undefined || entry.detail === name ? null : (
                    <span className="archived-entry-detail">{entry.detail}</span>
                  )}
                  <span className="archived-entry-time">
                    Archived {archivedTime(entry.summary.archivedAt)}
                  </span>
                </div>
                <div className="archived-entry-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Open ${name} read-only`}
                    onClick={() => onOpen(entry.summary.id)}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    disabled={disabled || entry.restoreHint !== undefined}
                    aria-label={`Restore ${name}`}
                    title={entry.restoreHint}
                    onClick={() => onRestore(entry.summary.id)}
                  >
                    Restore
                  </button>
                  {entry.restoreHint === undefined ? null : (
                    <span className="archived-entry-hint">{entry.restoreHint}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
