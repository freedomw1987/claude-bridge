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

const IDLE_SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

async function main(): Promise<void> {
  log.info("claude-bridge starting", {
    dataDir: config.paths.dataDir,
    tasksRoot: config.paths.tasksRoot,
    projectsRoot: config.paths.projectsRoot,
    projectsConfig: config.paths.projectsConfig || "(none)",
    channelId: config.discord.channelId,
    allowedUserId: config.discord.allowedUserId,
    logLevel: config.runtime.logLevel,
    maxConcurrent: config.runtime.maxConcurrentContainers,
    idleTimeoutMin: config.runtime.idleTimeoutMin,
    gitCloneTimeoutMin: config.runtime.gitCloneTimeoutMin,
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

  // Idle sweep: mark active sessions as 'idle' if last_activity_at is older
  // than IDLE_TIMEOUT_MIN. Skipped when IDLE_TIMEOUT_MIN=0 (disabled).
  let idleSweep: ReturnType<typeof setInterval> | null = null;
  if (config.runtime.idleTimeoutMin > 0) {
    const runSweep = () => {
      const threshold = Date.now() - config.runtime.idleTimeoutMin * 60 * 1000;
      const stale = store.findStale({ idleSinceMs: threshold });
      for (const s of stale) {
        log.info("marking session idle (timeout)", {
          threadId: s.threadId,
          lastActivityAt: s.lastActivityAt,
        });
        store.setStatus(s.threadId, "idle");
      }
      if (stale.length > 0) {
        log.info("idle sweep done", { marked: stale.length });
      }
    };
    idleSweep = setInterval(runSweep, IDLE_SWEEP_INTERVAL_MS);
    log.info("idle sweep started", {
      intervalMs: IDLE_SWEEP_INTERVAL_MS,
      timeoutMin: config.runtime.idleTimeoutMin,
    });
  } else {
    log.info("idle sweep disabled (IDLE_TIMEOUT_MIN=0)");
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    if (idleSweep) clearInterval(idleSweep);
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
