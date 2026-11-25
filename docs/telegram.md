# Telegram

Each lane has its own bot. Telegram stays off for a lane until its GitHub Environment has the bot token. Set it up in this order; all of it can be done before the code is deployed.

**1. Telegram: create the bot.** Send `/newbot` to [@BotFather](https://t.me/BotFather), give it a name and a username ending in `bot`. It replies with a token (`123456789:AAH…`): that is `TELEGRAM_BOT_TOKEN`. The username without `@` is `TELEGRAM_BOT_USERNAME`. Send anything to [@userinfobot](https://t.me/userinfobot): the Id it replies with is `TELEGRAM_ALLOWED_USER_IDS` (several ids are separated by commas). Make a webhook secret of 32–64 random letters and digits (a password manager's generator with symbols off): that is `TELEGRAM_WEBHOOK_SECRET`.

**2. GitHub: store the values.** Settings → Environments → `staging` (or `production`):

| Where                                            | Name                        | Value                      |
| ------------------------------------------------ | --------------------------- | -------------------------- |
| Environment secrets → Add environment secret     | `TELEGRAM_BOT_TOKEN`        | the bot's token            |
| Environment secrets → Add environment secret     | `TELEGRAM_WEBHOOK_SECRET`   | the random secret          |
| Environment variables → Add environment variable | `TELEGRAM_ALLOWED_USER_IDS` | your Telegram user id      |
| Environment variables → Add environment variable | `TELEGRAM_BOT_USERNAME`     | the bot's username, no `@` |

The deploy stops with an error naming what is missing if only some are set.

**3. Cloudflare: let Telegram past Access.** Zero Trust → Access controls → Applications → Add an application → Self-hosted. Name it `mipi-staging-telegram`, use the same hostname as the lane's Access application with **Path** `api/telegram` (no leading slash), and add a policy with **Action: Bypass**, **Include: Everyone**, as for `/api/health`. The Worker routes `/api/telegram` before Access authentication and checks the webhook secret itself.

**4. Deploy.** Merging to `main` deploys staging; the deploy's last step, **Register the Telegram webhook**, points the bot at `<worker>/api/telegram` and prints what Telegram reports (`url`, no `last_error_message`). Values added after a deploy take effect on the next one: Actions → deploy → Run workflow → target.

**5. Verify.**

- Open the bot, press **Start**, send `hi`: one reply. `/version` answers the version, `/new` opens a cobot under the current bot and answers "Started a new cobot." Use `/new <name>` to name it.
- `curl -X POST <worker>/api/telegram` answers 401 `{"error":"Unauthorized"}` (the Worker's own check, so the bypass works); a `GET` answers 405.
- A message from another account, or in a group, gets no answer.
