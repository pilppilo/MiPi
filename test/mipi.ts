/** Shared test setup: the profile table against the built-in extensions' tools, as the Durable Object composes it. */
import { composeMipi } from "../src/agent/composition.ts";

export const PROFILES = composeMipi().profiles;
