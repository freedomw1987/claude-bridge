/**
 * Claude Agent SDK runner — the Phase 1 replacement for `agent/runner.ts`.
 *
 * Each Discord message triggers one `query()` call. Sessions persist on disk
 * (the SDK's `persistSession: true` default) and are re-attached via
 * `options.resume`. There is no in-process client registry — the SDK manages
 * its own subprocess and session storage under `~/.claude/projects/`.
 *
 * The four Discord tools (`discord_send`, `discord_typing`, `discord_react`,
 * `discord_read_history`) are exposed to Claude via an in-process MCP server
 * created with `createSdkMcpServer()`. Their handlers do the actual Discord
 * side effects (thread.send, sendTyping, react, fetch) via closure on
 * `thread` and `send` (SendQueue-wrapped). The SDK dispatches each tool_use
 * to our handler and packages the result back to Claude automatically.
 *
 * We do NOT parse Claude's stream — CC consumes it internally. We only need
 * to:
 *   1. Track tool_use count (for the final summary header).
 *   2. Capture the session ID from `system/init` so the next message can resume.
 *   3. Capture cost / duration / tokens from `result`.
 *
 * Active query tracking: a small `Map<threadId, { query, aborted }>` lets
 * `/kill` abort an in-flight run via `query.close()`. The map entry is set
 * at run start and cleared in a `finally` block.
 */

import {
  query,
  createSdkMcpServer,
  type Query,
  type SDKMessage,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadChannel } from "discord.js";
import { createRequire } from "node:module";
import { config } from "../config";
import { log } from "../logger";
import { splitForDiscord, DISCORD_MAX } from "../discord/split";
import { readSystemPrompt } from "./systemPrompt";
import { stripThinkTags } from "../discord/handlers/format";
import {
  allDiscordTools,
  setDiscordToolDeps,
  type DiscordToolDeps,
} from "./discordTool";

// Startup diagnostic: log the actual zod version the runtime is using.
// The MCP SDK's zod-to-json-schema converter is zod-3 only. If this
// shows zod 4, the MCP tool inputSchema conversion will fail and CC
// will see "Zod validation error" on every tool call.
const _require = createRequire(import.meta.url);
try {
  const _zodPkg = _require("zod/package.json");
  const _zodMod = _require("zod");
  const _s = _zodMod.z?.string?.() ?? _zodMod.string?.();
  log.info("sdk runner zod diagnostic", {
    version: _zodPkg.version,
    path: _require.resolve("zod"),
    schemaHasZod4Field: !!(_s && "_zod" in _s),
  });
} catch (e) {
  log.warn("zod diagnostic failed", { err: String(e) });
}

const DISCORD_MCP_SERVER_NAME = "discord-bridge";

export interface SdkRunResult {
  sessionId: string;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
  errorMessage?: string;
  /** Whether the run was aborted via /kill or process shutdown. */
  aborted: boolean;
  /** Total tool_use blocks Claude emitted across all turns. */
  toolCallCount: number;
  /** Total turns Claude ran. */
  numTurns: number;
}

