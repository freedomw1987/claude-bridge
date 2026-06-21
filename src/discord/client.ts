/**
 * Discord client setup.
 * discord.js v14, with the intents needed for message content + threads.
 */

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { log } from "../logger";
import type { SessionStore } from "../db";
import { handleMessageCreate } from "./handlers/messageCreate";
import type { ProjectRegistry } from "../projects/registry";

export function createClient(deps: {
  store: SessionStore;
  projects: ProjectRegistry;
}): Client {
  const { store, projects } = deps;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, () => {
    log.info("discord ready", {
      user: client.user?.tag,
      guilds: client.guilds.cache.size,
    });
  });

  // Expose a heartbeat probe for the launchd health watchdog. discord.js
  // emits 'shardDisconnect'/'shardReconnecting' but not all background-
  // process ws drops surface as a clean event — we also probe status
  // every 5 min (see src/index.ts) and process.exit(1) if the gateway
  // has been disconnected for too long, letting KeepAlive respawn us.
  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    log.warn("gateway shardDisconnect", {
      shardId,
      code: closeEvent?.code,
      reason: closeEvent?.reason,
    });
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    log.info("gateway shardReconnecting", { shardId });
  });

  client.on(Events.MessageCreate, (msg) => {
    handleMessageCreate(msg, { store, projects }).catch((err) => {
      log.error("messageCreate handler failed", {
        err: String(err),
        messageId: msg.id,
      });
    });
  });

  return client;
}