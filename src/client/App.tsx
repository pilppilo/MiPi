import { type SubmitEvent, useEffect, useState } from "react";
import { ChatSession } from "./ChatSession.tsx";
import { loadUsername, MAX_USERNAME_CHARACTERS, saveUsername } from "./identity.ts";

const sessionRoute = /^\/sessions\/([^/]+)\/?$/;

export function App() {
  const pathname = window.location.pathname;
  if (pathname === "/") return <LandingPage />;

  const match = sessionRoute.exec(pathname);
  if (match !== null && match[1].length > 0) {
    // Keep the session ID as the opaque encoded path segment PartySocket will reuse.
    return <ExistingSession sessionId={match[1]} />;
  }

  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <a href="/">Return to the landing page</a>
      </p>
    </main>
  );
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [username, setUsername] = useState(() => loadUsername() ?? "");

  const openSession = async (name: string): Promise<void> => {
    setCreating(true);
    setError(undefined);
    try {
      saveUsername(name);
      // There is one session per owner: this returns the same address every time.
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`Opening MiPi failed (${response.status})`);
      const result = (await response.json()) as { readonly url?: unknown };
      if (typeof result.url !== "string")
        throw new Error("The server returned an invalid session URL");
      window.location.assign(result.url);
    } catch (error) {
      setCreating(false);
      setError(error instanceof Error ? error.message : "Opening MiPi failed");
    }
  };

  const createSession = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void openSession(username);
  };

  // A returning visitor goes straight back to the one session.
  useEffect(() => {
    const saved = loadUsername();
    if (saved !== undefined) void openSession(saved);
  }, []);

  return (
    <main>
      <header>
        <h1>MiPi</h1>
        <p>Your always-on personal agent.</p>
      </header>
      <section aria-labelledby="create-session-heading">
        <h2 id="create-session-heading">Open MiPi</h2>
        <p>Choose the name your messages are shown with.</p>
        <form onSubmit={createSession}>
          <p>
            <label htmlFor="username">Display name</label>{" "}
            <input
              id="username"
              name="username"
              value={username}
              maxLength={MAX_USERNAME_CHARACTERS}
              autoComplete="nickname"
              required
              onChange={(event) => setUsername(event.currentTarget.value)}
            />
          </p>
          <button type="submit" disabled={creating}>
            {creating ? "Opening…" : "Open"}
          </button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
    </main>
  );
}

function ExistingSession({ sessionId }: { readonly sessionId: string }) {
  const [username, setUsername] = useState(loadUsername);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  if (username !== undefined) return <ChatSession sessionId={sessionId} username={username} />;

  const join = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(undefined);
    try {
      setUsername(saveUsername(draft));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to join session");
    }
  };

  return (
    <main>
      <header>
        <h1>MiPi</h1>
        <p>You have been invited to a shared session.</p>
      </header>
      <section aria-labelledby="join-session-heading">
        <h2 id="join-session-heading">Join session</h2>
        <form onSubmit={join}>
          <p>
            <label htmlFor="join-username">Display name</label>{" "}
            <input
              id="join-username"
              name="username"
              value={draft}
              maxLength={MAX_USERNAME_CHARACTERS}
              autoComplete="nickname"
              autoFocus
              required
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </p>
          <button type="submit">Join</button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