interface ActiveRun {
  query: Query;
  aborted: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

export function activeSdkRunCount(): number {
  return activeRuns.size;
}

export function isSdkRunActive(threadId: string): boolean {
  return activeRuns.has(threadId);
}

/**
 * Abort an in-flight SDK run for the given thread. Used by `/kill` and the
 * shutdown sequence. Returns true if a run was found and aborted.
 */
export function abortSdkRun(threadId: string): boolean {
  const run = activeRuns.get(threadId);
  if (!run) return false;
  run.aborted = true;
  try {
    run.query.close();
  } catch (err) {
    log.warn("failed to close query", { threadId, err: String(err) });
  }
  return true;
}

/**
 * Abort all in-flight SDK runs. Used on process shutdown.
 */
export async function abortAllSdkRuns(): Promise<void> {
  const ids = [...activeRuns.keys()];
  for (const id of ids) {
    abortSdkRun(id);
  }
  // Give the iterator loops a tick to exit cleanly.
  await new Promise<void>((r) => setTimeout(r, 50));
}

/**
 * Run Claude Code against the given Discord thread, via the SDK.
 *
 * The thread + send wrapper are bound into the MCP tool handlers via
 * `setDiscordToolDeps()` before the run starts. Each run creates its own
 * MCP server instance (cheap — in-process), so concurrent runs do not
 * collide.
 */
export async function runViaSdk(
  userMsg: import("discord.js").Message,
  thread: ThreadChannel,
  prompt: string,
  session: {
    threadId: string;
    claudeSession: string | null;
    repoPath: string;
  },
  // RG-005: branded type — must be the result of `makeClaudeSend(thread, queue?)`.
  // A raw `thread.send` / `channel.send` wrapper will fail to compile here.
  send: import("../discord/handlers/streaming").PrefixedSend,
): Promise<SdkRunResult> {
  // Bind thread + send into the MCP tool handlers.
  const deps: DiscordToolDeps = { thread, send };
  setDiscordToolDeps(deps);

  const systemPrompt = await readSystemPrompt();

  // Build the MCP server with our four tools.
  const mcpServer = createSdkMcpServer({
    name: DISCORD_MCP_SERVER_NAME,
    tools: allDiscordTools,
  });

  const options: NonNullable<Parameters<typeof query>[0]["options"]> = {
    cwd: session.repoPath,
    mcpServers: { [DISCORD_MCP_SERVER_NAME]: mcpServer },
    permissionMode: config.claude.sdkPermissionMode as
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "plan"
      | "dontAsk"
      | "auto",
    // `bypassPermissions` is the only mode that lets the headless SDK
    // auto-approve Bash writes (e.g. `git commit`) without trying to
    // render an interactive prompt UI that would Zod-fail headlessly.
    // Required by the SDK when permissionMode === "bypassPermissions".
    allowDangerouslySkipPermissions:
      config.claude.sdkPermissionMode === "bypassPermissions",
    // Wire the SDK's native AbortController so CLAUDE_TURN_TIMEOUT_MS
    // (default 60 min) can hard-kill a stuck run. See ADR-0002 future
    // work #2. The controller is passed inline; the setTimeout that
    // triggers it is created after the query() call below so we have
    // a handle on the ActiveRun to flip `aborted = true` atomically.
    abortController: new AbortController(),
    canUseTool: async (
      toolName: string,
      _input: Record<string, unknown>,
      _opts: {
        signal: AbortSignal;
        toolUseID: string;
        suggestions?: unknown[];
        blockedPath?: string;
        decisionReason?: string;
        title?: string;
        displayName?: string;
        description?: string;
        agentID?: string;
      },
    ): Promise<PermissionResult> => {
      // Allow our four Discord tools unconditionally.
      if (toolName.startsWith("mcp__discord-bridge__")) {
        return { behavior: "allow" };
      }
      // Defer to the configured permission mode for built-in tools. With
      // `permissionMode: "acceptEdits"`, Claude's own permission system
      // handles non-trivial decisions (e.g., Bash commands). For Phase 1
      // we keep the surface minimal — built-in tools (Read, Bash, Edit,
      // Glob, Grep, WebFetch, WebSearch) are accepted by the SDK's default
      // permission logic for the configured mode.
      return { behavior: "allow" };
    },
  };

  if (systemPrompt) {
    options.systemPrompt = systemPrompt;
  }
  if (config.claude.sdkModel) {
    options.model = config.claude.sdkModel;
  }
  if (session.claudeSession) {
    options.resume = session.claudeSession;
  }

  let q: Query;
  try {
    q = query({ prompt, options });
  } catch (err) {
    log.error("failed to start sdk query", { err: String(err) });
    return {
      sessionId: session.claudeSession ?? "",
      durationMs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      isError: true,
      errorMessage: `failed to start query: ${String(err)}`,
      aborted: false,
      toolCallCount: 0,
      numTurns: 0,
    };
  }

  const run: ActiveRun = { query: q, aborted: false };
  activeRuns.set(session.threadId, run);

  // Turn timeout — if the SDK's AbortController fires (via the timer
  // below), the SDK will TerminateProcess the underlying subprocess and
  // the for-await loop will see an abort error. We mark `run.aborted`
  // first so the catch block can distinguish "user/system timeout"
  // from a real Claude error.
  const turnTimeoutMs = config.claude.turnTimeoutMs;
  const turnTimer = setTimeout(() => {
    run.aborted = true;
    log.warn("turn timeout exceeded, aborting", {
      threadId: session.threadId,
      turnTimeoutMs,
    });
    try {
      q.close();
    } catch (err) {
      log.warn("failed to close query on timeout", {
        threadId: session.threadId,
        err: String(err),
      });
    }
  }, turnTimeoutMs);

  const result: SdkRunResult = {
    sessionId: session.claudeSession ?? "",
    durationMs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    isError: false,
    aborted: false,
    toolCallCount: 0,
    numTurns: 0,
  };

  // Auto-surface CC's plain text replies to Discord. CC's natural
  // behavior is to write a final text answer; without this, users
  // would only see the stats header even when CC has good content.
  //
  // We only auto-post when the assistant message is text-only
  // (no tool_use blocks). If CC also called discord_send in the
  // same message, the user's content reaches Discord via that call
  // and we skip here to avoid duplicates.
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (run.aborted) break;
      if (msg.type === "assistant") {
        const hasToolUse = msg.message.content.some(
          (b) => b.type === "tool_use",
        );
        if (!hasToolUse) {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              // RG-002: strip <ant_thinking>...</ant_thinking> AND
              // <thinking>...</thinking> blocks. CC's internal
              // reasoning should not appear in Discord. The helper
              // lives in format.ts and is shared with discordSendTool
              // so the strip is consistent across both paths.
              const visible = stripThinkTags(block.text);
              if (!visible) continue;
              const chunks = splitForDiscord(visible, DISCORD_MAX);
              for (const chunk of chunks) {
                await send(chunk).catch((err) =>
                  log.warn("failed to auto-post cc text", { err: String(err) }),
                );
              }
              log.info("auto-posted cc text", {
                threadId: session.threadId,
                length: visible.length,
                chunks: chunks.length,
              });
            }
          }
        }
      }
      handleMessage(msg, result);
    }
  } catch (err) {
    if (run.aborted) {
      // Aborted by timeout, /kill, or process shutdown — not a Claude error.
      // The `errorMessage` is set below in the post-loop block; do not
      // overwrite it with the raw abort error.
    } else {
      result.isError = true;
      result.errorMessage = String(err);
      log.error("sdk run errored", { threadId: session.threadId, err: String(err) });
    }
  } finally {
    clearTimeout(turnTimer);
    activeRuns.delete(session.threadId);
  }

  if (run.aborted) {
    result.aborted = true;
    // An aborted run is not an error per se — the user requested it
    // (via /kill) or the system aborted it (turn timeout, shutdown).
    result.isError = false;
    if (!result.errorMessage) {
      result.errorMessage = "run aborted (timeout, /kill, or shutdown)";
    }
  }

  void userMsg; // currently unused; reserved for future per-message context
  return result;
}

