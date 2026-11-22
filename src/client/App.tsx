import { useEffect, useState } from "react";
import { ChatSession } from "./ChatSession.tsx";

const sessionRoute = /^\/sessions\/([^/]+)\/?$/;

export function App() {
  const pathname = window.location.pathname;
  if (pathname === "/") return <LandingPage />;

  const match = sessionRoute.exec(pathname);
  if (match !== null && match[1].length > 0) {
    // Keep the session ID as the opaque encoded path segment PartySocket will reuse.
    return <ChatSession sessionId={match[1]} />;
  }

  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <a href="/">Return to MiPi</a>
      </p>
    </main>
  );
}

/** There is one session, the owner's: the landing page only opens it. */
function LandingPage() {
  const [error, setError] = useState<string>();

  const openSession = async (): Promise<void> => {
    setError(undefined);
    try {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`Opening MiPi failed (${response.status})`);
      const result = (await response.json()) as { readonly url?: unknown };
      if (typeof result.url !== "string")
        throw new Error("The server returned an invalid session URL");
      window.location.assign(result.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Opening MiPi failed");
    }
  };

  useEffect(() => {
    void openSession();
  }, []);

  return (
    <main>
      <header>
        <h1>MiPi</h1>
        <p>Your always-on personal agent.</p>
      </header>
      {error === undefined ? (
        <p role="status">Opening…</p>
      ) : (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => void openSession()}>
            Try again
          </button>
        </>
      )}
    </main>
  );
}
