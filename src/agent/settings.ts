/**
 * Settings of this agent that its tasks read, stored in its own session rather than in module state, so every agent
 * (and every test harness) has its own. The Durable Object writes them from its bindings when it opens.
 */
import { defineDoc } from "./pi/durable.ts";

export const AgentSettings = defineDoc<{
  timeZone?: string;
  /** The profiles' tool lists when every conversation was last given its profile's tools (`syncProfileTools`). */
  profileTools?: string;
  /**
   * The hostnames this agent was reached on (web, Telegram, relay), newest last: `web_fetch` refuses them, so a page
   * can't make MiPi fetch itself (its Access login, its open routes). Recorded by the Durable Object as requests arrive.
   */
  ownHosts?: string[];
}>({
  kind: "app.settings",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** How many hostnames are kept: a lane has one or two (workers.dev, a custom domain). */
export const OWN_HOSTS_KEPT = 8;

/** A hostname as `web_fetch` compares it: lowercase, without trailing dots. */
export const normalHost = (host: string): string => host.toLowerCase().replace(/\.+$/, "");

/** `hosts` with `host` added (or moved to the end), at most `OWN_HOSTS_KEPT`. Undefined when nothing changes. */
export function withOwnHost(
  hosts: readonly string[] | undefined,
  host: string,
): string[] | undefined {
  const normal = normalHost(host);
  if (normal.length === 0) return undefined;
  const current = hosts ?? [];
  if (current.includes(normal)) return undefined;
  return [...current, normal].slice(-OWN_HOSTS_KEPT);
}