function handleMessage(msg: SDKMessage, result: SdkRunResult): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        result.sessionId = msg.session_id;
        log.debug("sdk init", {
          session_id: msg.session_id,
          model: msg.model,
          tools: msg.tools,
          mcp_servers: msg.mcp_servers?.map((s) => s.name),
        });
      }
      break;
    case "assistant": {
      // Count tool_use blocks for the summary header.
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          result.toolCallCount++;
          log.debug("sdk tool_use", { name: block.name });
        } else if (block.type === "text") {
          // Log CC's text content (truncated) so we can see if CC
          // is producing text but forgetting to use discord_send.
          log.debug("sdk assistant text", {
            preview: block.text.slice(0, 200),
            length: block.text.length,
          });
        }
      }
      break;
    }
    case "result": {
      // Terminal message — success or error.
      if (msg.subtype === "success") {
        result.durationMs = msg.duration_ms;
        result.costUsd = msg.total_cost_usd;
        result.inputTokens = msg.usage.input_tokens ?? 0;
        result.outputTokens = msg.usage.output_tokens ?? 0;
        result.numTurns = msg.num_turns;
        result.sessionId = msg.session_id;
        result.isError = msg.is_error;
        if (msg.is_error) {
          result.errorMessage = msg.result || "claude reported an error";
        }
      } else {
        // error subtype
        result.isError = true;
        result.errorMessage =
          ("error" in msg && typeof msg.error === "string" && msg.error) ||
          "unknown sdk error";
        result.sessionId = msg.session_id;
        result.numTurns = msg.num_turns;
      }
      break;
    }
    // Other message types (user, partial, status, hooks, ...) are
    // intentionally ignored — the SDK handles tool dispatch for us,
    // and we don't need partial streaming events for the Phase 1 UX.
    default:
      break;
  }
}