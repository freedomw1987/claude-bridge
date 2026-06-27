/**
 * Hermes commands — re-export shim.
 *
 * Phase 3.5 (2026-06-27): the 1483-line hermesCommands.ts was split
 * into focused modules under `./hermes/`:
 *
 *   matchers.ts   — all regex matchers + HermesCommandContext
 *   helpers.ts    — findProjectByThread, parseStartArgs, etc.
 *   start.ts      — /project start
 *   adopt.ts      — /project adopt (RG-004 + RG-007 collision detection)
 *   setMode.ts    — /project setMode auto|manual [duration]
 *   delete.ts     — /project delete (RG-009 2-phase commit)
 *   lifecycle.ts  — status / plan / kill / resume / list
 *   dispatch.ts   — dispatchHermesCommand (the entry point)
 *
 * This file re-exports the public API so existing callers and tests
 * keep working without modification. It is intentionally a thin
 * facade — no logic lives here.
 */

export {
  isProjectCommand,
  matchAdopt,
  matchDelete,
  matchKill,
  matchList,
  matchPlan,
  matchResume,
  matchSetMode,
  matchStart,
  matchStatus,
  type HermesCommandContext,
} from "./hermes/matchers";

export { handleProjectStart } from "./hermes/start";
export { handleProjectAdopt } from "./hermes/adopt";
export { handleProjectSetMode } from "./hermes/setMode";
export { handleProjectDelete, handleDeleteConfirmReply } from "./hermes/delete";
export {
  handleProjectStatus,
  handleProjectPlan,
  handleProjectKill,
  handleProjectResume,
  handleProjectList,
} from "./hermes/lifecycle";
export { dispatchHermesCommand } from "./hermes/dispatch";