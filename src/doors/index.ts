/**
 * MiPi's doors (COD-210): interchangeable ways into the one agent. Each registers with core what core needs from it
 * (origin, delivery, pending inputs); its runtime is wired by the composition root (`src/agent/agent-do.ts`). A door
 * imports only core, never an extension (lint-enforced). Order matters only for telling the owner something with no
 * place named: the first door that knows where the owner is wins.
 */
import type { DoorRegistration } from "../agent/connectors.ts";
import { relayDoor } from "./relay/index.ts";
import { telegramDoor } from "./telegram/index.ts";
import { webDoor } from "./web/index.ts";

export const DOORS: readonly DoorRegistration[] = [webDoor, telegramDoor, relayDoor];
