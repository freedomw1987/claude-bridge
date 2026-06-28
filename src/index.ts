/**
 * Entry point.
 * Loads config, opens DB, starts the Discord client.
 */

import { config } from "./config";
import { log } from "./logger";
import { SessionStore } from "./db";
import { createClient } from "./discord/client";
import { join } from "node:path";
import type { ThreadChannel } from "discord.js";
import { killAllProcesses } from "./cleanup";
import { ProjectRegistry } from "./projects/registry";
import { startMemoryMonitor } from "./memoryMonitor";
import { resumeActiveProjects } from "./hermes/orchestrator";
import { resolveHermesDir } from "./hermes/state";
import { startHttpServer } from "./http/state";

const IDLE_SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

// Global error traps — without these, async errors in the Discord handler
// chain get silently swallowed (the .catch() inside client.ts logs them,
// but anything outside that path, e.g. the ws heartbeat tick, can crash
// the process without a trace).  We log + exit so launchd respawns us
// with a clean stack.
//
// See docs/operations/0001-bridge-silent-death.md for the full incident
// writeup (2026-06-21 17:59 HKT — gateway dead, no err, no reply).
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", {
    err: String(reason),
    stack: (reason instanceof Error ? reason.stack : undefined),
  });
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", {
    err: String(err),
    stack: err.stack,
  });
  // Give the logger a tick to flush, then exit so KeepAlive respawns.
  setTimeout(() => process.exit(1), 250);
});

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

  // Internal RSS self-watchdog — defense-in-depth for the long-task
  // memory leak (ADR-0002). Triggers before the OS-level watchdog
  // (scripts/memory-watchdog.sh) so the bot can self-protect even when
  // the OS plist is disabled. Optional trace mode appends every sample
  // to data/ram-trace.log for offline long-task validation.
  const tracePath = config.runtime.ramTraceEnabled
    ? (config.runtime.ramTracePath || join(config.paths.dataDir, "ram-trace.log"))
    : undefined;
  const stopMemoryMonitor = startMemoryMonitor({
    thresholdMB: config.runtime.rssThresholdMB,
    intervalMs: config.runtime.rssSampleIntervalMs,
    tracePath,
  });
  log.info("memory monitor started", {
    thresholdMB: config.runtime.rssThresholdMB,
    intervalMs: config.runtime.rssSampleIntervalMs,
    traceEnabled: !!tracePath,
    tracePath,
  });

  // Hermes: resume any active projects on startup. Reads state.json
  // files and re-fires the orchestrator for non-terminal projects.
  // Gated by HERMES_RESUME_ON_STARTUP (default 1).
  if (config.hermes.resumeOnStartup) {
    const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
    await resumeActiveProjects(
      hermesDir,
      async (threadId) => {
        try {
          const ch = await client.channels.fetch(threadId);
          return ch && ch.isThread() ? (ch as ThreadChannel) : null;
        } catch {
          return null;
        }
      },
      (threadId) => store.get(threadId)?.claudeSession ?? null,
    );
  }

  // P2 backend (Hermes Tracker APP, 2026-06-27). HTTP server bound
  // to 127.0.0.1 only. Disable via HTTP_ENABLED=0 (useful for the
  // bot-only deploys where there's no Tauri/Vite consumer).
  if (config.runtime.httpEnabled) {
    startHttpServer({ store });
  }

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

  // Gateway health probe — every 5 min, check that the Discord ws
  // connection is still alive.  If it has been disconnected for >10 min
  // (i.e. the auto-reconnect logic gave up), exit so launchd KeepAlive
  // respawns the process.  This is the safety net behind the 2026-06-21
  // "bot silently stopped replying" incident.
  const GW_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
  const GW_DISCONNECT_GRACE_MS = 10 * 60 * 1000;
  let firstDisconnectAt: number | null = null;
  setInterval(() => {
    // discord.js exposes ws.status: 0=READY, 1=CONNECTING, 2=RECONNECTING,
    // 3=IDLE, 4=NEARLY, 5=DISCONNECTED, 6=WAITING_FOR_GUILDS, 7=IDENTIFYING,
    // 8=RESUMING. Anything other than 0/2 = not healthy.
    // The `ws` field is internal but stable in v14.
    const status = (client.ws as { status?: number }).status ?? 0;
    if (status === 0 || status === 2) {
      if (firstDisconnectAt !== null) {
        log.info("gateway recovered", { status, wasDownForMs: Date.now() - firstDisconnectAt });
      }
      firstDisconnectAt = null;
      return;
    }
    if (firstDisconnectAt === null) {
      firstDisconnectAt = Date.now();
      log.warn("gateway unhealthy", { status });
      return;
    }
    const downFor = Date.now() - firstDisconnectAt;
    if (downFor > GW_DISCONNECT_GRACE_MS) {
      log.error("gateway dead beyond grace", {
        status,
        downForMs: downFor,
        graceMs: GW_DISCONNECT_GRACE_MS,
      });
      setTimeout(() => process.exit(1), 250);
    }
  }, GW_HEALTH_INTERVAL_MS);
  log.info("gateway health probe started", {
    intervalMs: GW_HEALTH_INTERVAL_MS,
    graceMs: GW_DISCONNECT_GRACE_MS,
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    if (idleSweep) clearInterval(idleSweep);
    stopMemoryMonitor();
    // G3 (2026-06-27): post a "bot restarting" warning to each thread
    // with in-flight SDK work BEFORE the abort. The notifier uses
    // client.channels.fetch() which is async-safe — we catch per-thread
    // errors inside killAllProcesses so a Discord hiccup doesn't block
    // shutdown. The grace period (SHUTDOWN_GRACE_MS, default 30s)
    // lets short Claude turns finish naturally.
    await killAllProcesses({
      notifier: async (threadId, message) => {
        try {
          const ch = await client.channels.fetch(threadId);
          if (ch && ch.isThread()) {
            await (ch as ThreadChannel).send(message);
          }
        } catch (err) {
          // Swallow — Discord unreachable shouldn't block shutdown.
          log.warn("shutdown: failed to notify thread", {
            threadId,
            err: String(err),
          });
        }
      },
    });
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
