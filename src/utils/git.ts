/**
 * Git helpers — host side, before a container starts.
 */

import { existsSync } from "node:fs";
import { log } from "../logger";

export async function gitClone(url: string, dest: string): Promise<void> {
  if (existsSync(`${dest}/.git`)) {
    log.info("repo already cloned, skipping", { dest });
    return;
  }
  log.info("cloning repo", { url, dest });
  const proc = Bun.spawn({
    cmd: ["git", "clone", url, dest],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderrText = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`git clone failed (exit ${exitCode}): ${stderrText.trim()}`);
  }
}