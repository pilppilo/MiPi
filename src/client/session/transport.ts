/**
 * The session's connections to the agent (COD-245), as the core sees them: a host builds them (`src/client/platform/`
 * wraps PartySocket for the web), so the core needs no DOM and a native shell can swap them.
 *
 * A session may hold more than one: each is a `TransportChannel`. Only `chat` exists now (the WebSocket protocol in
 * `src/protocol.ts`); a media stream for the VM viewer would be another channel beside it, not a second session.
 */

/** The streams a session can open. */
export type TransportChannel = "chat";

export type TransportEvent =
  | { readonly type: "open" }
  | { readonly type: "message"; readonly data: string }
  /** A binary frame: the chat protocol has none. */
  | { readonly type: "binary" }
  | { readonly type: "error" }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

export interface TransportRequest {
  readonly channel: TransportChannel;
  /** The session's id: the room the agent serves it in. */
  readonly room: string;
  /** Whether to connect again after this close. The transport reconnects on its own while this says yes. */
  readonly shouldReconnect: (close: { readonly code: number }) => boolean;
  /** Every event of the connection, including those of each reconnect. */
  readonly onEvent: (event: TransportEvent) => void;
}

/** One connection, reconnecting by itself until closed. */
export interface Transport {
  isOpen(): boolean;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Opens a connection: the host's part. */
export type ConnectTransport = (request: TransportRequest) => Transport;
