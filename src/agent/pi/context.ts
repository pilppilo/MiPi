/**
 * chord's call context. chord moved `Context` off its root once already (1.5.1), which touched 25 files in Pi Pocket;
 * here it touches this one. See `durable.ts` for why this seam exists.
 */
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
