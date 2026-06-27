/**
 * Orchestrator dependency types.
 *
 * `OrchestratorDeps` is passed to `runProject` and `runManualProject`.
 * The orchestrator is pure async — it does not bind to Discord
 * globally. The caller (Discord command handler or resume-on-startup)
 * provides the deps.
 */

import type { ThreadChannel, Message } from "discord.js";

export interface OrchestratorDeps {
  hermesDir: string;
  /** Resolved thread for Discord updates. Required. */
  thread: ThreadChannel;
  /**
   * Claude session ID for session persistence across retries. Looked up
   * from SessionStore by the caller. May be null on first run.
   */
  claudeSession: string | null;
  /**
   * Optional stub Message for runViaSdk's first arg (which is currently
   * unused by the SDK). On resume-on-startup this is omitted.
   */
  userMsgStub?: Message;
  /**
   * Optional: lookup a saved Claude session for a thread. If null, a
   * fresh session is started (no resume). Used by resume-on-startup.
   */
  resolveClaudeSession?: (threadId: string) => string | null;
}