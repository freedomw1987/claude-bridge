/**
 * Rate-limited Discord send queue.
 *
 * Discord's per-channel global rate limit is 5 messages per 5 seconds
 * (with a burst allowance). When Claude streams a long response and we
 * post many messages back-to-back (overflow chunks, final summary), we
 * can hit this limit and get 429'd.
 *
 * SendQueue serializes calls to `thread.send` and enforces a minimum
 * interval between sends. The first send is immediate; subsequent sends
 * are spaced out. Errors from one send don't break the chain — failed
 * sends are swallowed so the next send can still proceed.
 *
 * This is a simple Promise-chain-based implementation. We don't need
 * backpressure or a separate worker thread for our scale (1 claude run
 * per thread, max 5 concurrent).
 */

export interface SendFn<T = unknown> {
  (content: string): Promise<T>;
}

export class SendQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastSentAt: number | null = null;
  private readonly minIntervalMs: number;

  /**
   * @param minIntervalMs minimum gap between consecutive sends.
   *   Default 1000ms (Discord's per-channel limit is 5 msg / 5s = 1 msg/s;
   *   1000ms is exactly at the limit, +0% margin — works because the
   *   SendQueue is per-run and short-lived, so the 5-msg burst over
   *   5-second window rarely gets hit. The first send is always
   *   immediate regardless of this value.
   */
  constructor(minIntervalMs: number = 1000) {
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * Queue a send. Returns a Promise that resolves when the send completes
   * (or rejects if the send itself throws — the chain continues regardless).
   * Generic over the return type so callers preserve their own types
   * (e.g. `Promise<Message>` from `thread.send`).
   */
  send<T>(sendFn: SendFn<T>, content: string): Promise<T> {
    const result = this.chain.then(async () => {
      if (this.lastSentAt !== null) {
        const elapsed = Date.now() - this.lastSentAt;
        const delay = Math.max(0, this.minIntervalMs - elapsed);
        if (delay > 0) {
          await new Promise<void>((r) => setTimeout(r, delay));
        }
      }
      this.lastSentAt = Date.now();
      return sendFn(content);
    });
    // Don't let one failure break the chain — swallow errors at the chain
    // level so subsequent sends still run.
    this.chain = result.catch(() => {});
    return result;
  }
}
