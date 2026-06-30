/**
 * Hermes Tracker — Discord attachment handling.
 *
 * When a user sends a message with an attachment (image, PDF, code
 * file, etc.) to a CC thread, the bot downloads the file to local
 * disk and includes the path in the prompt passed to Claude Code.
 * CC can then use the Read tool to inspect the file.
 *
 * Why download + path instead of base64 inline?
 *   - The Claude Agent SDK's query() accepts a string `prompt`. To
 *     pass images as content blocks, we'd need a custom transport.
 *   - Files can be large (up to 25 MB on Discord Nitro); inlining
 *     a 25 MB base64 string into a single message bloats the
 *     context window and slows first-token latency.
 *   - The Read tool already supports arbitrary file paths in the
 *     working directory. Path-based handoff composes naturally.
 *
 * Storage:
 *   data/attachments/<threadId>/<messageId>-<filename>
 *
 * Filenames are sanitized (path separators stripped) to prevent
 * directory traversal via a malicious attachment name.
 *
 * Hermes project mode (mode === 'autopilot' or 'manual'):
 *   Files land in the project's working dir under
 *   `<repoPath>/.claude-bridge/attachments/<messageId>-<filename>`
 *   so CC can find them via its normal Read tool without leaving
 *   the project tree.
 *
 * Conversation mode (mode === undefined / new session):
 *   Files land in the global `data/attachments/<threadId>/` so
 *   they survive across restarts and can be referenced by future
 *   CC runs on the same thread.
 */

import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { log } from "./logger";
import { config } from "./config";
import type { Session } from "./types";

/** Safe filename: strip path separators, keep basename only. */
function sanitize(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

/**
 * Discord's Attachment URL is CDN-hosted; download via streaming
 * fetch so we don't buffer the whole file in memory.
 */
async function downloadTo(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`attachment download failed: ${res.status} ${res.statusText}`);
  }
  // node:stream web Readable → file stream
  const nodeStream = Readable.fromWeb(res.body as never);
  const fileStream = createWriteStream(dest);
  await pipeline(nodeStream, fileStream);
  // Get size from file stats
  const { statSync } = await import("node:fs");
  return statSync(dest).size;
}

interface DownloadedAttachment {
  /** Original Discord attachment name (sanitized). */
  filename: string;
  /** Absolute path on local disk. */
  path: string;
  /** Original Discord CDN URL. */
  url: string;
  /** Size in bytes after download. */
  size: number;
  /** Content type (e.g. "image/png"). */
  contentType: string | null;
}

/**
 * Download all attachments in a Discord message to local disk.
 * Returns metadata for each successful download; failed downloads
 * are logged and skipped (the message still goes through with the
 * text-only portion).
 *
 * `session` is the basic-session row from sessions.db. Used to
 * decide between project-local and conversation-global storage.
 */
export async function downloadAttachments(
  messageId: string,
  attachments: import("discord.js").Message["attachments"],
  session: Session,
): Promise<DownloadedAttachment[]> {
  if (attachments.size === 0) return [];
  const dir = attachmentDir(session);
  mkdirSync(dir, { recursive: true });
  const out: DownloadedAttachment[] = [];
  for (const a of attachments.values()) {
    const safe = sanitize(a.name);
    if (!safe) {
      log.warn("attachments: skipped — empty name", {
        messageId,
        originalName: a.name,
      });
      continue;
    }
    const dest = join(dir, `${messageId}-${safe}`);
    try {
      const size = await downloadTo(a.url, dest);
      log.info("attachments: downloaded", {
        messageId,
        path: dest,
        size,
        contentType: a.contentType,
      });
      out.push({
        filename: safe,
        path: dest,
        url: a.url,
        size,
        contentType: a.contentType,
      });
    } catch (err) {
      log.error("attachments: download failed", {
        messageId,
        url: a.url,
        err: String(err),
      });
    }
  }
  return out;
}

/**
 * Resolve the directory attachments should land in for a given
 * session. Hermes project: <repoPath>/.claude-bridge/attachments/.
 * Conversation: data/attachments/<threadId>/.
 */
function attachmentDir(session: Session): string {
  if (session.mode === "autopilot" || session.mode === "manual") {
    // Hermes project — keep files inside the project working dir
    // so CC's Read tool can find them via natural paths.
    return join(session.repoPath, ".claude-bridge", "attachments");
  }
  return join(config.paths.dataDir, "attachments", session.threadId);
}

/**
 * Build a prompt suffix that lists saved attachments, so the LLM
 * knows about them and can use the Read tool. We keep the suffix
 * compact — the path is enough; the LLM can read the file itself.
 */
export function attachmentPromptSuffix(downloaded: DownloadedAttachment[]): string {
  if (downloaded.length === 0) return "";
  const lines = downloaded.map(
    (a) => `- ${a.path} (${a.filename}, ${formatSize(a.size)}${a.contentType ? ", " + a.contentType : ""})`,
  );
  return (
    "\n\nThe user attached the following file(s); " +
    "use your file-reading tools to inspect them as needed:\n" +
    lines.join("\n")
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * If the path exists, return it; otherwise return null. Used by the
 * HTTP API to expose attachment listings to the frontend.
 */
export function safeStat(path: string): { size: number } | null {
  if (!existsSync(path)) return null;
  try {
    // Lazy import to keep startup fast.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const s = statSync(path);
    return { size: s.size };
  } catch {
    return null;
  }
}