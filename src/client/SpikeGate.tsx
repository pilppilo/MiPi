import { type ReactNode, type SubmitEvent, useEffect, useState } from "react";

type GateState = "checking" | "locked" | "open" | "unreachable";

/**
 * M1's temporary lock (until Cloudflare Access in M4): asks once for `MIPI_SPIKE_TOKEN`. The server keeps it in an
 * HttpOnly cookie, which the browser then sends with every `/api` request and the WebSocket upgrade.
 */
export function SpikeGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/unlock", { credentials: "same-origin" })
      .then((response) => {
        if (!cancelled) setState(response.status === 204 ? "open" : "locked");
      })
      .catch(() => {
        if (!cancelled) setState("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "open") return <>{children}</>;
  if (state === "checking") return <main aria-busy="true" />;
  if (state === "unreachable") {
    return (
      <main className="page">
        <h1>MiPi</h1>
        <p role="alert">The server can't be reached. Reload to try again.</p>
      </main>
    );
  }

  const unlock = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (response.status === 204) {
        setState("open");
        return;
      }
      setError(
        response.status === 401 ? "That token isn't right." : `Unlock failed (${response.status})`,
      );
    } catch {
      setError("The server can't be reached.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page">
      <header>
        <h1>MiPi</h1>
        <p>Enter the access token to continue. This browser remembers it for 30 days.</p>
      </header>
      <form onSubmit={unlock}>
        <p>
          <label htmlFor="spike-token">Access token</label>{" "}
          <input
            id="spike-token"
            name="token"
            type="password"
            value={token}
            autoComplete="current-password"
            autoFocus
            required
            onChange={(event) => setToken(event.currentTarget.value)}
          />
        </p>
        <button type="submit" disabled={submitting}>
          {submitting ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </main>
  );
}
