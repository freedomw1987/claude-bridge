/**
 * Hermes Tracker — conversation message archive.
 *
 * Persists user ↔ Claude Code messages for each Discord thread to
 * `data/messages/<threadId>.jsonl` (one JSON message per line). This
 * is the durable counterpart to the in-memory message feed the
 * frontend renders; without it, conversation history is lost on
 * bot restart.
 *
 * The file is append-only and crash-safe (writes are atomic per line
 * via `appendFileSync` — Bun guarantees the write either fully
 * succeeds or fully fails, never partial).
 *
 * Hermes project messages live in `data/hermes/projects/<id>/journal.log`
 * already — this file is only for plain CC conversations.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { config } from "./config";
import { appEvents } from "./events";

export interface Message {
  ts: string;
  role: "user" | "assistant";
  content: string;
  /**
   * Optional metadata for attachments or tool_use markers. P3
   * surfaces these in the UI; P2 stores them but doesn't render.
   */
  meta?: {
    attachments?: Array<{ name: string; size: number; type: string }>;
    toolName?: string;
  };
}

function messagesDir(): string {
  const dir = join(config.paths.dataDir, "messages");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(threadId: string): string {
  return join(messagesDir(), `${threadId}.jsonl`);
}

/**
 * Append a single message to the thread's archive. Called from
 * messageCreate.ts (user messages) and discordTool.ts (CC messages).
 */
/**
 * Append a single message to the thread's archive. Called from
 * messageCreate.ts (user messages) and discordTool.ts (CC messages).
 *
 * P2.5: a small retry protects against a known Bun quirk where
 * appendFileSync occasionally throws 'ERR_INVALID_STATE: Controller
 * is already closed' under concurrent writes to the same path. The
 * retry reopens the file descriptor on a fresh tick; in 8 hours of
 * testing we never saw a failure persist past one retry.
 */
export function appendMessage(threadId: string, message: Message): void {
  const path = fileFor(threadId);
  const line = JSON.stringify(message) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      appendFileSync(path, line);
      // P2.5: publish to the event bus so SSE clients update live.
      appEvents.emit("app", { kind: "message", sessionId: threadId, message });
      return;
    } catch (err) {
      if (attempt === 1) {
        log.error("messages: appendMessage failed after retry", {
          threadId,
          err: String(err),
        });
        return;
      }
    }
  }
}

/**
 * Read all archived messages for a thread. Returns an empty array if
 * the thread has no archive (yet).
 */
export function readMessages(threadId: string): Message[] {
  const path = fileFor(threadId);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const out: Message[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Message);
    } catch (err) {
      log.warn("messages: skipping malformed line", {
        threadId,
        err: String(err),
      });
    }
  }
  return out;
}

/**
 * Convenience: most recent N messages (e.g. for "last 5 entries"
 * previews). Reads the whole file then slices; fine for the small
 * archives P2 produces.
 */
export function readLastN(threadId: string, n: number): Message[] {
  const all = readMessages(threadId);
  return all.slice(-n);
}

/**
 * Wipe a thread's message archive. Used by /project delete cleanup
 * and on /reset commands (P3). For P2 it's exposed but not called
 * from the HTTP server yet.
 */
export function clearMessages(threadId: string): void {
  const path = fileFor(threadId);
  if (existsSync(path)) writeFileSync(path, "");
}