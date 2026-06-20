/**
 * Stream-json event types from `claude --output-format stream-json -p`.
 * Reference: `claude --help` output.
 */

export interface StreamSystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  tools: string[];
  model: string;
  permissionMode: string;
  slash_commands: string[];
  claude_code_version: string;
  uuid: string;
}

export interface StreamSystemThinkingTokens {
  type: "system";
  subtype: "thinking_tokens";
  session_id: string;
  estimated_tokens: number;
  estimated_tokens_delta: number;
  uuid: string;
}

export interface StreamAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: Array<
      | { type: "thinking"; thinking: string; signature: string }
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;
    model: string;
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

export interface StreamUserMessage {
  type: "user";
  message: {
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
    >;
  };
  session_id: string;
  uuid: string;
}

export interface StreamResultSuccess {
  type: "result";
  subtype: "success";
  is_error: false;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  stop_reason: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface StreamResultError {
  type: "result";
  subtype: "error";
  is_error: true;
  duration_ms: number;
  session_id: string;
  error: string;
}

export type StreamEvent =
  | StreamSystemInit
  | StreamSystemThinkingTokens
  | StreamAssistantMessage
  | StreamUserMessage
  | StreamResultSuccess
  | StreamResultError;

// Helpers
export const isInitEvent = (e: StreamEvent): e is StreamSystemInit =>
  e.type === "system" && e.subtype === "init";

export const isAssistantText = (e: StreamEvent): e is StreamAssistantMessage => {
  if (e.type !== "assistant") return false;
  return e.message.content.some((c) => c.type === "text");
};

export const isAssistantToolUse = (e: StreamEvent): e is StreamAssistantMessage => {
  if (e.type !== "assistant") return false;
  return e.message.content.some((c) => c.type === "tool_use");
};

export const isResult = (
  e: StreamEvent,
): e is StreamResultSuccess | StreamResultError =>
  e.type === "result";

export const getResultText = (e: StreamResultSuccess): string => e.result;