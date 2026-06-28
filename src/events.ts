/**
 * Hermes Tracker — in-process event bus.
 *
 * Lightweight pub/sub for live updates. The HTTP server subscribes
 * here to push SSE events to connected clients whenever the bot's
 * state changes (e.g. journal append, session created, message
 * archived).
 *
 * Why a separate module:
 *   - The state layer shouldn't know about HTTP (decoupling).
 *   - Tests can use a fresh emitter per case (no global state).
 *   - The EventEmitter is process-local; SSE works because the
 *     frontend stays connected to the same process.
 *
 * Event shape (union of all possible emissions):
 *   - { kind: "journal", projectId, entry: JournalEntry }
 *   - { kind: "message",  sessionId, message: Message }
 *   - { kind: "state",    sessionId, status: string }
 *
 * Subscribers receive ALL events (filter by kind on their side).
 * For P3+ with high event volume, we can add per-project channels.
 */

import type { JournalEntry } from "./hermes/types";
import type { Message } from "./messages";

export type AppEvent =
  | { kind: "journal"; projectId: string; entry: JournalEntry }
  | { kind: "message"; sessionId: string; message: Message }
  | { kind: "state"; sessionId: string; status: string };

// Node's EventEmitter is fine here — Bun fully supports it. The
// `unknown` payload type matches the AppEvent union so consumers
// can narrow with a discriminator check.
import { EventEmitter } from "node:events";

class TypedEmitter extends EventEmitter {
  emit(event: "app", payload: AppEvent): boolean {
    return super.emit(event, payload);
  }
  on(event: "app", listener: (payload: AppEvent) => void): this {
    return super.on(event, listener);
  }
  off(event: "app", listener: (payload: AppEvent) => void): this {
    return super.off(event, listener);
  }
}

// Singleton — the bot process has one and only one event bus.
// Multiple subscribers (the HTTP server) all share it.
export const appEvents = new TypedEmitter();

// Set a higher limit than the default 10 — SSE handlers in the HTTP
// server will attach many listeners over the process lifetime.
appEvents.setMaxListeners(1000);
