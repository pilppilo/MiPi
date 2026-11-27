import { Fragment, useEffect, useState } from "react";
import type { DiagEvent } from "../protocol.ts";
import type { DiagState } from "./session/diag-buffer.ts";
import { lastDiagId } from "./session/diag-buffer.ts";
import {
  ALL_EVENTS,
  askMiPiPrompt,
  bannerItems,
  type BannerItem,
  countEvents,
  type DiagFilters,
  eventDetail,
  HOLD_LABELS,
  LEVEL_FILTERS,
  localTime,
  shownEvents,
  sourcesOf,
} from "./diagnostics.ts";

/**
 * Settings → Diagnostics (COD-236): the agent's diagnostic events, live while the section is open. It subscribes on
 * mount and unsubscribes on unmount, so closing Settings or switching to Archived stops the frames at once. The
 * choices (filters, pause, expanded rows) live here; everything shown is worked out in `diagnostics.ts`.
 */
export function DiagnosticsSection({
  diag,
  disabled,
  onSubscribe,
  onUnsubscribe,
  onAskMiPi,
}: {
  readonly diag: DiagState;
  readonly disabled: boolean;
  readonly onSubscribe: (query?: { readonly after?: number }) => void;
  readonly onUnsubscribe: () => void;
  /** Puts the prompt in MiPi's composer; never sends it. */
  readonly onAskMiPi: (prompt: string) => void;
}) {
  const [filters, setFilters] = useState<DiagFilters>(ALL_EVENTS);
  const [frozenAt, setFrozenAt] = useState<number | undefined>();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    onSubscribe();
    return () => onUnsubscribe();
    // Once per mount: the callbacks are stable (`usePiSession`), and a new subscription per render would flood.
  }, []);

  return (
    <DiagnosticsView
      diag={diag}
      disabled={disabled}
      filters={filters}
      frozenAt={frozenAt}
      expanded={expanded}
      now={Date.now()}
      onFilters={setFilters}
      onPause={(paused) => setFrozenAt(paused ? (lastDiagId(diag.events) ?? 0) : undefined)}
      onToggle={(id) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
      onRefresh={() => {
        const after = lastDiagId(diag.events);
        onSubscribe(after === undefined ? {} : { after });
      }}
      onAskMiPi={onAskMiPi}
    />
  );
}

const time = (at: number): string => new Date(at).toLocaleTimeString();

