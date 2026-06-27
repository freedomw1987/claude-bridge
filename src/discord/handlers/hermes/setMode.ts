/**
 * `/project setMode auto [duration]` and `/project setMode manual`.
 *
 * ADR-0004 behavior:
 * - `setMode manual`: cancels any active auto-mode timer and either
 *   softExits an active project (killedReason="manual_switch") or just
 *   switches mode for a terminal one.
 * - `setMode auto [duration]`: arms a wallclock timer. If the project is
 *   already active (planning/executing/judging), the new timer replaces
 *   any existing one. If the project is terminal (killed/failed/done,
 *   e.g. from a prior manual switch that ran softExit), the orchestrator
 *   is automatically resumed so the user doesn't have to also type
 *   `/project resume` — see RG-006.
 * - Duration defaults to HERMES_MAX_WALL_HOURS (the safety cap).
 *   The user-set value is clamped to the cap; we surface a "Capped at X"
 *   message when clamping occurs.
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../../config";
import { log } from "../../../logger";
import {
  appendJournal,
  loadState,
  resolveHermesDir,
  saveState,
} from "../../../hermes/state";
import { isActive } from "../../../hermes/types";
import {
  armProjectTimer,
  runProject,
  softExit,
} from "../../../hermes/orchestrator";
import { parseDuration } from "../../../hermes/duration";
import { findProjectByThread } from "./helpers";
import type { SessionStore } from "../../../db";

export async function handleProjectSetMode(
  msg: Message,
  threadId: string,
  mode: "auto" | "manual",
  durationRaw?: string,
  store?: SessionStore,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }

  // ── Parse + clamp duration (auto only) ──────────────────────────
  let effectiveMs: number | null = null;
  let requestedDuration: string | undefined = durationRaw;
  let clamped = false;
  if (mode === "auto") {
    const capMs = config.hermes.maxWallHours * 60 * 60 * 1000;
    if (durationRaw !== undefined) {
      const parsed = parseDuration(durationRaw);
      if (parsed === null) {
        await msg.reply(
          `❌ Cannot parse duration: \`${durationRaw}\`. Try "30m" / "2h" / "1d" / "1h30m".`,
        );
        return;
      }
      effectiveMs = parsed;
    } else {
      // Default to the safety cap
      effectiveMs = capMs;
      requestedDuration = `${config.hermes.maxWallHours}h (default)`;
    }
    if ((effectiveMs ?? 0) > capMs) {
      effectiveMs = capMs;
      clamped = true;
    }
  }

  // ── Switch to manual ────────────────────────────────────────────
  if (mode === "manual") {
    // Always clear the existing timer (whether active or terminal).
    const hadTimer = state.timer !== undefined;
    if (state.timer?.handle) {
      clearTimeout(state.timer.handle);
    }
    if (hadTimer) {
      appendJournal(hermesDir, state.id, {
        type: "timer",
        message: "timer cancelled (manual switch)",
      });
    }
    // If active, soft-exit so the orchestrator loop bails at the next
    // judge pass. We pass the current state (post-clearTimer mutation
    // is handled inside softExit).
    if (isActive(state)) {
      const activeState = state;
      // softExit mutates and saves; we need to refresh our local state
      // pointer to match.
      const updated = await softExit(state.id, activeState, {
        hermesDir,
        thread: msg.channel as ThreadChannel,
        claudeSession: null,
      }, "manual_switch");
      state.status = updated.status;
      state.killedReason = updated.killedReason;
      state.endedAt = updated.endedAt;
      state.timer = updated.timer;
    } else {
      // Terminal — just record the mode flip.
      state.mode = "manual";
      saveState(hermesDir, state.id, state);
      appendJournal(hermesDir, state.id, {
        type: "status",
        message: "mode changed → manual (terminal project)",
      });
    }
    await msg.reply(
      `🔧 Project mode → \`manual\`. ${hadTimer ? "Auto-mode timer cancelled. " : ""}` +
        `Goal will be passed directly to Claude Code as a single prompt (no planning, no per-task approval).`,
    );
    log.info("hermes: project mode changed to manual", {
      projectId: state.id,
      hadTimer,
    });
    return;
  }

  // ── Switch to auto [duration] ───────────────────────────────────
  if (state.mode === "auto" && state.timer) {
    // Same mode + already has a timer → replace the timer.
    if (state.timer.handle) {
      clearTimeout(state.timer.handle);
    }
    appendJournal(hermesDir, state.id, {
      type: "timer",
      message: `timer replaced (was ${state.timer.requestedDuration})`,
    });
  }
  // Persist the new timer BEFORE arming so a crash mid-arm doesn't leave
  // a "set but not stored" state.
  state.mode = "auto";
  state.timer = {
    expiresAt: Date.now() + (effectiveMs ?? config.hermes.maxWallHours * 60 * 60 * 1000),
    requestedDuration: requestedDuration ?? `${config.hermes.maxWallHours}h (default)`,
    effectiveMs: effectiveMs ?? config.hermes.maxWallHours * 60 * 60 * 1000,
    clamped,
    // handle set by armProjectTimer below
  };
  saveState(hermesDir, state.id, state);
  appendJournal(hermesDir, state.id, {
    type: "status",
    message: `mode changed → auto (timer=${state.timer.requestedDuration}${clamped ? ", clamped to " + config.hermes.maxWallHours + "h" : ""})`,
  });

  // Arm a wallclock setTimeout. Only meaningful for active projects (a
  // terminal project won't be running the orchestrator loop, so the
  // timer just sits there until /project resume re-arms it). We still
  // arm unconditionally so a fresh /project setMode auto on a terminal
  // project has a "live" timer (will fire softExit on next /resume if
  // it's still in the future at that point).
  armProjectTimer(state, () => {
    // Re-load state — closure capture may be stale.
    const fresh = loadState(hermesDir, state.id);
    if (!fresh || !isActive(fresh)) return;
    softExit(state.id, fresh, {
      hermesDir,
      thread: msg.channel as ThreadChannel,
      claudeSession: null,
    }, "duration_expired").catch((err) => {
      log.error("hermes: handleProjectSetMode timer softExit failed", {
        projectId: state.id,
        err: String(err),
      });
    });
  });

  const capNote = clamped
    ? ` (capped at ${config.hermes.maxWallHours}h — the safety cap)`
    : "";
  // RG-006: if the project is terminal, the message hints that Hermes
  // is automatically resuming — otherwise it just arms the timer.
  const willResume = !isActive(state);
  await msg.reply(
    `🔧 Project mode → \`auto\`, timer = \`${state.timer.requestedDuration}\`${capNote}. ` +
      (willResume
        ? `Hermes was idle; resuming orchestrator now — it will plan remaining tasks and drive Claude Code through them.`
        : `Hermes will plan tasks, drive Claude Code through each one, and self-assess completion.`),
  );
  log.info("hermes: project mode changed to auto", {
    projectId: state.id,
    duration: state.timer.requestedDuration,
    effectiveMs: state.timer.effectiveMs,
    clamped,
    autoResumed: willResume,
  });

  // RG-006: auto-resume the orchestrator if the project is currently
  // terminal (killed/failed/done). Before this fix, `/project setMode auto`
  // only flipped state.mode + armed the timer but never restarted the
  // orchestrator loop, so the user had to also type `/project resume` —
  // a UX gap surfaced on 2026-06-22 by David. Now setMode auto on a
  // terminal project transparently resumes, matching the natural mental
  // model ("switch back to auto → Hermes takes over again").
  //
  // For active projects (planning/executing/judging) the orchestrator
  // loop is already running, so we don't restart — restarting would
  // spawn a second loop and race against the existing one.
  if (!isActive(state)) {
    // Capture the pre-resume status for the journal entry BEFORE we
    // mutate it — otherwise the audit log loses the "from" status.
    const fromStatus = state.status;
    // Reset to executing; orchestrator will pick up where it left off.
    state.status = "executing";
    state.endedAt = null;
    saveState(hermesDir, state.id, state);
    appendJournal(hermesDir, state.id, {
      type: "status",
      message: `auto-resumed by /project setMode auto (was ${fromStatus})`,
    });
    // `store` is optional for testability (some test fixtures pass a
    // mock store) but in production it's always provided by
    // dispatchHermesCommand. Fall back to a no-claudeSession lookup if
    // it's missing rather than crashing — the orchestrator will then
    // start a fresh CC session instead of resuming one.
    const session = store?.get(threadId);
    runProject(state.id, {
      hermesDir,
      thread: msg.channel as ThreadChannel,
      claudeSession: session?.claudeSession ?? null,
      userMsgStub: msg,
    }).catch((err) => {
      log.error("hermes: setMode auto resume crashed", {
        projectId: state.id,
        err: String(err),
      });
    });
    log.info("hermes: setMode auto triggered auto-resume", {
      projectId: state.id,
      fromStatus: state.status,
    });
  }
}