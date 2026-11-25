/**
 * OpenCode Go's provider pieces (COD-212): its usage reader and its live model list. An optional extension with no Pi
 * Durable part: it adds nothing to a conversation's selection and can't be switched off per conversation, since both
 * pieces are agent-wide. Pi's own provider wiring stays in the model seam (`src/agent/pi/models.ts`, ledger L1).
 */
import type { MipiExtension } from "../../../agent/extensions.ts";
import { MODEL_PROVIDER } from "../../../agent/pi/models.ts";
import { goModelListSource } from "./models.ts";
import { goLimit } from "./limit.ts";
import { goUsageSource } from "./usage.ts";

export const opencodeGoExtension: MipiExtension = {
  name: "opencode-go",
  tier: "optional",
  providers: [
    {
      provider: MODEL_PROVIDER,
      usage: goUsageSource,
      models: goModelListSource,
      limit: { label: "OpenCode Go", parse: goLimit },
    },
  ],
};
