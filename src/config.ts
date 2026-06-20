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
  },
  runtime: {
    idleTimeoutMin: optionalInt("IDLE_TIMEOUT_MIN", 30),
    maxConcurrentContainers: optionalInt("MAX_CONCURRENT_CONTAINERS", 5),
    logLevel: optional("LOG_LEVEL", "info"),
  },
  docker: {
    agentImage: optional("AGENT_IMAGE", "claude-bridge-agent:latest"),
    network: optional("DOCKER_NETWORK", ""),
  },
  claude: {
    defaultPermissionMode: optional("CLAUDE_DEFAULT_PERMISSION_MODE", "acceptEdits"),
    systemPromptFile: expandTilde(
      optional("CLAUDE_SYSTEM_PROMPT_FILE", "dev_agent/adapters/claude-code/agent.md"),
    ),
  },
} as const;

export type Config = typeof config;
