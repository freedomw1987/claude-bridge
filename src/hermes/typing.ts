/**
 * Hermes typing indicator — keeps "Bot is typing..." visible in the
 * Discord thread for the duration of an orchestrator run.
 *
 * Discord's typing indicator expires after ~10 seconds of silence, so
 * we refresh every 8s. Discord.js' `sendTyping()` is fire-and-forget;
 * errors are silently swallowed because a typing failure is not actionable.
 *
 * Lifecycle:
 *   const t = new TypingIndicator(thread);
 *   t.start();
 *   try { ... do work ... } finally { t.stop(); }
 *
 * The class is intentionally tiny — no state beyond a single interval
 * handle. Stopping twice is a no-op; starting twice is also a no-op
 * (the second start is dropped to avoid double-refresh).
 */

import type { ThreadChannel } from "discord.js";

const REFRESH_INTERVAL_MS = 8_000;

export class TypingIndicator {
  private handle: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly thread: ThreadChannel) {}

  /** Begin refreshing the typing indicator. Idempotent. */
  start(): void {
    if (this.handle || this.stopped) return;
    // Fire one immediately so the user sees feedback right away, then
    // schedule the recurring refresh.
    this.fire();
    this.handle = setInterval(() => this.fire(), REFRESH_INTERVAL_MS);
    // Unref so a leaked typing interval never keeps the process alive
    // (defense-in-depth — the orchestrator's try/finally should always
    // call stop, but we don't want a single bug to wedge the bot).
    if (typeof (this.handle as { unref?: () => void }).unref === "function") {
      (this.handle as { unref: () => void }).unref();
    }
  }

  /** Stop refreshing. Idempotent. */
  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
    this.stopped = true;
  }

  /** True if start() has been called and stop() has not. */
  get isActive(): boolean {
    return this.handle !== null;
  }

  private fire(): void {
    // Fire-and-forget; sendTyping errors are non-actionable.
    this.thread.sendTyping().catch(() => {});
  }
}