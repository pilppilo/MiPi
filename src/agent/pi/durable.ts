/**
 * The Pi Durable seam. Server code imports Pi Durable from here, never from `@earendil-works/pi-durable` directly,
 * so a breaking upgrade is fixed in `src/agent/pi/` only. For now this re-exports the package as-is; M2a narrows it
 * to MiPi's own interface and adds the lint rule that enforces it.
 */
export * from "@earendil-works/pi-durable";
