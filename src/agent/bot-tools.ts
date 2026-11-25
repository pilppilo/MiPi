import { MAX_BOT_PURPOSE_CHARACTERS, MAX_PROMPT_CHARACTERS } from "../protocol.ts";
import { archiveBot, isArchived } from "./archive.ts";
import { BOT_HOP_LIMIT, BOT_ORIGIN, BOT_REPLY_KIND, maxBotHop } from "./bot-hops.ts";
import { admitBotInput } from "./bot-messages.ts";
import { BOT_NAME_MAX, createBot, findLiveBot, liveBots } from "./bots.ts";
import { connectorsOf } from "./connectors.ts";
import { bindChannel, ConversationMeta } from "./conversations.ts";
import { holdNow, proactiveHold } from "./gates.ts";
import type { RunInput } from "./origin.ts";
import { defineDoc, type ConversationId, type ToolRegistration, type Tx } from "./pi/durable.ts";
import { obj, opt, str } from "./pi/schema.ts";
import { isProfileName, PICKABLE_PROFILES, type Profiles } from "./profiles.ts";

const nameField = str({ minLength: 1, maxLength: BOT_NAME_MAX });
const result = (text: string) => ({ output: [{ type: "text" as const, text }] });

const BotToolReceipt = defineDoc<{ id?: number; archived?: number[]; at?: number; bound?: true }>({
  kind: "app.bot-tool-receipt",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => true,
});

function refuseRelay(inputs: readonly RunInput[]): void {
  if (inputs.some(({ authority }) => authority === "external")) {
    throw new Error("This action is unavailable in a turn that includes a relay message.");
  }
}

function requireOwner(inputs: readonly RunInput[]): void {
  refuseRelay(inputs);
  if (
    !inputs.some(({ authority }) => authority === "owner") ||
    inputs.some(({ origin }) => origin.source === BOT_ORIGIN.source)
  ) {
    throw new Error("Rebinding a door requires a direct message from the owner.");
  }
}

async function mainName(tx: Tx, id: ConversationId): Promise<string> {
  const meta = await tx.doc(ConversationMeta, id);
  if (meta.kind !== "main" || meta.name === undefined)
    throw new Error("Only MiPi can use this tool.");
  return meta.name;
}

export async function bindBotDoor(
  tx: Tx,
  keys: ReadonlySet<string>,
  key: string,
  id: ConversationId,
): Promise<void> {
  if (!keys.has(key)) throw new Error(`No rebindable door named ${key}.`);
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
        "Create a purpose bot on the default or empty profile. On a direct owner request, optionally bind a relay such as relay:pidu. To bind an existing bot, provide only its name and relay.",
      parameters: obj({
        name: nameField,
        purpose: opt(str({ minLength: 1, maxLength: MAX_BOT_PURPOSE_CHARACTERS })),
        profile: opt(str({ description: PICKABLE_PROFILES.join(" or ") })),
        relay: opt(str({ maxLength: 128 })),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name, purpose, profile, relay } = args as {
          name: string;
          purpose?: string;
          profile?: string;
          relay?: string;
        };
        const connectors = connectorsOf(api.registry);
        return api.commit(async (tx) => {
          const sender = await mainName(tx, api.conversationId);
          const inputs = await connectors.origins.runInputs(tx, api.conversationId);
          refuseRelay(inputs);
          if (relay !== undefined) requireOwner(inputs);
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          if (receipt.id === undefined) {
            if (relay !== undefined && purpose === undefined && profile === undefined) {
              const target = await findLiveBot(tx, name);
              if (target === undefined) throw new Error(`There is no live bot named ${name}.`);
              await bindBotDoor(tx, connectors.rebindableKeys, relay, target.id);
              receipt.id = target.id;
              receipt.bound = true;
            } else {
              if (purpose === undefined || purpose.trim().length === 0)
                throw new Error("A bot needs a purpose.");
              if (!isProfileName(profile))
                throw new Error(`Pick a profile: ${PICKABLE_PROFILES.join(", ")}.`);
              // Validate the key before createBot writes any conversation records.
              if (relay !== undefined && !connectors.rebindableKeys.has(relay)) {
                throw new Error(`No rebindable door named ${relay}.`);
              }
              const id = await createBot(
                tx,
                { kind: "bot", name, purpose, profile, createdBy: `bot:${sender}` },
                profiles(),
              );
              if (relay !== undefined) await bindChannel(tx, relay, id);
              receipt.id = id;
            }
          }
          return result(
            receipt.bound
              ? `Bound ${relay} to ${name}.`
              : `Created ${name} (conversation ${receipt.id}).${relay === undefined ? "" : ` Bound ${relay} to it.`}`,
          );
        }, context);
      },
    },
    {
      name: "list_bots",
      description: "List active bots with their names and purposes.",
      parameters: obj({}),
      replay: "safe",
      execute: async (_args, api, context) =>
        api.commit(async (tx) => {
          await mainName(tx, api.conversationId);
          return result(
            (await liveBots(tx))
              .map(({ name, purpose }) => (purpose === undefined ? name : `${name} — ${purpose}`))
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
        const { origins } = connectorsOf(api.registry);
        // pi-ledger L12: store the target admission, its hop and the pending reply atomically.
        const requestId = `bot:${api.conversationId}:${api.callId}`;
        await api.commit(async (tx) => {
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          if (receipt.id !== undefined) return;
          if ((await tx.submissionByRequest(to.id, requestId)) !== undefined) {
            receipt.id = to.id;
            return;
          }
          const sender = await mainName(tx, api.conversationId);
          const receiver = await tx.doc(ConversationMeta, to.id);
          if (receiver.name === undefined || (await isArchived(tx, to.id))) {
            throw new Error(`The bot ${name} is no longer active.`);
          }
          const hop = 1 + (await maxBotHop(tx, await origins.runInputs(tx, api.conversationId)));
          if (hop > BOT_HOP_LIMIT)
            throw new Error(`The bot message hop limit is ${BOT_HOP_LIMIT}.`);
          const now = api.now();
          const hold = (await holdNow(tx, now)) ?? (await proactiveHold(tx, now));
          if (hold !== undefined) throw new Error(`Bot work is on hold (${hold}).`);
          await admitBotInput(
            tx,
            to,
            {
              requestId,
              sender,
              text,
              hop,
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
        }, context);
        return result(`Sent work to ${name}. Its reply will follow.`);
      },
    },
    {
      name: "stop_bot",
      description:
        "Archive a purpose bot and stop its current work. The owner can restore it later.",
      parameters: obj({ name: nameField }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { name } = args as { name: string };
        const { origins } = connectorsOf(api.registry);
        const { archived, at } = await api.commit(async (tx) => {
          await mainName(tx, api.conversationId);
          refuseRelay(await origins.runInputs(tx, api.conversationId));
          const receipt = await tx.doc(BotToolReceipt, api.taskId);
          if (receipt.archived !== undefined)
            return { archived: [...receipt.archived], at: receipt.at };
          const bot = await findLiveBot(tx, name);
          if (bot === undefined) throw new Error(`There is no live bot named ${name}.`);
          const at = api.now();
          const archived = await archiveBot(tx, bot.id, at);
          receipt.archived = archived;
          receipt.at = at;
          return { archived, at };
        }, context);
        for (const id of archived as ConversationId[]) {
          const meta = await api.snapshot(ConversationMeta, id, context);
          if (meta?.archivedAt === at) await (await api.conversation(id, context))?.abort(context);
        }
        return result(`Archived ${name}.`);
      },
    },
  ];
}