/** The section as its state draws it. No hooks: tests render it, and call its handlers, directly. */
export function DiagnosticsView({
  diag,
  disabled,
  filters,
  frozenAt,
  expanded,
  now,
  onFilters,
  onPause,
  onToggle,
  onRefresh,
  onAskMiPi,
}: {
  readonly diag: DiagState;
  readonly disabled: boolean;
  readonly filters: DiagFilters;
  /** The newest id shown while scrolling is paused; undefined while live. */
  readonly frozenAt: number | undefined;
  readonly expanded: ReadonlySet<number>;
  readonly now: number;
  readonly onFilters: (filters: DiagFilters) => void;
  readonly onPause: (paused: boolean) => void;
  readonly onToggle: (id: number) => void;
  readonly onRefresh: () => void;
  readonly onAskMiPi: (prompt: string) => void;
}) {
  const { events, health } = diag;
  const counts = countEvents(events);
  const { rows, pending } = shownEvents(events, filters, frozenAt);
  const banner = bannerItems(health, events, now);
  const sources = sourcesOf(events, filters.source);
  const paused = frozenAt !== undefined;
  return (
    <section aria-labelledby="diagnostics-heading" className="diagnostics">
      <h3 id="diagnostics-heading">Diagnostics</h3>
      <p className="settings-note">
        The agent's own record of hops, holds and faults, live while this is open. It never holds
        message text or secrets.
      </p>

      <div className="diag-summary" role="group" aria-label="Summary">
        <span className="diag-count">{counts.total} events</span>
        <span className="diag-count diag-count--ok">{counts.ok} ok</span>
        <span className="diag-count diag-count--warn">{counts.warnHeld} warn / held</span>
        <span className="diag-count diag-count--error">{counts.error} error</span>
        <span className="diag-alarm">
          {health?.alarmAt === undefined ? "Idle" : `Next alarm: ${localTime(health.alarmAt)}`}
        </span>
        {health?.held === undefined ? null : (
          <span className="diag-hold" title={HOLD_LABELS[health.held]}>
            {health.held}
            {health.heldUntil === undefined ? "" : ` until ${localTime(health.heldUntil)}`}
          </span>
        )}
        <span className="diag-live">
          {diag.subscribed ? "Live" : disabled ? "Offline" : "Connecting…"}
        </span>
        <button type="button" disabled={disabled} onClick={onRefresh}>
          Refresh
        </button>
        <button
          type="button"
          disabled={disabled}
          title="Pre-fills MiPi's message box without sending."
          onClick={() => onAskMiPi(askMiPiPrompt(health, rows))}
        >
          Ask MiPi
        </button>
      </div>
      {diag.error === undefined ? null : <p className="diag-error">{diag.error}</p>}

      {banner.length === 0 ? null : (
        <div className="diag-banner" role="status">
          <ul>
            {banner.map((item: BannerItem) => (
              <li key={item.kind} className={`diag-banner-item diag-banner-item--${item.kind}`}>
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="diag-filters">
        <div role="group" aria-label="Severity">
          {LEVEL_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="diag-chip"
              aria-pressed={filters.level === id}
              onClick={() => onFilters({ ...filters, level: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Source">
          <button
            type="button"
            className="diag-chip"
            aria-pressed={filters.source === undefined}
            onClick={() => onFilters({ ...filters, source: undefined })}
          >
            All
          </button>
          {sources.map((source) => (
            <button
              key={source}
              type="button"
              className="diag-chip"
              aria-pressed={filters.source === source}
              onClick={() => onFilters({ ...filters, source })}
            >
              {source}
            </button>
          ))}
        </div>
        <button type="button" aria-pressed={paused} onClick={() => onPause(!paused)}>
          {paused ? "Resume" : "Pause scroll"}
        </button>
        {paused && pending > 0 ? (
          <span className="diag-pending" aria-live="polite">
            {pending} new
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="settings-empty">
          {events.length === 0 ? "No events yet." : "No events match these filters."}
        </p>
      ) : (
        // Scrolls on its own on a narrow screen (COD-244), so five columns never widen the page.
        <div className="diag-table-scroll" tabIndex={0} role="region" aria-label="Events">
          <table className="diag-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Severity</th>
                <th scope="col">Source</th>
                <th scope="col">Event</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {/* Newest first: the latest faults are at the top, and new rows arrive there, not off-screen. */}
              {rows.toReversed().map((event) => (
                <DiagRow
                  key={event.id}
                  event={event}
                  open={expanded.has(event.id)}
                  onToggle={() => onToggle(event.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DiagRow({
  event,
  open,
  onToggle,
}: {
  readonly event: DiagEvent;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const detailId = `diag-detail-${event.id}`;
  const detail = eventDetail(event);
  const hasDetail = Object.keys(detail).length > 0;
  return (
    <Fragment>
      <tr className={`diag-row diag-row--${event.level}`} data-event={event.id}>
        <td className="diag-time">
          <time dateTime={new Date(event.ts).toISOString()}>{time(event.ts)}</time>
        </td>
        <td>{event.level}</td>
        <td>{event.source}</td>
        <td>
          {hasDetail ? (
            <button
              type="button"
              className="text-button diag-kind"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={onToggle}
            >
              {event.kind}
            </button>
          ) : (
            <span className="diag-kind">{event.kind}</span>
          )}
          <span className="diag-summary-text">{event.summary}</span>
        </td>
        <td>
          <span className={`diag-outcome diag-outcome--${event.outcome}`}>{event.outcome}</span>
        </td>
      </tr>
      {hasDetail ? (
        // Always there, so the toggle's `aria-controls` names an element; hidden until opened.
        <tr id={detailId} className="diag-detail-row" hidden={!open}>
          <td colSpan={5}>{open ? <pre>{JSON.stringify(detail, null, 2)}</pre> : null}</td>
        </tr>
      ) : null}
    </Fragment>
  );
}
