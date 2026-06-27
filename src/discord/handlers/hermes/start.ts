/**
 * `/project start` — create a new Hermes-managed project.
 *
 * Creates a Discord thread, writes a fresh ProjectState to disk, creates
 * a SQLite session row (so the thread can later accept /kill / setMode),
 * and kicks off the orchestrator async.
 *
 * Usage:
 *   /project start [--mode=auto|manual] [in <path>] "goal"
 *
 * See `matchers.ts:matchStart` for input parsing and
 * `helpers.ts:parseStartArgs` for the full grammar.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../../config";
import { log } from "../../../logger";
import {
  ensureProjectDir,
  resolveHermesDir,
  saveState,
} from "../../../hermes/state";
import {
  newProjectState,
  type HermesRuntimeConfig,
} from "../../../hermes/types";
import { runProject } from "../../../hermes/orchestrator";
import { resolveProjectRoot } from "../../../hermes/projectIdentity";
import { parseStartArgs, resolveLocalPath, truncate } from "./helpers";
import type { SessionStore } from "../../../db";

export async function handleProjectStart(
  msg: Message,
  args: string,
  store: SessionStore,
): Promise<void> {
  const parsed = parseStartArgs(args);
  if (!parsed.ok) {
    await msg.reply(`❌ ${parsed.error}\n\nUsage: \`/project start [--mode=auto|manual] [in <path>] "goal"\``);
    return;
  }

  // Resolve working directory.
  let repoPath: string;
  let repoSource: "new" | "clone" | "local";
  if (parsed.localPath) {
    // Validate path.
    const resolved = resolveLocalPath(parsed.localPath);
    if (!resolved.ok) {
      await msg.reply(`❌ ${resolved.error}`);
      return;
    }
    if (!existsSync(resolved.path)) {
      await msg.reply(`❌ Path does not exist: \`${resolved.path}\``);
      return;
    }
    repoPath = resolved.path;
    repoSource = "local";
  } else {
    // Default: a fresh dir under TASKS_ROOT/<thread-id>. The thread is
    // created below; for now use a placeholder — we'll update state
    // after the thread is created.
    repoPath = join(config.paths.tasksRoot, "pending"); // overwritten after thread creation
    repoSource = "new";
  }

  // Create thread.
  let thread: ThreadChannel;
  try {
    thread = await msg.startThread({
      name: `📋 ${truncate(parsed.goal, 80)}`,
      autoArchiveDuration: 60,
      reason: "hermes project thread",
    });
  } catch (err) {
    log.error("hermes: failed to create project thread", { err: String(err) });
    await msg.reply("❌ Failed to create thread for project.");
    return;
  }

  // For "new" projects, the actual repo path depends on the thread ID.
  if (repoSource === "new") {
    repoPath = join(config.paths.tasksRoot, thread.id);
    mkdirSync(repoPath, { recursive: true });
  }

  // Build runtime config from CLI overrides + defaults.
  const runtime: HermesRuntimeConfig = {
    maxIterations: parsed.flags.maxIterations ?? config.hermes.maxIterations,
    maxCostUsd: parsed.flags.maxCostUsd ?? config.hermes.maxCostUsd,
    maxWallHours: parsed.flags.maxWallHours ?? config.hermes.maxWallHours,
    hermesModel: config.hermes.model,
    maxAttemptsPerTask: parsed.flags.maxAttemptsPerTask ?? config.hermes.maxAttemptsPerTask,
  };

  const projectId = randomUUID();
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  ensureProjectDir(hermesDir, projectId);

  // RG-007: capture the git toplevel as the project's identity key.
  // If the path is not a git working tree, fall back to the absolute
  // path (resolveProjectRoot handles the git failure gracefully).
  const repoRoot = await resolveProjectRoot(repoPath);

  const state = newProjectState({
    id: projectId,
    threadId: thread.id,
    goal: parsed.goal,
    mode: parsed.flags.mode ?? "auto",
    repoPath,
    repoRoot,
    repoSource,
    config: runtime,
  });
  saveState(hermesDir, projectId, state);

  // Create a SQLite session for this thread so David's `go` / `skip`
  // replies aren't rejected by messageCreate's "no session" check.
  // Without this, manual-mode approval would fail because messageCreate
  // sees `go` as a reply without a session.
  store.create({
    threadId: thread.id,
    channelId: config.discord.channelId,
    repoUrl: null,
    localPath: repoSource === "local" ? repoPath : null,
    repoPath,
  });

  log.info("hermes: project created", {
    projectId,
    threadId: thread.id,
    mode: state.mode,
    repoPath,
    repoSource,
  });

  // Post initial message + planning kickoff.
  await thread.send(
    [
      `🎯 **Hermes project started**`,
      `Project: \`${projectId.slice(0, 8)}\``,
      `Mode: \`${state.mode}\` | Repo: \`${repoPath}\` (${repoSource})`,
      `Budget: $${(runtime.maxCostUsd / 100).toFixed(2)} | Max iters: ${runtime.maxIterations} | Wall: ${runtime.maxWallHours}h`,
      ``,
      `📋 Planning...`,
    ].join("\n"),
  );

  // Run the orchestrator async (do not await — let the message handler return).
  runProject(projectId, {
    hermesDir,
    thread,
    claudeSession: null,
    userMsgStub: msg,
  }).catch((err) => {
    log.error("hermes: orchestrator crashed on start", {
      projectId,
      err: String(err),
    });
  });
}