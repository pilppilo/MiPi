/**
 * Points this lane's Telegram bot at its Worker, used by the deploy workflow after a healthy deploy:
 *
 *   node scripts/telegram-webhook.ts --url https://mipi-staging.example.workers.dev/api/telegram
 *
 * Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from the environment. Registers only new messages
 * (`allowed_updates: ["message"]`), one connection at a time so updates arrive in order, and keeps updates Telegram
 * is holding. Prints what Telegram reports back, never the token or the secret.
 */
import { parseArgs } from "node:util";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

const { values: flags } = parseArgs({ options: { url: { type: "string" } } });

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = flags.url ?? fail("--url is required");
if (!url.startsWith("https://") || !url.endsWith("/api/telegram")) {
  fail("--url must be the Worker's https://…/api/telegram");
}
const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || fail("TELEGRAM_BOT_TOKEN is not set");
const secret =
  process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || fail("TELEGRAM_WEBHOOK_SECRET is not set");
if (!SECRET_PATTERN.test(secret)) {
  fail("TELEGRAM_WEBHOOK_SECRET must be 1–256 of A–Z, a–z, 0–9, _ and -");
}

async function call(method: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const answer = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  if (answer.ok !== true) {
    fail(`Telegram refused ${method}: ${response.status} ${answer.description ?? ""}`.trim());
  }
  return (answer.result ?? {}) as Record<string, unknown>;
}

await call("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ["message"],
  max_connections: 1,
  drop_pending_updates: false,
});
const info = await call("getWebhookInfo");
console.log(
  JSON.stringify(
    {
      url: info.url,
      allowed_updates: info.allowed_updates,
      pending_update_count: info.pending_update_count,
      last_error_message: info.last_error_message,
    },
    null,
    2,
  ),
);
if (info.url !== url) fail(`Telegram reports the webhook at ${String(info.url)}, not ${url}`);
