/**
 * The `web-fetch` built-in (M8): `web_fetch`, which reads one public web page. A page can say anything, so the tool's
 * output is declared untrusted: core then keeps it out of memory (`src/agent/untrusted.ts`).
 */
import { defineExtension } from "../../../agent/pi/durable.ts";
import type { MipiExtension } from "../../../agent/extensions.ts";
import { WEB_FETCH_TOOL_NAME, webFetchTool } from "./web-fetch.ts";

export const webFetchExtension: MipiExtension = {
  name: "web-fetch",
  tier: "builtin",
  replaceable: true,
  pi: defineExtension({ name: "web-fetch", tools: [webFetchTool] }),
  untrustedTools: [WEB_FETCH_TOOL_NAME],
};
