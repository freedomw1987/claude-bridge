/**
 * Project + target resolution handlers.
 *
 * - `sendProjectsList` — list all known projects (for /projects)
 * - `applyTarget` — handle /repo <url|path|name>: resolve to a project,
 *   validate a local path, or accept a git URL and trigger clone
 * - `ensureRepoReady` — clone the repo if needed before a Claude run
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import { gitClone } from "../../utils/git";
import { taskRepoPath } from "../../utils/path";
import { isValidRepoUrl, isValidLocalPath, isLocalPathString } from "../parser";
import { truncate } from "./format";
import type { ProjectRegistry } from "../../projects/registry";
import type { SessionStore } from "../../db";

export async function sendProjectsList(
  msg: Message,
  projects: ProjectRegistry,
): Promise<void> {
  const all = projects.list();
  if (all.length === 0) {
    await msg.reply(
      `📁 No projects found in \`${projects.rootPath()}\`\n` +
        `Set \`PROJECTS_ROOT\` env var to scan a different directory.`,
    );
    return;
  }
  const max = 30;
  const lines = all.slice(0, max).map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``);
  let body =
    `📁 **Projects** (from \`${projects.rootPath()}\`, ${all.length} total)\n` +
    lines.join("\n");
  if (all.length > max) body += `\n… and ${all.length - max} more`;
  body += `\n\nUse: \`@bot <msg> in <name>\``;
  await msg.reply(body);
}

export async function applyTarget(
  msg: Message,
  threadId: string,
  target: string,
  store: SessionStore,
  projects: ProjectRegistry,
): Promise<void> {
  const project = projects.resolve(target);
  if (project) {
    store.setLocalPath(threadId, project.name, project.path);
    await msg.reply(
      `✅ Project: **${project.name}**\nMounted: \`${project.path}\``,
    );
    return;
  }

  if (isLocalPathString(target)) {
    const v = isValidLocalPath(target);
    if (!v.ok) {
      await msg.reply(`❌ Invalid local path: ${v.error}`);
      return;
    }
    store.setLocalPath(threadId, target, v.resolved!);
    await msg.reply(`✅ Local path: \`${target}\` → \`${v.resolved}\``);
    return;
  }

  if (!isValidRepoUrl(target)) {
    await msg.reply(
      `❌ Not a valid repo URL, project name, or local path: \`${target}\``,
    );
    return;
  }
  store.setRepoUrl(threadId, target);
  const newRepoPath = taskRepoPath(config.paths.tasksRoot, threadId);
  if (newRepoPath !== store.get(threadId)!.repoPath) {
    store.setLocalPath(threadId, "", newRepoPath);
  }
  const fresh = store.get(threadId)!;
  await ensureRepoReady(msg.channel as ThreadChannel, fresh);
}

export async function ensureRepoReady(
  thread: ThreadChannel,
  session: ReturnType<SessionStore["get"]> & object,
): Promise<boolean> {
  if (session.localPath || (!session.repoUrl && session.repoPath)) {
    return true;
  }
  if (!session.repoUrl) return false;
  try {
    const timeoutMs = config.runtime.gitCloneTimeoutMin * 60 * 1000;
    await gitClone(session.repoUrl, session.repoPath, timeoutMs);
    log.info("repo ready", { path: session.repoPath });
    return true;
  } catch (err) {
    log.error("git clone failed", { err: String(err), url: session.repoUrl });
    await thread.send(`❌ git clone failed: \`${truncate(String(err), 200)}\``);
    return false;
  }
}
