import { MAX_BOT_PURPOSE_CHARACTERS, MAX_PROMPT_CHARACTERS } from "../protocol.ts";
import { archiveBot, isArchived } from "./archive.ts";
import { BOT_HOP_LIMIT, BOT_REPLY_KIND, maxBotHop } from "./bot-hops.ts";
import { admitBotInput, inheritedBotReply } from "./bot-messages.ts";
import {
  BOT_NAME_MAX,
  type CobotLookup,
  createBot,
  findLiveBot,
  findLiveCobot,
  liveBots,
  liveCobots,
} from "./bots.ts";
import { connectorsOf } from "./connectors.ts";
import { bindChannel, ConversationMeta } from "./conversations.ts";
import { measureToday, proactiveHold } from "./gates.ts";
import {
  abortConversation,
  defineDoc,
  type ConversationId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "./pi/durable.ts";
import { type Context } from "./pi/context.ts";
import { obj, opt, str } from "./pi/schema.ts";
import { isProfileName, PICKABLE_PROFILES, type Profiles } from "./profiles.ts";
import { runTouched, untrustedToolNames } from "./untrusted.ts";

const nameField = str({ minLength: 1, maxLength: BOT_NAME_MAX });
const result = (text: string) => ({ output: [{ type: "text" as const, text }] });

const BotToolReceipt = defineDoc<{ id?: number; archived?: number[]; at?: number }>({
  kind: "app.bot-tool-receipt",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => true,
});

async function requireOwner(tx: Tx, api: ToolExecutionApi): Promise<void> {
  const inputs = await connectorsOf(api.registry).origins.runInputs(tx, api.conversationId);
  if (
    inputs.length === 0 ||
    inputs.some(({ authority }) => authority !== "owner") ||
    (await runTouched(tx, api.conversationId, untrustedToolNames(api.registry)))
  ) {
    throw new Error("This action requires an owner-only turn with no external tool content.");
  }
}

export const BOT_LIST_CHANGE = "app.bot-list-change";
const BotListChange = defineDoc<{ revision: number }>({
  kind: BOT_LIST_CHANGE,
  version: 1,
  scope: "session",
  initial: () => ({ revision: 0 }),
  checkpointWhen: () => true,
});

async function mainName(tx: Tx, id: ConversationId): Promise<string> {
  const meta = await tx.doc(ConversationMeta, id);
  if (meta.kind !== "main" || meta.name === undefined)
    throw new Error("Only MiPi can use this tool.");
  return meta.name;
}

/** The caller's name, when it is a purpose bot: only one manages its own cobots (COD-233). */
async function purposeBotName(tx: Tx, id: ConversationId): Promise<string> {
  const meta = await tx.doc(ConversationMeta, id);
  if (meta.kind !== "bot" || meta.name === undefined) {
    throw new Error(
      meta.kind === "main"
        ? "MiPi manages cobots with list_bots and stop_bot."
        : "Only a purpose bot can manage its cobots.",
    );
  }
  return meta.name;
}

/** The cobot a lookup found, or a refusal naming why: never the bot itself in its place. */
function foundCobot(lookup: CobotLookup, botName: string, name: string): ConversationId {
  switch (lookup.kind) {
    case "found":
      return lookup.cobot.id;
    case "missing":
      throw new Error(`${botName} has no live cobot named ${name}.`);
    case "ambiguous":
      throw new Error(
        `${botName} has ${lookup.count} live cobots named ${name}. Rename one in the web app first.`,
      );
    default: {
      const _: never = lookup;
      throw new Error(`${botName} has no live cobot named ${name}.`);
    }
  }
}

/**
 * Archives what `pick` names, once per task (a replay returns what the first run archived), then stops what each
 * archived conversation was doing. `guard` runs first in the commit: the caller and the turn's authority.
 */
async function archiveAndStop(
  api: ToolExecutionApi,
  context: Context,
  guard: (tx: Tx) => Promise<void>,
  pick: (tx: Tx) => Promise<ConversationId>,
): Promise<void> {
  const { archived, at } = await api.commit(async (tx) => {
    await guard(tx);
    const receipt = await tx.doc(BotToolReceipt, api.taskId);
    if (receipt.archived !== undefined) return { archived: [...receipt.archived], at: receipt.at };
    const id = await pick(tx);
    const at = api.now();
    const archived = await archiveBot(tx, id, at);
    if (archived.length > 0) (await tx.doc(BotListChange)).revision++;
    receipt.archived = archived;
    receipt.at = at;
    return { archived, at };
  }, context);
  for (const id of archived as ConversationId[]) {
    const meta = await api.snapshot(ConversationMeta, id, context);
    if (meta?.archivedAt !== at) continue;
    const conversation = await api.conversation(id, context);
    if (conversation !== undefined) await abortConversation(conversation, context);
  }
}

export async function bindBotDoor(
  tx: Tx,
  keys: ReadonlySet<string>,
  key: string,
  id: ConversationId,
): Promise<void> {
  if (!keys.has(key)) {
    const doors = [...keys].sort().join(", ");
    throw new Error(
      `No rebindable door named ${key}.${doors.length === 0 ? "" : ` The doors are: ${doors}.`}`,
    );
  }
  const meta = await tx.doc(ConversationMeta, id);
  if ((meta.kind !== "bot" && meta.kind !== "main") || meta.archivedAt !== undefined) {
    throw new Error("A door can only be bound to a live bot.");
  }
  await bindChannel(tx, key, id);
}

export function botTools(profiles: () => Profiles): readonly ToolRegistration[] {
  return [
    {
      name: "create_bot",
      description:
        "Create a purpose bot on the default or empty profile during an owner-only turn.",
      parameters: obj({
        name: nameField,
        purpose: str({ minLength: 1, maxLength: MAX_BOT_PURPOSE_CHARACTERS }),
        profile: str({ description: PICKABLE_PROFILES.join(" or ") }),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name, purpose, profile } = args as {
          name: string;
          purpose: string;
          profile: string;
        };
        if (purpose.trim().length === 0) throw new Error("A bot needs a purpose.");
        if (!isProfileName(profile) || !PICKABLE_PROFILES.includes(profile)) {
          throw new Error(
            `${profile} can't be a bot's profile: pick one of ${PICKABLE_PROFILES.join(", ")}.`,
          );
        }
        return api.commit(async (tx) => {
          const sender = await mainName(tx, api.conversationId);
          await requireOwner(tx, api);
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          if (receipt.id === undefined) {
            receipt.id = await createBot(
              tx,
              { kind: "bot", name, purpose, profile, createdBy: `bot:${sender}` },
              profiles(),
            );
            (await tx.doc(BotListChange)).revision++;
          }
          return result(`Created ${name} (conversation ${receipt.id}).`);
        }, context);
      },
    },
    {
      name: "bind_door",
      description:
        "Bind an owner-configurable door such as relay:pidu to a live bot during an owner-only turn. Name MiPi to bind the door back to MiPi.",
      parameters: obj({ name: nameField, channel: str({ minLength: 1, maxLength: 128 }) }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name, channel } = args as { name: string; channel: string };
        return api.commit(async (tx) => {
          await mainName(tx, api.conversationId);
          await requireOwner(tx, api);
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          if (receipt.id === undefined) {
            const target = await findLiveBot(tx, name);
            if (target === undefined) throw new Error(`There is no live bot named ${name}.`);
            await bindBotDoor(tx, connectorsOf(api.registry).rebindableKeys, channel, target.id);
            receipt.id = target.id;
          }
          return result(`Bound ${channel} to ${name}.`);
        }, context);
      },
    },
    {
      name: "list_bots",
      description:
        "List active bots with their names and purposes, each with its active cobots indented under it.",
      parameters: obj({}),
      replay: "safe",
      execute: async (_args, api, context) =>
        api.commit(async (tx) => {
          await mainName(tx, api.conversationId);
          const cobots = await liveCobots(tx);
          return result(
            (await liveBots(tx))
              .flatMap(({ id, name, purpose }) => [
                purpose === undefined ? name : `${name} — ${purpose}`,
                ...cobots.filter(({ bot }) => bot === id).map((cobot) => `  cobot: ${cobot.name}`),
              ])
              .join("\n"),
          );
        }, context),
    },
    {
      name: "message_bot",
      description: "Send work to a purpose bot. Its answer will arrive later as a follow-up.",
      parameters: obj({
        name: nameField,
        text: str({ minLength: 1, maxLength: MAX_PROMPT_CHARACTERS }),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name, text } = args as { name: string; text: string };
        if (text.trim().length === 0) throw new Error("A bot message needs text.");
        const target = await api.commit(async (tx) => {
          await mainName(tx, api.conversationId);
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          return receipt.id ?? (await findLiveBot(tx, name))?.id;
        }, context);
        if (target === undefined) throw new Error(`There is no live bot named ${name}.`);
        if (target === api.conversationId) throw new Error("MiPi cannot message itself.");
        const to = await api.conversation(target as ConversationId, context);
        if (to === undefined) throw new Error(`The bot ${name} is missing.`);
        const { origins, diag } = connectorsOf(api.registry);
        // pi-ledger L12: store the target admission, its hop and the pending reply atomically.
        const requestId = `bot:${api.conversationId}:${api.callId}`;
        const now = api.now();
        await api.commit((tx) => measureToday(tx, now), context);
        // A hold ends the commit without a write; it is recorded and refused after the commit returns.
        const held = await api.commit(async (tx) => {
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          if (receipt.id !== undefined) return undefined;
          if ((await tx.submissionByRequest(to.id, requestId)) !== undefined) {
            receipt.id = to.id;
            return undefined;
          }
          const sender = await mainName(tx, api.conversationId);
          const receiver = await tx.doc(ConversationMeta, to.id);
          if (receiver.name === undefined || (await isArchived(tx, to.id))) {
            throw new Error(`The bot ${name} is no longer active.`);
          }
          const inputs = await origins.runInputs(tx, api.conversationId);
          const hop = 1 + (await maxBotHop(tx, inputs));
          if (hop > BOT_HOP_LIMIT)
            throw new Error(`The bot message hop limit is ${BOT_HOP_LIMIT}.`);
          const hold = await proactiveHold(tx, now);
          if (hold !== undefined) return hold;
          await admitBotInput(
            tx,
            to,
            {
              requestId,
              sender,
              text,
              hop,
              ownerReply:
                (await origins.replyTo(tx, api.conversationId)) ??
                (await inheritedBotReply(tx, inputs)),
              destination: {
                kind: BOT_REPLY_KIND,
                conversationId: api.conversationId,
                name: receiver.name,
                hop,
              },
            },
            now,
          );
          receipt.id = to.id;
          return undefined;
        }, context);
        if (held !== undefined) {
          diag.emit({
            level: "info",
            source: "gate",
            kind: "gate.held",
            outcome: "held",
            summary: `A bot message is held by the ${held} gate`,
            convId: api.conversationId,
            detail: { gate: held, at: "message_bot" },
          });
          throw new Error(`Bot work is on hold (${held}).`);
        }
        return result(`Sent work to ${name}. Its reply will follow.`);
      },
    },
    {
      name: "stop_bot",
      description:
        "Archive a purpose bot, with its cobots, and stop their current work. With cobot, archive only that cobot of the named bot (MiPi's included) and leave the bot running. The owner can restore either later.",
      parameters: obj({
        name: nameField,
        cobot: opt(
          str({
            minLength: 1,
            maxLength: BOT_NAME_MAX,
            description: "The cobot's name, as list_bots shows it, to archive only that cobot",
          }),
        ),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name, cobot } = args as { name: string; cobot?: string };
        await archiveAndStop(
          api,
          context,
          async (tx) => {
            await mainName(tx, api.conversationId);
            await requireOwner(tx, api);
          },
          async (tx) => {
            const bot = await findLiveBot(tx, name);
            if (bot === undefined) throw new Error(`There is no live bot named ${name}.`);
            if (cobot === undefined) return bot.id;
            return foundCobot(await findLiveCobot(tx, bot.id, cobot), bot.name, cobot);
          },
        );
        return result(
          cobot === undefined ? `Archived ${name}.` : `Archived ${name}'s cobot ${cobot}.`,
        );
      },
    },
    {
      name: "list_cobots",
      description: "For a purpose bot: list your active cobots (your side chats) by name.",
      parameters: obj({}),
      replay: "safe",
      execute: async (_args, api, context) =>
        api.commit(async (tx) => {
          await purposeBotName(tx, api.conversationId);
          const cobots = await liveCobots(tx, api.conversationId);
          return result(
            cobots.length === 0 ? "No active cobots." : cobots.map(({ name }) => name).join("\n"),
          );
        }, context),
    },
    {
      name: "archive_cobot",
      description:
        "For a purpose bot: archive one of your cobots and stop its work, during an owner-only turn. The owner can restore it later.",
      parameters: obj({ name: nameField }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name } = args as { name: string };
        let botName = "";
        await archiveAndStop(
          api,
          context,
          async (tx) => {
            botName = await purposeBotName(tx, api.conversationId);
            await requireOwner(tx, api);
          },
          async (tx) =>
            foundCobot(await findLiveCobot(tx, api.conversationId, name), botName, name),
        );
        return result(`Archived the cobot ${name}.`);
      },
    },
  ];
}
