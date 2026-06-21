/**
 * ClaudeRunner — wraps `claude -p --output-format stream-json`.
 * Runs as a subprocess on the host. Files are written directly to `cwd`
 * (no mount / no container). See `docs/MILESTONES.md` for the abandoned
 * Week 3 Docker plan.
 */

import { log } from "../logger";
import { trackProcess, untrackProcess } from "../cleanup";
import { existsSync } from "node:fs";
import { freemem } from "node:os";
import type {
  StreamEvent,
  StreamAssistantMessage,
  StreamResultSuccess,
  StreamResultError,
} from "./events";

// Shared TextDecoder instance. Per the WHATWG spec, TextDecoder is stateless
// and safe to share across concurrent calls (the streaming option is local
// to each decode() invocation).
const TEXT_DECODER = new TextDecoder();

export interface ClaudeRunnerOptions {
  prompt: string;
  cwd: string; // working dir for claude (will be the per-thread repo path)
  sessionId?: string; // for --resume
  permissionMode?: string;
  allowedTools?: string[];
  model?: string;
  systemPromptFile?: string; // path to a file containing the system prompt
}

export interface ClaudeRunResult {
  sessionId: string;
  text: string;
  toolUses: Array<{ name: string; input: unknown }>;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
  errorMessage?: string;
}

