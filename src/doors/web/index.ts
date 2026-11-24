/**
 * The web door's registration with core (COD-210). Its socket handler stays in the composition root (`agent-do.ts`);
 * this is what core needs to know about it: its request-id prefix, and that a web destination is a conversation's
 * transcript, which takes no message nobody is waiting for (`canPush: false`). A reply with no other place goes there.
 */
import type { DoorRegistration } from "../../agent/connectors.ts";
import type { DeliveryDestination } from "../../agent/delivery.ts";
import { clientKey } from "../../lib/requests.ts";

export const WEB_DESTINATION = "web";

/** A message from the web client, keyed by the request id its outbox retries with. */
export function webRequest(key: string): string {
  const safe = clientKey(key);
  if (safe.length === 0) throw new Error("The request id has no usable characters");
  return `web:${safe}`;
}

/** A conversation's transcript as a destination, the shape 0.1.0-beta.1 stored with reminders. */
const transcript = (conversationId: number): DeliveryDestination => ({
  kind: WEB_DESTINATION,
  conversationId,
});

export const webDoor: DoorRegistration = {
  name: "web",
  origins: [{ prefix: "web", source: "web", automated: false }],
  delivery: {
    kind: WEB_DESTINATION,
    canPush: false,
    key: (destination) => String(destination.conversationId),
    describe: () => "this conversation",
  },
  transcript,
};
