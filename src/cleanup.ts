/**
 * Active SDK run tracking + graceful shutdown.
 *
 * Phase 3 (2026-06-27): the CLI subprocess runner was retired, so this
 * file no longer needs to track raw PIDs. `activeProcessCount()` is now
 * a thin wrapper around `activeSdkRunCount()` from sdkRunner.ts,
 * re-exported so the streaming layer doesn't need to know which runner
 * is in use.
 *
 * G1 (2026-06-27): `killAllProcesses()` is reordered so the grace
 * period happens BEFORE the abort, not after. Previously the code
 * called `abortAllSdkRuns()` first and then waited 2s — but aborting
 * immediately means the wait did nothing useful. Now we wait first
 * (configurable grace, default 30s) and then abort anything still
 * running. Short Claude turns get to finish naturally during the
 * grace; long runs are forcibly aborted at the end.
 *
 * G3 (2026-06-27): graceful shutdown also accepts an optional
 * `notifier` callback that gets called once per active thread at
 * the start of shutdown. `index.ts` uses this to post a Discord
 * message ("⚠️ Bot restarting in Ns, your run will be saved...")
 * to each thread with in-flight work, so David isn't surprised by
 * an abrupt "🛑 Run aborted".
 */

import { log } from "./logger";
import {
  abortAllSdkRuns,
  activeSdkRunCount,
  getActiveSdkRunIds,
} from "./agent/sdkRunner";
import { config } from "./config";

/**
 * Total in-flight Claude Code runs (SDK only — Phase 3).
 * Used by MAX_CONCURRENT_CONTAINERS enforcement in streaming.ts.
 */
export function activeProcessCount(): number {
  return activeSdkRunCount();
}

/**
 * G3: callback invoked once per thread with in-flight SDK work at
 * the start of graceful shutdown. The caller (typically index.ts) is
 * responsible for posting to Discord via `client.channels.fetch(id)`.
 * Failures in the notifier are logged but do NOT abort the shutdown
 * sequence — Discord being unreachable shouldn't prevent cleanup.
 */
export type ShutdownNotifier = (
  threadId: string,
  message: string,
) => Promise<void>;

export interface KillAllProcessesOpts {
  /**
   * Optional callback to notify each thread with in-flight work that
   * a shutdown is in progress. Skipped if undefined (e.g., in tests).
   */
  notifier?: ShutdownNotifier;
  /**
   * Override `config.runtime.shutdownGraceMs`. Defaults to the config
   * value (SHUTDOWN_GRACE_MS env, 30000 by default).
   */
  graceMs?: number;
}

/**
 * Graceful shutdown sequence (G1):
 *   1. Snapshot currently-active thread IDs (callers iterate this safe
 *      list even if a run completes mid-shutdown).
 *   2. Notify each (via notifier) with a restart warning.
 *   3. Wait `graceMs`. SDK runs that finish naturally during this time
 *      are left alone; the abort at the end only catches survivors.
 *   4. Abort any remaining runs and give them a brief tick to exit.
 */
export async function killAllProcesses(opts: KillAllProcessesOpts = {}): Promise<void> {
  const sdkCount = activeSdkRunCount();
  if (sdkCount === 0) {
    log.debug("shutdown: no in-flight SDK runs, exiting immediately");
    return;
  }

  const graceMs = opts.graceMs ?? config.runtime.shutdownGraceMs;
  const graceSec = Math.round(graceMs / 1000);
  log.info("graceful shutdown initiated", { sdkCount, graceSec });

  // Step 1: snapshot thread IDs (stable for the duration of this fn).
  const threadIds = getActiveSdkRunIds();

  // Step 2: notify each thread. Errors are logged but don't block shutdown.
  if (opts.notifier) {
    const message =
      `⚠️ Bot restarting in ${graceSec}s. Your current Claude run will be ` +
      `saved automatically — just send a new message after the restart ` +
      `to resume. Use \`/kill\` to abort immediately.`;
    for (const threadId of threadIds) {
      try {
        await opts.notifier(threadId, message);
      } catch (err) {
        log.warn("shutdown: notifier failed", { threadId, err: String(err) });
      }
    }
  }

  // Step 3: grace period — let natural completions happen.
  await new Promise<void>((r) => setTimeout(r, graceMs));

  // Step 4: abort any survivors + tick for them to actually exit.
  await abortAllSdkRuns();
  await new Promise<void>((r) => setTimeout(r, 50));
}