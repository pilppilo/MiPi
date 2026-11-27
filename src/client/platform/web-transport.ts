/**
 * The web's `Transport` (COD-245): a PartySocket to the agent's session room on this origin. PartySocket reconnects by
 * itself while `shouldReconnect` says yes, so one transport lives as long as the session's connection.
 */
import PartySocket from "partysocket";
import type { ConnectTransport } from "../session/transport.ts";

export const connectWebTransport: ConnectTransport = ({
  channel,
  room,
  shouldReconnect,
  onEvent,
}) => {
  switch (channel) {
    case "chat": {
      const socket = new PartySocket({
        host: window.location.host,
        party: "sessions",
        prefix: "api",
        room,
        maxEnqueuedMessages: 16,
        shouldReconnectOnClose: (event) => shouldReconnect({ code: event.code }),
      });
      socket.addEventListener("open", () => onEvent({ type: "open" }));
      socket.addEventListener("message", (event) =>
        onEvent(
          typeof event.data === "string"
            ? { type: "message", data: event.data }
            : { type: "binary" },
        ),
      );
      socket.addEventListener("error", () => onEvent({ type: "error" }));
      socket.addEventListener("close", (event) =>
        onEvent({ type: "close", code: event.code, reason: event.reason }),
      );
      return {
        isOpen: () => socket.readyState === socket.OPEN,
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
      };
    }
    default: {
      const _: never = channel;
      throw new Error(`Unknown transport channel: ${String(channel)}`);
    }
  }
};
