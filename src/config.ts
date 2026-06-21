/**
 * Config — load + validate env vars.
 * Fails fast on missing required values.
 */

import { expandTilde } from "./utils/path";

const required = (key: string): string => {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v.trim();
};

const optional = (key: string, fallback: string): string => {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : fallback;
};

const optionalInt = (key: string, fallback: number): number => {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be integer, got: ${v}`);
  if (n < 0) throw new Error(`Env var ${key} must be non-negative, got: ${n}`);
  return n;
};

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    channelId: required("DISCORD_CHANNEL_ID"),
    allowedUserId: required("DISCORD_USER_ID"),
  },
  paths: {
    dataDir: expandTilde(optional("DATA_DIR", "./data")),
    tasksRoot: expandTilde(optional("TASKS_ROOT", "~/www/discord-claude-tasks")),
    projectsRoot: expandTilde(optional("PROJECTS_ROOT", "~/www")),
    projectsConfig: expandTilde(optional("PROJECTS_CONFIG", "")),
    hermesDir: expandTilde(optional("HERMES_DIR", "")), // empty = <DATA_DIR>/hermes
  },
  runtime: {
    idleTimeoutMin: optionalInt("IDLE_TIMEOUT_MIN", 30),
    maxConcurrentContainers: optionalInt("MAX_CONCURRENT_CONTAINERS", 5),
    gitCloneTimeoutMin: optionalInt("GIT_CLONE_TIMEOUT_MIN", 5),
    logLevel: optional("LOG_LEVEL", "info"),
    // Internal RSS self-watchdog. Exits the bot if process.memoryUsage().rss
    // exceeds the threshold — defense-in-depth if the OS-level watchdog
    // (scripts/memory-watchdog.sh) is disabled. ADR-0002 future work #3.
    rssThresholdMB: optionalInt("BOT_RSS_THRESHOLD_MB", 800),
    rssSampleIntervalMs: optionalInt("BOT_RSS_SAMPLE_INTERVAL_MS", 30_000),
    // RAM tracing: append every sample to data/ram-trace.log as CSV
    // (`ts,rssMB,heapUsedMB`). Use to validate SDK-era long-task behavior.
    ramTraceEnabled: optional("BOT_RAM_TRACE", "0") === "1",
    ramTracePath: expandTilde(optional("BOT_RAM_TRACE_PATH", "")),
  },
  claude: {
    defaultPermissionMode: optional("CLAUDE_DEFAULT_PERMISSION_MODE", "acceptEdits"),
    systemPromptFile: expandTilde(
      optional("CLAUDE_SYSTEM_PROMPT_FILE", "dev_agent/adapters/claude-code/agent.md"),
    ),
    // Phase 1: SDK opt-in. When enabled, the bot uses the Claude Agent SDK
    // (@anthropic-ai/claude-agent-sdk) instead of shelling out to `claude -p`.
    // Tool calls (discord_send, discord_typing, discord_react, discord_read_history)
    // are executed by the SDK's MCP transport; the bot stays a thin proxy.
    useSdk: optional("CLAUDE_USE_SDK", "0") === "1",
    sdkModel: optional("CLAUDE_SDK_MODEL", ""),
    // Default to "bypassPermissions" so the headless SDK doesn't try to
    // render an interactive permission prompt UI for Bash writes
    // (e.g. `git commit`). Set CLAUDE_SDK_PERMISSION_MODE=acceptEdits in
    // .env if you want Edit auto-approval but still prompt for Bash.
    sdkPermissionMode: optional("CLAUDE_SDK_PERMISSION_MODE", "bypassPermissions"),
    // Hard cap on a single Claude run. The SDK's native abortController
    // is wired to this timeout; on expiry the run is killed and the user
    // gets a "turn timeout exceeded" error (not a generic crash).
    // ADR-0002 future work #2.
    turnTimeoutMs: optionalInt("CLAUDE_TURN_TIMEOUT_MS", 60 * 60 * 1000),
  },
  hermes: {
    // Model used for Hermes's own planner + judge LLM calls. Cheap and
    // fast since these run in a hot loop (once per task). Override if
    // you want planning quality to match the coding model.
    model: optional("HERMES_MODEL", "claude-haiku-4-5"),
    // Safety caps (per project).
    maxIterations: optionalInt("HERMES_MAX_ITERATIONS", 20),
    maxCostUsd: optionalInt("HERMES_MAX_COST_USD", 500), // in cents; displayed as $5.00
    maxWallHours: optionalInt("HERMES_MAX_WALL_HOURS", 4),
    maxAttemptsPerTask: optionalInt("HERMES_MAX_ATTEMPTS_PER_TASK", 3),
    // When non-empty, resume any active projects on bot startup. Set to 0
    // to disable auto-resume (manual /project resume only).
    resumeOnStartup: optional("HERMES_RESUME_ON_STARTUP", "1") === "1",
  },
} as const;

export type Config = typeof config;
