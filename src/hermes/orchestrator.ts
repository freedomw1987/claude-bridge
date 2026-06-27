/**
 * Hermes orchestrator — re-export shim.
 *
 * Phase 3.5 (2026-06-27): the 858-line orchestrator.ts was split into
 * focused modules under `./orchestrator/`:
 *
 *   types.ts     — OrchestratorDeps
 *   safety.ts    — shouldStop, pickNextTask, checkTimerExpired
 *   lifecycle.ts — softExit, armProjectTimer, adoptProject
 *   manual.ts    — runManualProject
 *   resume.ts    — resumeActiveProjects, ensureArtifactsDir
 *   run.ts       — runProject (state machine + catch) + doPlanning + runOneTask
 *
 * This file re-exports the public API so existing callers and tests
 * keep working without modification.
 */

export type { OrchestratorDeps } from "./orchestrator/types";

export { runProject } from "./orchestrator/run";
export { runManualProject } from "./orchestrator/manual";
export { resumeActiveProjects, ensureArtifactsDir } from "./orchestrator/resume";
export {
  softExit,
  armProjectTimer,
  adoptProject,
} from "./orchestrator/lifecycle";
export {
  shouldStop,
  pickNextTask,
  checkTimerExpired,
} from "./orchestrator/safety";

/** Re-export for convenience — used by `forwardToClaude` callers. */
export { runViaSdk } from "../agent/sdkRunner";