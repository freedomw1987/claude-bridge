/**
 * Project identity resolution (RG-007).
 *
 * A "project" for the purpose of `/project adopt` collision detection
 * is identified by its git toplevel, not its working directory.
 * This means monorepo sub-folders (e.g. `~/www/crm-system/apps/api`
 * and `~/www/crm-system/apps/web`) are treated as the same project
 * — adopting one will supersede the other. Two unrelated repos
 * (e.g. `~/www/crm-system` and `~/www/aged-system`) stay independent.
 *
 * Falls back to the input path if `git rev-parse --show-toplevel`
 * fails (e.g. the path is not inside a git working tree). This is
 * intentional — we want the identity check to be conservative
 * (over-merging is safer than under-merging for the "kill old" flow,
 * because an unrelated repo cannot share a toplevel with a related one
 * by accident).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";

const execFileP = promisify(execFile);

/**
 * Resolve the git toplevel of `repoPath`, or return the absolute
 * `repoPath` itself if it's not inside a git working tree.
 *
 * Always returns an absolute path. Relative inputs are resolved
 * against `process.cwd()` first (Node's default), which is the
 * expected behavior for Discord commands since the bot CWD is
 * stable.
 */
export async function resolveProjectRoot(repoPath: string): Promise<string> {
  const abs = resolvePath(repoPath);
  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: abs, timeout: 3000 },
    );
    const top = stdout.trim();
    if (top) return top;
  } catch {
    // git failed (not a repo, no git binary, timeout) — fall through.
  }
  return abs;
}
