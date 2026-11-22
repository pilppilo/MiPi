# mipi

## 0.1.0-alpha.1

### Minor Changes

- M0 scaffold: MiPi seeded once from `earendil-works/pi-durable-cloudflare` @ `b68bf92` (MIT).

  **Added**
  - `src/agent/pi/`: the seam for all Pi Durable, pi-ai, pi-schema, and chord imports on the server (M2a narrows it and adds the lint rule).
  - OpenCode Go as the model provider (pi-ai's built-in `opencode-go`); default model `deepseek-v4.1-flash` at thinking level `low`, set by the `MIPI_MODEL` var.
  - Per-model compaction reserve (`summaryReserve`, adapted from Pi Pocket @ `2f060f2`, MIT) so long conversations keep room for their summary; `deepseek-v4.1-flash` gets 32,768 tokens.
  - Changesets in `alpha` pre mode, exact dependency pins, `.node-version`, and a CI workflow running `pnpm check` and `pnpm test`.

  **Changed**
  - Layout: `src/worker/`, `src/agent/`, `src/tools/`, `src/lib/`. The Durable Object is `MipiAgent` on binding `AGENT`; the Worker is `mipi`.
  - Client: tool calls that park (`waiting`, `sleeping`) show as running, and a sleep without a deadline shows as "until woken".

  **Removed**
  - The sample's mock `get_weather` tool.

  **Pi Durable**
  - `pi-durable`, `pi-ai`, `pi-schema`, `chord` 1.6.0 (from the sample's 1.5.2). Storage: Pi Durable 1.6 (`pi.tool` tasks v4, `pi.generation` v3).

  **Migration**
  - None: first release, no data.
