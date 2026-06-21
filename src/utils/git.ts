/**
 * Git helpers — host side, before a container starts.
 */

import { existsSync } from "node:fs";
import { log } from "../logger";

/**
 * Clone a git repo into `dest`. Skips if already cloned (idempotent).
 * Times out after `timeoutMs` (default 5 min) and kills the process on timeout.
 *
 * @throws if the process exits non-zero or times out
 */
export async function gitClone(
  url: string,
  dest: string,
  timeoutMs: number = 5 * 60 * 1000,
): Promise<void> {
  if (existsSync(`${dest}/.git`)) {
    log.info("repo already cloned, skipping", { dest });
    return;
  }
  log.info("cloning repo", { url, dest, timeoutMs });
  const proc = Bun.spawn({
    cmd: ["git", "clone", url, dest],
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race<number>([
      proc.exited,
      new Promise<number>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          // Kill the child — Bun.spawn().kill() returns boolean, ignore
          try {
            proc.kill();
          } catch {
            // Already dead
          }
          reject(
            new Error(
              `git clone timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    const stderrText = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`git clone failed (exit ${exitCode}): ${stderrText.trim()}`);
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
