# MiPi

MiPi is a personal assistant that is always on and belongs to one person. You talk to it from a web page or from Telegram, and it remembers your conversations, keeps track of what matters to you, and reminds you when you ask.

MiPi runs in your own Cloudflare account, so your conversations stay with you and the assistant is available whenever you are.

> MiPi is in early alpha. It is used every day by its owner, but expect rough edges and changes between releases.

## What MiPi can do

- **Pick up where you left off.** The web app always opens your conversation, on any device, so you can start on your phone and carry on at your desk.
- **Remind you and do things later.** Ask for a reminder or a repeating task in plain words, such as "remind me to call the dentist tomorrow at 9" or "every Monday, ask me for my weekly goals". Times use your own time zone.
- **Remember what you tell it to.** Ask it to keep a preference or a fact about you, and it carries that into every later conversation.
- **Look back.** Ask what you decided about something last month, and it searches your past conversations for the answer.

MiPi only does what it has been given tools for. It cannot read your files or run programs on your computer.

## Ways to talk to MiPi

| Way in       | What it is                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **Web app**  | The main chat page. You sign in with your email, and it opens straight back into your conversation.           |
| **Telegram** | A private bot that answers only you. Press **Start**, then just write.                                        |
| **Relay**    | A private connection that lets another assistant of yours, such as PiDu, send MiPi a message and get a reply. |

All three lead to the same assistant, with the same memory and reminders.

### Telegram commands

| Command       | What it does                                         |
| ------------- | ---------------------------------------------------- |
| `/help`       | Show the available commands                          |
| `/bot`        | List your bots                                       |
| `/bot <name>` | Talk to that bot in this chat, until you switch back |
| `/new [name]` | Start a side chat (cobot) under the current bot      |
| `/model`      | Show or change the model this chat's bot uses        |
| `/profile`    | Show or change which tools this chat's bot may use   |
| `/usage`      | Show today's spend and usage                         |
| `/version`    | Show which version of MiPi is running                |

## Your data and privacy

- **Only you can use it.** The web app is behind a sign-in, and the Telegram bot answers only the accounts you allow. Messages from anyone else, or from a group, get no reply.
- **Backed up before every update.** Each update first saves a copy of your assistant's data. If a backup cannot be made, the update stops.
- **A daily spending limit.** Work you didn't ask for at that moment, such as reminders and background memory, stops for the day once MiPi's own estimate of what it spent reaches the limit you set. Your own messages still go through. You can also pause MiPi completely.
- **Safe when something goes wrong.** If MiPi finds data it does not understand, it stops and says so instead of carrying on and risking damage. Updates can be rolled back, and a backup can be restored.
- **Your own account.** MiPi runs on Cloudflare, and its answers come from the model provider OpenCode Go, so your messages go to that provider.

## Getting set up

MiPi is built to be run by one person for themselves. Setting it up takes a Cloudflare account, a GitHub account and a few minutes in each, and these guides walk through it:

1. [Deployment and operations](docs/deployment.md): where MiPi runs, how updates work, and how to back up, restore and roll back.
2. [Cloudflare Access](docs/cloudflare-access.md): put the sign-in in front of MiPi.
3. [Telegram](docs/telegram.md): create your private bot.
4. [The PiDu relay](docs/relay.md): connect another assistant (optional).

## For developers

Working on the code is covered in [Development](docs/development.md). Coding agents follow [`AGENTS.md`](AGENTS.md). MiPi is built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which is experimental, and every place MiPi works around it is recorded in the [Pi Durable ledger](docs/pi-durable-ledger.md). The history of changes is in [`CHANGELOG.md`](CHANGELOG.md).

## Licence

MiPi is released under the [MIT License](LICENSE).

**Fixture databases (from `0.1.0-beta.1`).** From beta on, data a release stored must open on every later build. `test/fixtures/db/` holds one export per release that changed stored data, and `test/fixtures.test.ts` restores each into a fresh agent through the admin API on every `pnpm test`, checking that it opens and that its lessons, relay answers, channel bindings and repeating reminder still work. After `pnpm bump` for such a release, run `pnpm fixture:capture`: it seeds an agent with every kind of data the build writes (`test/fixture-capture.test.ts`), writes `test/fixtures/db/<version>.json`, and refuses to overwrite one that exists. Commit the file with the release.

## Credits

Seeded from [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare) @ `b68bf92` (MIT, `LICENSES/pi-durable-cloudflare.txt`). Some code is adapted from [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket) @ `2f060f2` (MIT, `LICENSES/pi-pocket.txt`); those files say so in their first line.
