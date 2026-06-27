/**
 * `/project adopt "<goal>" [auto|manual] [duration]` (RG-004).
 *
 * Adopt an existing plain Claude Code session thread into a Hermes-managed
 * project. David's preferred flow: chat with `@bot` first to discuss
 * requirements, then `/project adopt "<goal>"` once the goal is clear.
 *
 * Validates (in order):
 *  1. thread has a Claude Code session in `sessions.db` (no session → reject)
 *  2. thread has no existing Hermes project (soft-reject with goal preview)
 *  3. duration string parses to ms (auto only; manual ignores duration)
 *  4. duration ≤ maxWallHours (clamp + "capped" message)
 *
 * On success: builds ProjectAdoption, calls adoptProject to persist
 * state + journal, arms the wallclock timer if auto, kicks off the
 * orchestrator (which sends the initial plan kickoff message).
 *
 * RG-007: also scans for active Hermes projects on the same `repoRoot`
 * (git toplevel) and soft-kills them BEFORE creating the new project
 * — invariant "one repo, one Hermes project at a time". The old project's
 * state.json is preserved (status=killed, supersededBy=newId) so a
 * future `/project resume` can recover it.
 */

import { randomUUID } from "node:crypto";
import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../../config";
import { log } from "../../../logger";
import {
  appendJournal,
  loadState,
  resolveHermesDir,
  saveState,
} from "../../../hermes/state";
import {
  isActive,
  type HermesRuntimeConfig,
  type ProjectState,
} from "../../../hermes/types";
import {
  adoptProject,
  armProjectTimer,
  runProject,
  softExit,
} from "../../../hermes/orchestrator";
import { abortSdkRun, isSdkRunActive } from "../../../agent/sdkRunner";
import { parseDuration } from "../../../hermes/duration";
import { resolveProjectRoot } from "../../../hermes/projectIdentity";
import { listProjects } from "../../../hermes/state";
import { findProjectByThread } from "./helpers";
import type { SessionStore } from "../../../db";

/**
 * Scan all Hermes projects on disk and return the active ones whose
 * `repoRoot` matches. Used by `/project adopt` to find projects that
 * need to be auto-killed before the new project is created.
 *
 * The match is exact-string equality — we do NOT do path-prefix matching
 * here, because resolveProjectRoot already collapsed monorepo sub-folders
 * to their git toplevel.
 *
 * Active = status ∈ {planning, executing, judging}. Killed / failed /
 * done projects are NOT conflicts and are skipped (their state is
 * preserved on disk for later `/project resume`).
 */
async function findConflictingProjects(
  hermesDir: string,
  repoRoot: string,
  excludeId: string,
): Promise<ProjectState[]> {
  const all = listProjects(hermesDir);
  const conflicts: ProjectState[] = [];
  for (const s of all) {
    if (s.id === excludeId) continue;
    if (!isActive(s)) continue;
    if (s.repoRoot !== repoRoot) continue;
    conflicts.push(s);
  }
  return conflicts;
}

