/**
 * The PiDu relay's registration with core (COD-210): its request-id prefix. The relay's answer is read back by the
 * client (`RelayRuntime.result`), never pushed, so it registers no delivery adapter and no pending inputs.
 */
import type { DoorRegistration } from "../../agent/connectors.ts";

export const relayDoor: DoorRegistration = {
  name: "relay",
  origins: [{ prefix: "relay", source: "relay", automated: false }],
};
