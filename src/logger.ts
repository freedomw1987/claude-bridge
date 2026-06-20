/**
 * Minimal structured logger.
 * Outputs JSON in prod, pretty lines in dev.
 */

import { config } from "./config";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level =
  (config.runtime.logLevel as Level) in LEVELS
    ? (config.runtime.logLevel as Level)
    : "info";

const isDev = process.env.NODE_ENV !== "production" && process.env.BUN_ENV !== "production";

const shouldLog = (level: Level): boolean => LEVELS[level] >= LEVELS[currentLevel];

const colorize = (level: Level, msg: string): string => {
  if (!isDev) return msg;
  const codes: Record<Level, string> = {
    debug: "\x1b[90m", // gray
    info: "\x1b[36m",  // cyan
    warn: "\x1b[33m",  // yellow
    error: "\x1b[31m", // red
  };
  const reset = "\x1b[0m";
  return `${codes[level]}${msg}${reset}`;
};

const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  if (isDev) {
    const line = `${ts} ${colorize(level, level.toUpperCase().padEnd(5))} ${msg}`;
    const tail = fields ? ` ${JSON.stringify(fields)}` : "";
    const stream = level === "error" ? console.error : console.log;
    stream(line + tail);
  } else {
    const payload = { ts, level, msg, ...fields };
    const stream = level === "error" ? console.error : console.log;
    stream(JSON.stringify(payload));
  }
};

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
