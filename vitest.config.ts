import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workerd cannot read Vitest 5's host-filesystem module cache.
  test: { fsModuleCache: false },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OPENCODE_API_KEY: "test-opencode-key",
          MIPI_SPIKE_TOKEN: "test-spike-token",
          ADMIN_TOKEN: "test-admin-token",
          // `node scripts/fixture-capture.ts` sets it: the capture test runs only then.
          MIPI_CAPTURE_FIXTURE: process.env.MIPI_CAPTURE_FIXTURE ?? "",
        },
        // The fixture databases (`test/fixtures/db/`), read by the replay test and written only while capturing.
        serviceBindings: {
          FIXTURES: {
            disk: {
              path: fileURLToPath(new URL("./test/fixtures/db/", import.meta.url)),
              writable: process.env.MIPI_CAPTURE_FIXTURE === "1",
            },
          },
        },
      },
    }),
  ],
});
