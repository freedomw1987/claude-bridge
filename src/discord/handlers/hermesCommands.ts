/**
 * Hermes Discord commands.
 *
 * Top-level (in configured channel):
 *   /project start [--mode=auto|manual] [--max-iterations=N] [--max-cost=N] "goal"
 *   /project start in <local-path> [--flags] "goal"
 *   /project list
 *
 * In-thread (within a project thread):
 *   /project status        — show current status
 *   /project plan          — show the plan.md
 *   /project kill          — mark project killed; orchestrator stops on next check
 *   /project resume        — re-run a killed/failed project
 *
 * Slash-prefix matching follows the existing pattern in `commands.ts`
 * (regex on content.trim()), so we don't need to register real slash
 * commands via the Discord API.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import {
  ensureProjectDir,
  listProjects,
  loadState,
  appendJournal,
  resolveHermesDir,
  saveState,
} from "../../hermes/state";
import { isActive } from "../../hermes/types";
import {
  newProjectState,
  type HermesRuntimeConfig,
  type ProjectMode,
} from "../../hermes/types";
import { runProject } from "../../hermes/orchestrator";
import {
  formatPlanMessage,
  formatStatusEmbed,
  HERMES_PREFIX,
} from "../../hermes/discord";
import { abortSdkRun, isSdkRunActive } from "../../agent/sdkRunner";
import type { SessionStore } from "../../db";

// ── Matchers ──────────────────────────────────────────────────────────

/**
 * Strip Discord `<@userId>` mention prefixes. Hermes commands work both
 * with and without a leading @bot mention (e.g. `/project list` or
 * `@bot /project start "..."`). Without stripping, parseMention in the
 * legacy flow interprets `/project` as a local path because it starts
 * with `/`.
 */
function stripMention(content: string): string {
  return content.trim().replace(/<@!?\d+>\s*/g, "").trim();
}

export const isProjectCommand = (content: string): boolean =>
  /^\/project\b/i.test(stripMention(content));

export const matchStart = (content: string): RegExpMatchArray | null =>
  stripMention(content).match(/^\/project\s+start\b\s*([\s\S]*)$/i);

export const matchStatus = (content: string): boolean =>
  /^\/project\s+status\b/i.test(stripMention(content));

export const matchPlan = (content: string): boolean =>
  /^\/project\s+plan\b/i.test(stripMention(content));

export const matchKill = (content: string): boolean =>
  /^\/project\s+kill\b/i.test(stripMention(content));

export const matchResume = (content: string): boolean =>
  /^\/project\s+resume\b/i.test(stripMention(content));

export const matchList = (content: string): boolean =>
  /^\/project\s+list\b/i.test(stripMention(content));

/**
 * Match `/project setMode auto|manual` or `/project setMode=auto|manual`.
 * Returns the mode value if matched, null otherwise.
 */
export const matchSetMode = (content: string): "auto" | "manual" | null => {
  const m = stripMention(content).match(/^\/project\s+setMode(?:\s+|=)(\w+)/i);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === "auto" || v === "manual") return v;
  return null;
};

