/**
 * ClaudeRunner — wraps `claude -p --output-format stream-json`.
 * Runs as a subprocess on the host. Files are written directly to `cwd`
 * (no mount / no container). See `docs/MILESTONES.md` for the abandoned
 * Week 3 Docker plan.
 */

import { log } from "../logger";
import { trackProcess, untrackProcess } from "../cleanup";
import { existsSync } from "node:fs";
import type {
  StreamEvent,
  StreamAssistantMessage,
  StreamResultSuccess,
  StreamResultError,
} from "./events";

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
  onTextDelta?: (text: string, full: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onToolResult?: (text: string, isError: boolean) => void;
  onUserText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onResult?: (result: ClaudeRunResult) => void;
}

const PERMISSION_MODE_DEFAULT = "auto";

/**
 * Parse a stream of JSON lines into events. Tolerates partial lines in the buffer.
 */
async function* parseJsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
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

  const proc = Bun.spawn({
    cmd: [claudePath, ...args],
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  trackProcess(proc.pid);

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
          callbacks.onTextDelta?.(block.text, collectedText.join(""));
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

  // Drain stderr for diagnostics
  const stderrText = await new Response(proc.stderr).text();
  if (stderrText.trim()) {
    log.warn("claude stderr", { stderr: stderrText.slice(0, 500) });
  }

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