export interface ClaudeRunnerCallbacks {
  onSessionId?: (sessionId: string) => void;
  onTextDelta?: (text: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onToolResult?: (text: string, isError: boolean) => void;
  onUserText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onResult?: (result: ClaudeRunResult) => void;
}

const PERMISSION_MODE_DEFAULT = "auto";

/**
 * Minimum free memory (bytes) required to safely spawn a claude subprocess.
 * Claude typically uses 300–800MB; 500MB free leaves headroom for the
 * subprocess plus the bot's own footprint (discord.js, queue buffers, etc.).
 */
const MIN_FREE_BYTES_FOR_CLAUDE = 10 * 1024 * 1024;

/**
 * Check if there's enough free memory to safely spawn a claude subprocess.
 * Exported for testing. Defaults to live `os.freemem()` but accepts overrides
 * so tests can pass mock values.
 */
export function hasEnoughMemoryForClaude(
  freeBytes: number = freemem(),
  minBytes: number = MIN_FREE_BYTES_FOR_CLAUDE,
): { ok: boolean; freeMB: number; requiredMB: number } {
  return {
    ok: freeBytes >= minBytes,
    freeMB: Math.round(freeBytes / 1024 / 1024),
    requiredMB: Math.round(minBytes / 1024 / 1024),
  };
}

/**
 * Drain a stderr stream line-by-line, logging each non-empty line.
 * Returns a Promise that resolves when the stream ends. Run in parallel
 * with stdout parsing so the child process never blocks on stderr writes.
 */
async function drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += TEXT_DECODER.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          log.warn("claude stderr", { line: line.slice(0, 500) });
        }
      }
    }
    // Flush any trailing line without a newline
    if (buf.trim()) {
      log.warn("claude stderr", { line: buf.slice(0, 500) });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a stream of JSON lines into events. Tolerates partial lines in the buffer.
 */
async function* parseJsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += TEXT_DECODER.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as StreamEvent;
        } catch (err) {
          log.warn("failed to parse stream-json line", {
            err: String(err),
            line: line.slice(0, 200),
          });
        }
      }
    }
    // Flush trailing line if any
    if (buf.trim()) {
      try {
        yield JSON.parse(buf.trim()) as StreamEvent;
      } catch (err) {
        log.warn("trailing buffer parse failed", { err: String(err) });
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runClaude(
  opts: ClaudeRunnerOptions,
  callbacks: ClaudeRunnerCallbacks = {},
): Promise<ClaudeRunResult> {
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode ?? PERMISSION_MODE_DEFAULT,
  ];

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.systemPromptFile) {
    args.push("--system-prompt-file", opts.systemPromptFile);
  }
  args.push(opts.prompt);

  log.info("spawning claude", {
    cwd: opts.cwd,
    argsLen: args.length,
    hasResume: !!opts.sessionId,
  });

  // Defensive: isValidLocalPath may have passed, but the dir could have been
  // deleted between check and use. Fail fast with a clear error.
  if (!existsSync(opts.cwd)) {
    throw new Error(`work directory does not exist: ${opts.cwd}`);
  }

  const claudePath = Bun.which("claude");
  if (!claudePath) {
    throw new Error(
      "claude not found in PATH. Make sure claude CLI is installed and reachable.",
    );
  }

  // Memory preflight. A claude subprocess typically uses 300–800MB. If the
  // host is already under memory pressure (other heavy apps, many concurrent
  // runs), spawning another could push the system into swap or OOM. The error
  // propagates up to forwardToClaude's try/catch and is shown to the user
  // as a normal "Claude failed" summary.
  const mem = hasEnoughMemoryForClaude();
  if (!mem.ok) {
    throw new Error(
      `insufficient memory to spawn claude: ${mem.freeMB}MB free, need at least ${mem.requiredMB}MB. Close other apps and try again.`,
    );
  }

  const proc = Bun.spawn({
    cmd: [claudePath, ...args],
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  trackProcess(proc.pid);

  // Drain stderr in parallel with stdout parsing. The OS pipe buffer is
  // typically 64KB — if claude writes verbose stderr while we're mid-parse
  // of stdout, the child blocks on its next stderr write and the bot appears
  // to hang. Logging each line as it arrives also gives real-time signal
  // when something goes wrong (auth failures, network errors, etc.).
  const stderrDrain = drainStderr(proc.stderr);

  const collectedText: string[] = [];
  const toolUses: Array<{ name: string; input: unknown }> = [];
  let sessionId = opts.sessionId ?? "";
  let result: StreamResultSuccess | StreamResultError | null = null;

  for await (const event of parseJsonLines(proc.stdout)) {
    if (event.type === "system" && event.subtype === "init") {
      sessionId = event.session_id;
      callbacks.onSessionId?.(sessionId);
    } else if (event.type === "assistant") {
      const msg = event as StreamAssistantMessage;
      for (const block of msg.message.content) {
        if (block.type === "text") {
          collectedText.push(block.text);
          callbacks.onTextDelta?.(block.text);
        } else if (block.type === "thinking") {
          callbacks.onThinking?.(block.thinking);
        } else if (block.type === "tool_use") {
          toolUses.push({ name: block.name, input: block.input });
          callbacks.onToolUse?.(block.name, block.input);
        }
      }
    } else if (event.type === "user") {
      // Tool results come as user events. Capture any text content.
      const um = event.message as { content?: Array<unknown> } | undefined;
      const content = um?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            callbacks.onUserText?.(b.text);
          } else if (b.type === "tool_result") {
            const tr = b.content;
            const text =
              typeof tr === "string"
                ? tr
                : Array.isArray(tr)
                  ? (tr as Array<Record<string, unknown>>)
                      .map((c) => (typeof c.text === "string" ? c.text : ""))
                      .join("\n")
                  : "";
            callbacks.onToolResult?.(text, b.is_error === true);
          }
        }
      }
    } else if (event.type === "result") {
      result = event;
    }
  }

  const exitCode = await proc.exited;
  untrackProcess(proc.pid);

  // Wait for the stderr drain to finish (it ends when the stream ends,
  // which happens shortly after process exit). Any final buffered bytes
  // are already logged by drainStderr.
  await stderrDrain;

  if (!result) {
    // Process exited without a result event — treat as error
    return {
      sessionId,
      text: collectedText.join(""),
      toolUses,
      durationMs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      isError: true,
      errorMessage: `claude exited with code ${exitCode} without result event`,
    };
  }

  const runResult: ClaudeRunResult =
    result.subtype === "success"
      ? {
          sessionId: result.session_id,
          text: collectedText.join("") || result.result,
          toolUses,
          durationMs: result.duration_ms,
          costUsd: result.total_cost_usd,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          isError: false,
        }
      : {
          sessionId: result.session_id,
          text: collectedText.join(""),
          toolUses,
          durationMs: result.duration_ms,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          isError: true,
          errorMessage: result.error,
        };

  callbacks.onResult?.(runResult);
  return runResult;
}