// ── Top-level handlers ────────────────────────────────────────────────

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
    // created below; for now use a placeholder UUID — we'll update state
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

  const state = newProjectState({
    id: projectId,
    threadId: thread.id,
    goal: parsed.goal,
    mode: parsed.flags.mode ?? "auto",
    repoPath,
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

export async function handleProjectList(msg: Message): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const all = listProjects(hermesDir);
  if (all.length === 0) {
    await msg.reply("📭 No Hermes projects yet.");
    return;
  }
  const lines = [`📋 **Hermes projects (${all.length}):**`];
  for (const s of all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const done = s.plan.filter((t) => t.status === "done").length;
    const total = s.plan.length;
    lines.push(
      `- \`${s.id.slice(0, 8)}\` ${s.status} | ${done}/${total} tasks | $${(s.costUsd / 100).toFixed(2)} | "${s.goal.slice(0, 50)}"`,
    );
  }
  await msg.reply(lines.join("\n"));
}

// ── In-thread handlers ────────────────────────────────────────────────

export async function handleProjectStatus(
  msg: Message,
  threadId: string,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  await msg.reply(formatStatusEmbed(state));
}

export async function handleProjectPlan(
  msg: Message,
  threadId: string,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  if (state.plan.length === 0) {
    await msg.reply(`📋 Plan not generated yet (status=${state.status}).`);
    return;
  }
  await msg.reply(formatPlanMessage(state));
}

export async function handleProjectKill(
  msg: Message,
  threadId: string,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  if (state.status === "done" || state.status === "failed" || state.status === "killed") {
    await msg.reply(`Project is already \`${state.status}\`.`);
    return;
  }
  state.status = "killed";
  state.endedAt = new Date().toISOString();
  saveState(hermesDir, state.id, state);
  // Also abort any in-flight SDK run on this thread so the current
  // Claude Code task stops sooner (instead of running to completion).
  // The orchestrator's main loop also re-reads state.json between
  // iterations, so even without this abort the next iteration would
  // see the killed status and exit; the abort just makes the UX
  // feel snappier.
  const aborted = isSdkRunActive(threadId) ? abortSdkRun(threadId) : false;
  await msg.reply(
    `🛑 Project \`${state.id.slice(0, 8)}\` marked killed.${aborted ? " Aborted current task." : ""}`,
  );
  log.info("hermes: project killed by user", {
    projectId: state.id,
    threadId,
    inFlightAbort: aborted,
  });
}

export async function handleProjectResume(
  msg: Message,
  threadId: string,
  thread: ThreadChannel,
  store: SessionStore,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  if (state.status !== "killed" && state.status !== "failed") {
    await msg.reply(`Project is \`${state.status}\`; nothing to resume.`);
    return;
  }
  // Reset to executing; orchestrator will pick up where it left off.
  state.status = "executing";
  state.endedAt = null;
  saveState(hermesDir, state.id, state);

  const session = store.get(threadId);
  await msg.reply(`${HERMES_PREFIX} 🔄 Resuming project...`);
  runProject(state.id, {
    hermesDir,
    thread,
    claudeSession: session?.claudeSession ?? null,
    userMsgStub: msg,
  }).catch((err) => {
    log.error("hermes: resumed project crashed", {
      projectId: state.id,
      err: String(err),
    });
  });
}

/**
 * Switch a project between auto and manual mode. In manual mode the
 * orchestrator pauses before each task and awaits the Chairman's reply
 * (go/skip/abort) before invoking Claude Code.
 */
export async function handleProjectSetMode(
  msg: Message,
  threadId: string,
  mode: "auto" | "manual",
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  // Mode change is only meaningful for projects that haven't started
  // running yet. For an active project, the dispatcher behavior is
  // already wired (auto: orchestrated; manual: direct Claude Code run).
  // Switching mid-run would leave the orchestrator's local state out of
  // sync with disk. The user can /project kill and /project start again.
  if (isActive(state)) {
    await msg.reply(
      `❌ Cannot change mode while project is \`${state.status}\`. Use \`/project kill\` first, then start a new project with the new mode.`,
    );
    return;
  }
  if (state.mode === mode) {
    await msg.reply(`Project is already in \`${mode}\` mode.`);
    return;
  }
  state.mode = mode;
  saveState(hermesDir, state.id, state);
  appendJournal(hermesDir, state.id, {
    type: "status",
    message: `mode changed → ${mode}`,
  });
  const helpText =
    mode === "manual"
      ? "Goal will be passed directly to Claude Code as a single prompt (no planning, no per-task approval). Replies in this thread will be forwarded as follow-ups."
      : "Hermes will plan tasks, drive Claude Code through each one, and self-assess completion.";
  await msg.reply(`🔧 Project mode → \`${mode}\`. ${helpText}`);
  log.info("hermes: project mode changed", {
    projectId: state.id,
    mode,
  });
}

// ── Top-level dispatcher ──────────────────────────────────────────────

export interface HermesCommandContext {
  msg: Message;
  store: SessionStore;
  /** True if the message came in at the channel top level (not a thread). */
  isTopLevel: boolean;
}

/**
 * Try to handle the message as a /project command.
 * Returns true if handled.
 */
export async function dispatchHermesCommand(
  content: string,
  ctx: HermesCommandContext,
): Promise<boolean> {
  if (!isProjectCommand(content)) return false;
  // The caller (messageCreate.ts) has already stripped any leading
  // @bot mention, so content is clean command text here.
  const trimmed = content.trim();

  // Channel-level commands (work anywhere — top level or thread).
  if (matchList(trimmed)) {
    await handleProjectList(ctx.msg);
    return true;
  }

  // /project start only works at top level.
  const startMatch = matchStart(trimmed);
  if (startMatch) {
    if (!ctx.isTopLevel) {
      await ctx.msg.reply("❌ `/project start` must be invoked in the configured channel, not in a thread.");
      return true;
    }
    await handleProjectStart(ctx.msg, startMatch[1], ctx.store);
    return true;
  }

  // Thread-level commands require the message to be in a project thread.
  if (!ctx.msg.channel.isThread()) {
    await ctx.msg.reply("❌ `/project <subcommand>` requires being in a project thread, except for `/project list` and `/project start`.");
    return true;
  }

  const threadId = ctx.msg.channel.id;

  if (matchStatus(trimmed)) {
    await handleProjectStatus(ctx.msg, threadId);
    return true;
  }
  if (matchPlan(trimmed)) {
    await handleProjectPlan(ctx.msg, threadId);
    return true;
  }
  if (matchKill(trimmed)) {
    await handleProjectKill(ctx.msg, threadId);
    return true;
  }
  if (matchResume(trimmed)) {
    await handleProjectResume(ctx.msg, threadId, ctx.msg.channel as ThreadChannel, ctx.store);
    return true;
  }

  const setMode = matchSetMode(trimmed);
  if (setMode) {
    await handleProjectSetMode(ctx.msg, threadId, setMode);
    return true;
  }

  // Hermes thread consume gate. In AUTO mode + active project, consume
  // any non-/project message so it doesn't fall through to Claude Code
  // (Hermes is orchestrating; replies are not directed at Claude Code).
  // In MANUAL mode (or any terminal status), let messages fall through
  // to forwardToClaude so David can continue the conversation with
  // Claude Code via session resume.
  const hermesDirEarly = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const earlyState = findProjectByThread(hermesDirEarly, threadId);
  if (
    earlyState &&
    earlyState.mode === "auto" &&
    isActive(earlyState)
  ) {
    return true;
  }

  await ctx.msg.reply(
    `❓ Unknown \`/project\` subcommand. Try: \`start\`, \`status\`, \`plan\`, \`kill\`, \`resume\`, \`setMode\`, \`list\`.`,
  );
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────

function findProjectByThread(
  hermesDir: string,
  threadId: string,
): ReturnType<typeof loadState> {
  const projectsRoot = join(hermesDir, "projects");
  if (!existsSync(projectsRoot)) return null;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(projectsRoot)) {
    const s = loadState(hermesDir, entry);
    if (s && s.threadId === threadId) return s;
  }
  return null;
}

interface StartArgs {
  ok: boolean;
  error?: string;
  goal: string;
  localPath?: string;
  flags: {
    mode?: ProjectMode;
    maxIterations?: number;
    maxCostUsd?: number;
    maxWallHours?: number;
    maxAttemptsPerTask?: number;
  };
}

/** Parse `/project start [--flags] [in <path>] "goal"`. */
function parseStartArgs(raw: string): StartArgs {
  const flags: StartArgs["flags"] = {};
  let s = raw.trim();

  // Pull out --key=value flags.
  const flagRe = /--([a-z-]+)(?:=("[^"]*"|\S+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = flagRe.exec(s)) !== null) {
    const key = m[1].toLowerCase();
    let val = m[2] ?? "true";
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    switch (key) {
      case "mode":
        if (val !== "auto" && val !== "manual") {
          return { ok: false, error: `invalid --mode: ${val}`, goal: "", flags };
        }
        flags.mode = val;
        break;
      case "max-iterations":
      case "maxiterations":
        flags.maxIterations = parseIntOr(val);
        break;
      case "max-cost":
      case "maxcostusd":
        flags.maxCostUsd = parseIntOr(val);
        break;
      case "max-wall-hours":
      case "maxwallhours":
        flags.maxWallHours = parseIntOr(val);
        break;
      case "max-attempts":
      case "maxattemptisper-task":
        flags.maxAttemptsPerTask = parseIntOr(val);
        break;
      default:
        return { ok: false, error: `unknown flag: --${key}`, goal: "", flags };
    }
  }
  s = s.replace(flagRe, "").trim();

  // Optional `in <path>` clause.
  let localPath: string | undefined;
  const inMatch = s.match(/^in\s+("[^"]+"|\S+)\s*([\s\S]*)$/i);
  if (inMatch) {
    localPath = inMatch[1];
    if (localPath.startsWith('"') && localPath.endsWith('"')) localPath = localPath.slice(1, -1);
    s = inMatch[2].trim();
  }

  // Remaining text is the goal (must be quoted).
  const goalMatch = s.match(/^"([^"]+)"\s*$/);
  if (!goalMatch) {
    return { ok: false, error: `goal must be wrapped in double quotes`, goal: "", flags };
  }
  const goal = goalMatch[1].trim();
  if (goal.length < 3) {
    return { ok: false, error: `goal too short (min 3 chars)`, goal: "", flags };
  }

  return { ok: true, goal, localPath, flags };
}

function parseIntOr(v: string): number {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

function resolveLocalPath(p: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!p || p.trim() === "") return { ok: false, error: "empty path" };
  // Reject obvious bad chars but allow ~, alphanum, /, -, _, ., =
  if (!/^[~][\w./= -]*$|^[/][\w./= -]*$|^[\w][\w./= -]*$/.test(p)) {
    return { ok: false, error: `invalid characters in path: ${p}` };
  }
  const expanded = p.startsWith("~")
    ? join(process.env.HOME ?? "/", p.slice(1))
    : p;
  return { ok: true, path: expanded };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}