/**
 * The optional extensions this build adds after the built-in ones (COD-212). Like `builtins.ts`, the list sits above
 * the extensions, so `scripts/check-boundaries.ts` doesn't read it as one.
 */
import type { MipiExtension } from "../agent/extensions.ts";
import { opencodeGoExtension } from "./optional/opencode-go/index.ts";

export const OPTIONAL_EXTENSIONS: readonly MipiExtension[] = [opencodeGoExtension];
