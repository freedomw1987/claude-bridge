/**
 * Entry point.
 * Loads config, opens DB, starts the Discord client.
 */

import { config } from "./config";
import { log } from "./logger";
import { SessionStore } from "./db";
import { createClient } from "./discord/client";
import { join } from "node:path";
import { killAllProcesses } from "./cleanup";
import { ProjectRegistry } from "./projects/registry";

async function main(): Promise<void> {
  log.info("claude-bridge starting", {
    dataDir: config.paths.dataDir,
    tasksRoot: config.paths.tasksRoot,
    projectsRoot: config.paths.projectsRoot,
    projectsConfig: config.paths.projectsConfig || "(none)",
    channelId: config.discord.channelId,
    allowedUserId: config.discord.allowedUserId,
    logLevel: config.runtime.logLevel,
  });

  const dbPath = join(config.paths.dataDir, "sessions.db");
  const schemaPath = join(import.meta.dir, "db", "schema.sql");

  const store = new SessionStore(dbPath, schemaPath);
  log.info("session store opened", { dbPath });

  const projects = new ProjectRegistry({
    root: config.paths.projectsRoot,
    configPath: config.paths.projectsConfig || undefined,
  });

  const client = createClient({ store, projects });
  await client.login(config.discord.token);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    await killAllProcesses();
    client.destroy();
    store.close();
    log.info("goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: String(err), stack: (err as Error).stack });
  process.exit(1);
});
