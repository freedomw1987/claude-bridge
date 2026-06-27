/**
 * Resume-on-startup logic.
 *
 * Called from `src/index.ts` after the bot starts (gated by
 * `HERMES_RESUME_ON_STARTUP=1`). Reads all Hermes projects on disk
 * and re-fires the orchestrator for any non-terminal ones, plus
 * re-arms auto-mode timers from persisted `expiresAt`.
 *
 * Artifacts-dir helper lives here too (only used by resume + adopt).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ThreadChannel, Message } from "discord.js";
import { log } from "../../logger";
import { appendJournal, listProjects } from "../state";
import { isActive } from "../types";
import { armProjectTimer, softExit } from "./lifecycle";
import { runProject } from "./run";
import { loadState } from "../state";

/**
 * Resume all active projects found on disk. Called from index.ts at boot.
 */
export async function resumeActiveProjects(
  hermesDir: string,
  fetchThread: (
    threadId: string,
  ) => Promise<ThreadChannel | null>,
  resolveClaudeSession?: (threadId: string) => string | null,
  buildUserMsgStub?: (threadId: string) => Message,
): Promise<void> {
  const active = listProjects(hermesDir, { activeOnly: true });
  if (active.length === 0) return;
  log.info("hermes: resuming active projects", { count: active.length });
  for (const state of active) {
    const thread = await fetchThread(state.threadId);
    if (!thread) {
      log.warn("hermes: cannot resume, thread not in cache", {
        projectId: state.id,
        threadId: state.threadId,
      });
      appendJournal(hermesDir, state.id, {
        type: "resume",
        message: "could not resume: thread not in Discord cache",
      });
      continue;
    }
    const userMsgStub = buildUserMsgStub?.(state.threadId);
    if (!userMsgStub) {
      log.warn("hermes: no userMsgStub provider, cannot resume", {
        projectId: state.id,
      });
      continue;
    }
    appendJournal(hermesDir, state.id, {
      type: "resume",
      message: "bot restart; resuming project",
    });
    // ADR-0004 M2.5: if the persisted timer is still in the future,
    // re-arm a setTimeout that calls softExit at the deadline. If the
    // timer already expired during downtime, fire softExit immediately
    // (queueMicrotask inside armProjectTimer handles the "past" case).
    //
    // IMPORTANT: the setTimeout callback re-loads state from disk
    // before calling softExit — the `state` object above is a snapshot
    // and may have moved on by the time the timer fires (e.g., the
    // runProject loop might have already softExited via the judge
    // boundary, or the user might have setMode manual in Discord).
    // Re-loading gives us the freshest view and keeps softExit idempotent.
    const projectId = state.id;
    const threadForTimer = thread;
    armProjectTimer(state, () => {
      const fresh = loadState(hermesDir, projectId);
      if (!fresh) {
        log.warn("hermes: armProjectTimer found no state on disk", {
          projectId,
        });
        return;
      }
      if (!isActive(fresh)) {
        // Project already terminal — nothing to do. Common case: the
        // orchestrator's judge boundary already fired the softExit.
        return;
      }
      softExit(projectId, fresh, {
        hermesDir,
        thread: threadForTimer,
        claudeSession: null,
      }, "duration_expired").catch((err: unknown) => {
        log.error("hermes: armProjectTimer softExit failed", {
          projectId,
          err: String(err),
        });
      });
    });

    // Fire-and-forget; do not await across all projects (one slow project
    // shouldn't block another from starting).
    runProject(state.id, {
      hermesDir,
      thread,
      claudeSession: resolveClaudeSession?.(state.threadId) ?? null,
      userMsgStub,
      resolveClaudeSession,
    }).catch((err) => {
      log.error("hermes: resumed project crashed", {
        projectId: state.id,
        err: String(err),
      });
    });
  }
}

/** Ensure the project's on-disk artifacts directory exists. */
export function ensureArtifactsDir(hermesDir: string, projectId: string): string {
  const dir = join(hermesDir, "projects", projectId, "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}