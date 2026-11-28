import { type SubmitEvent, useId, useState } from "react";
import {
  type ApprovalDecision,
  type ApprovalSummary,
  MAX_APPROVAL_NOTE_CHARACTERS,
} from "../protocol.ts";
import type { DecisionResult } from "./session/session-client.ts";
import { toolName } from "./names.ts";

/** When a request times out, as the owner reads it: a time today, or a date and time. */
export function expiryText(expiresAt: number, now: number = Date.now()): string {
  const at = new Date(expiresAt);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `Expires at ${time}`
    : `Expires ${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * One tool call waiting for the owner (COD-173): what it will do and why it asks, its arguments, when it times out,
 * and Approve / Deny with an optional note. The buttons wait for the agent's answer, so a second click can't send a
 * second decision; a refusal (answered elsewhere, timed out) shows here.
 */
export function ApprovalCard({
  approval,
  disabled,
  onDecide,
  where,
}: {
  readonly approval: ApprovalSummary;
  readonly disabled: boolean;
  readonly where?: string;
  readonly onDecide: (decision: ApprovalDecision, note: string) => Promise<DecisionResult>;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<ApprovalDecision>();
  const [error, setError] = useState<string>();
  const headingId = useId();
  const noteId = useId();

  const decide = async (decision: ApprovalDecision) => {
    if (disabled || sending !== undefined) return;
    setSending(decision);
    setError(undefined);
    const result = await onDecide(decision, note);
    // Taken: the card leaves with the next list. Refused: it says why and can be tried again.
    if (!result.ok) {
      setError(result.message);
      setSending(undefined);
    }
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void decide("approve");
  };

  return (
    <article className="approval-card" aria-labelledby={headingId}>
      <header>
        <h3 id={headingId}>Approval needed</h3>
        <span className="approval-tool" title={approval.tool}>
          {toolName(approval.tool)}
        </span>
      </header>
      {where === undefined ? null : <p className="approval-reason">{where}</p>}
      <p className="approval-summary">{approval.summary}</p>
      <p className="approval-reason">{approval.reason}</p>
      {approval.arguments === "{}" ? null : (
        <details className="approval-arguments">
          <summary>Arguments</summary>
          <pre>{approval.arguments}</pre>
        </details>
      )}
      {approval.expiresAt === undefined ? null : (
        <p className="approval-expiry">{expiryText(approval.expiresAt)}</p>
      )}
      <form className="approval-form" onSubmit={submit}>
        <label htmlFor={noteId}>Note (optional)</label>
        <input
          id={noteId}
          type="text"
          value={note}
          maxLength={MAX_APPROVAL_NOTE_CHARACTERS}
          onChange={(event) => setNote(event.currentTarget.value)}
          disabled={disabled || sending !== undefined}
        />
        <div className="approval-actions">
          <button type="submit" disabled={disabled || sending !== undefined}>
            {sending === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            className="approval-deny"
            onClick={() => void decide("deny")}
            disabled={disabled || sending !== undefined}
          >
            {sending === "deny" ? "Denying…" : "Deny"}
          </button>
        </div>
      </form>
      {error === undefined ? null : (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