export async function handleProjectAdopt(
  msg: Message,
  threadId: string,
  thread: ThreadChannel,
  store: SessionStore,
  args: { goal: string; mode: "auto" | "manual"; duration?: string },
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);

  // 1. Pre-flight: must have a Claude Code session in this thread.
  const session = store.get(threadId);
  if (!session) {
    await msg.reply(
      `❌ No Claude Code session in this thread. Start one with \`@bot <prompt>\` first, then \`/project adopt\`.`,
    );
    return;
  }

  // 2. Pre-flight: no existing Hermes project on this thread.
  const existing = findProjectByThread(hermesDir, threadId);
  if (existing) {
    const goalPreview = existing.goal.length > 60
      ? existing.goal.slice(0, 60) + "…"
      : existing.goal;
    await msg.reply(
      `⚠️ This thread already has a Hermes project (\`goal: ${goalPreview}\`, status=${existing.status}). ` +
        `To re-adopt, kill it first with \`/project kill\`, or use \`/project setMode\` to change mode.`,
    );
    return;
  }

  // 3. Parse + clamp duration (auto only).
  let effectiveMs: number | null = null;
  let requestedDuration: string | undefined = args.duration;
  let clamped = false;
  if (args.mode === "auto") {
    const capMs = config.hermes.maxWallHours * 60 * 60 * 1000;
    if (args.duration !== undefined) {
      const parsed = parseDuration(args.duration);
      if (parsed === null) {
        await msg.reply(
          `❌ Cannot parse duration: \`${args.duration}\`. Try "30m" / "2h" / "1d" / "1h30m".`,
        );
        return;
      }
      effectiveMs = parsed;
    } else {
      effectiveMs = capMs;
      requestedDuration = `${config.hermes.maxWallHours}h (default)`;
    }
    if ((effectiveMs ?? 0) > capMs) {
      effectiveMs = capMs;
      clamped = true;
    }
  }

  // 4. Build the project state.
  const projectId = randomUUID();
  const runtime: HermesRuntimeConfig = {
    maxIterations: config.hermes.maxIterations,
    maxCostUsd: config.hermes.maxCostUsd,
    maxWallHours: config.hermes.maxWallHours,
    hermesModel: config.hermes.model,
    maxAttemptsPerTask: config.hermes.maxAttemptsPerTask,
  };

  // RG-007: resolve the git toplevel of the incoming session's repo
  // path. This is the project's identity key for collision detection.
  // Monorepo sub-folders collapse to the same identity — adopting
  // `~/www/X/apps/api` while `~/www/X/apps/web` has a live Hermes
  // project is treated as a conflict on `~/www/X`.
  const repoRoot = await resolveProjectRoot(session.repoPath);

  // RG-007: scan for any other active Hermes projects on the same
  // repoRoot. If any exist, soft-kill them BEFORE creating the new
  // project (sequential: scan → kill → wait → adopt, per the Q3
  // decision). This implements David's invariant: "one repo, one
  // Hermes project at a time". The old project's state.json is
  // preserved on disk (status=killed, supersededBy=newId) so a
  // future `/project resume` can recover it.
  const conflictingProjects = await findConflictingProjects(
    hermesDir,
    repoRoot,
    projectId, // exclude this id (defensive; we haven't created it yet)
  );
  for (const oldState of conflictingProjects) {
    try {
      // Abort any in-flight SDK run on the old project's thread so
      // the kill feels snappy instead of waiting for the next
      // iteration check. abortSdkRun is a no-op if no run is active.
      if (isSdkRunActive(oldState.threadId)) {
        abortSdkRun(oldState.threadId);
      }
      // softExit handles: status flip, endedAt, journal entry,
      // timer clear, Discord notification, and state save. We
      // stamp supersededBy AFTER softExit saves so the kill
      // reason reads as "auto-mode duration expired" rather
      // than "superseded" — we add a second journal entry to
      // make the supersede relationship explicit.
      await softExit(oldState.id, oldState, {
        hermesDir,
        thread: thread, // any thread works; softExit only uses it for .send
        claudeSession: null,
      }, "manual_switch"); // reuse the manual_switch kill reason
      // Reload to get the just-saved state, then stamp supersededBy.
      const reloaded = loadState(hermesDir, oldState.id);
      if (reloaded) {
        reloaded.supersededBy = projectId;
        reloaded.killedReason = "manual_switch"; // keep
        saveState(hermesDir, oldState.id, reloaded);
        appendJournal(hermesDir, oldState.id, {
          type: "status",
          message: `superseded by new /project adopt (newId=${projectId.slice(0, 8)}, repoRoot=${repoRoot})`,
        });
      }
      log.info("hermes: RG-007 supersede-killed old project", {
        oldProjectId: oldState.id,
        oldThreadId: oldState.threadId,
        newProjectId: projectId,
        repoRoot,
      });
    } catch (err) {
      // One kill must not abort the adopt chain. Log and continue.
      log.error("hermes: RG-007 failed to supersede-kill old project", {
        oldProjectId: oldState.id,
        err: String(err),
      });
    }
  }

  const state = adoptProject({
    hermesDir,
    projectId,
    threadId,
    goal: args.goal,
    mode: args.mode,
    repoPath: session.repoPath,
    repoRoot,
    repoSource: "local", // adopt always targets an existing local CC session
    config: runtime,
    adoption: {
      fromSession: true,
      adoptedAt: new Date().toISOString(),
      originalRepoPath: session.repoPath,
      originalSessionId: session.claudeSession ?? "<no-session-id>",
    },
  });

  // 5. If auto, arm a wallclock timer (mirrors handleProjectStart/setMode).
  if (args.mode === "auto") {
    state.timer = {
      expiresAt: Date.now() + (effectiveMs ?? config.hermes.maxWallHours * 60 * 60 * 1000),
      requestedDuration: requestedDuration ?? `${config.hermes.maxWallHours}h (default)`,
      effectiveMs: effectiveMs ?? config.hermes.maxWallHours * 60 * 60 * 1000,
      clamped,
      // handle set by armProjectTimer below
    };
    saveState(hermesDir, state.id, state);
    armProjectTimer(state, () => {
      const fresh = loadState(hermesDir, state.id);
      if (!fresh || !isActive(fresh)) return;
      softExit(state.id, fresh, {
        hermesDir,
        thread,
        claudeSession: null,
      }, "duration_expired").catch((err) => {
        log.error("hermes: handleProjectAdopt timer softExit failed", {
          projectId: state.id,
          err: String(err),
        });
      });
    });
  }

  log.info("hermes: project adopted", {
    projectId,
    threadId,
    mode: state.mode,
    repoPath: state.repoPath,
    repoRoot,
    adoptedFromSessionId: state.adoption?.originalSessionId,
    supersededCount: conflictingProjects.length,
  });

  // 6. Post kickoff message + run orchestrator (mirror handleProjectStart).
  const capNote = clamped
    ? ` (capped at ${config.hermes.maxWallHours}h — the safety cap)`
    : "";
  const timerLine = args.mode === "auto"
    ? `\nTimer: \`${state.timer?.requestedDuration ?? `${config.hermes.maxWallHours}h`}\`${capNote}.`
    : "";
  // RG-007: if we supersede-killed any old projects, surface that to
  // the user in the kickoff message so they know what happened. This
  // is informational, not a confirmation prompt — the kill already
  // happened by the time the message posts.
  const supersedeLine = conflictingProjects.length > 0
    ? `\n⚠️ Superseded ${conflictingProjects.length} existing project(s) on \`${repoRoot}\`: ${
        conflictingProjects.map((c) => `\`${c.id.slice(0, 8)}\``).join(", ")
      } (killed, state preserved on disk).`
    : "";
  await thread.send(
    [
      `🎯 **Hermes project adopted** (from existing CC session)`,
      `Project: \`${projectId.slice(0, 8)}\``,
      `Mode: \`${state.mode}\` | Repo: \`${state.repoPath}\` (local, adopted)${timerLine}`,
      `Budget: $${(runtime.maxCostUsd / 100).toFixed(2)} | Max iters: ${runtime.maxIterations} | Wall: ${runtime.maxWallHours}h`,
      ``,
      `📋 Planning...${supersedeLine}`,
    ].join("\n"),
  );

  // Fire-and-forget: let the message handler return immediately so the
  // user's /project adopt message gets an ack. The orchestrator posts
  // the plan and per-task messages asynchronously.
  runProject(projectId, {
    hermesDir,
    thread,
    claudeSession: session.claudeSession ?? null,
    userMsgStub: msg,
  }).catch((err) => {
    log.error("hermes: adopted project orchestrator crashed", {
      projectId,
      err: String(err),
    });
  });
}