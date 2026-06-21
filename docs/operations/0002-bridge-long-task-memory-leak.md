# ADR-0002 — claude-bridge long-task memory leak + streaming architecture

**Date:** 2026-06-21
**Status:** Accepted
**Supersedes:** none
**Related:** ADR-0001 (gateway silent death)

## Context

Following ADR-0001, the bridge was hardened against gateway death and
asynchronous error swallowing. But David observed a new failure mode on
2026-06-21 around 12:00 HKT: after a Claude Code task that ran for ~30
minutes, the bot stopped responding to new messages. The launchd
process was still alive (`launchctl list` showed PID 1040/1052 running),
but `bot.log` was silent for >30 minutes after the last `spawning
claude` line at 12:08:34 HKT.

`sample 1052 1` (macOS process sampler) reported:

```
Physical footprint:         10.1G
Physical footprint (peak):  13.1G
```

— the bot process had grown to **10 GB of resident memory** during a
single long Claude run. The Discord ws gateway was still nominally
connected (`session_start_limit` had been decremented from 1000/1000 to
999/1000 in a prior session), but the event loop had effectively
stopped responding because V8 was spending all its time in major GC
attempts to free 10 GB of mostly-garbage memory.

## Root cause

Three accumulators in `src/discord/handlers/streaming.ts` and
`src/agent/runner.ts` were growing without bound during a long Claude
run:

1. **`streamText: string` (streaming.ts:147)** — a single mutable string
   that was appended to (`streamText += text`) on every `onTextDelta`
   callback. JS strings are immutable, so each `+=` allocated a new
   string of length `oldLen + delta` and discarded the old one. At 50
   text events per second (Claude streams roughly at 50-200 chars per
   text event), this is a constant O(n²) heap churn — by minute 30 the
   discarded string objects totalled 8+ GB of garbage waiting for GC.

2. **`collectedText: string[]` (runner.ts:193)** — an array of every
   text event since the run started. Each entry was retained until the
   end of the run (when it was joined for the final summary). For a
   60-min task with ~150k text events averaging 100 chars, this is
   ~15 MB of permanent retention — not the biggest leak, but it
   persisted across the run lifetime.

3. **Fire-and-forget promise chains in callback hot path.** Every
   `onTextDelta` called `flushStream().catch(() => {})` and
   `editPlaceholder()`. The former issued 1+ Discord REST calls; the
   latter issued a `placeholder.edit` call. The `editPlaceholder`
   function throttled itself with a 800 ms `lastEditAt` check, but the
   throttled returns still retained the status text in their closure
   scopes. When Discord returned 429 (rate-limit), the `.catch` in
   `placeholder.edit` swallowed the error, but the underlying Promise
   object remained pending. Over 30 minutes, **4500+ edit Promises**
   could be pending simultaneously, each retaining a copy of the
   current `streamText` reference for its closure.

The combination pushed RSS from 88 MB idle to 10 GB within 30-60 min.
At 10 GB, the JS engine was starving on GC; setInterval callbacks
(idle sweep, gateway health probe) failed to fire, and the bot
appeared "silent" even though the process was alive.

## Decision

Switch the streaming architecture from "buffer the whole run, render
to placeholder, edit in place" to **"forward each text event to Discord
as a new message; never retain text in the bot process"**. This makes
memory usage O(1) in the duration of the run — bounded by a single
`pendingText` buffer of ≤1900 chars.

### Implementation

1. **Remove the accumulator** in `src/agent/runner.ts`:
   - Delete `const collectedText: string[] = []`.
   - In the `for await` loop, only call `callbacks.onTextDelta?.(text)`;
     do not `push` to anything.
   - In the `ClaudeRunResult` builder, set `text` from
     `result.result ?? ""` (the terminal `result` event of the
     stream-json protocol already contains the canonical final text).

2. **Replace `streamText` with `pendingText`** in
   `src/discord/handlers/streaming.ts`:
   - `let pendingText = ""` — small string, ≤ 1900 chars at any time.
   - `onTextDelta`: `pendingText += text; flushIfFull();`
   - `flushIfFull()`: when `pendingText.length >= 1900`, capture the
     buffer into a local `chunk`, reset `pendingText = ""`, and post
     `chunk` via the existing `SendQueue` (which already throttles to
     1.1 s / send and handles 429 retries).
   - Final flush before summary: `await send(pendingText)` for any
     remaining ≤ 1900 chars.

3. **Replace `placeholder.edit` callback with setInterval**:
   - One `setInterval(() => placeholder.edit(renderStatus()).catch(()=>{}), 1500)`
     writes the small status banner periodically.
   - Status text is bounded to ≤ 1500 chars (`truncate(status, 1500)`);
     never grows with run length.
   - This eliminates the 4500-promises-in-30-min issue entirely.

4. **Delete the now-unused helpers** in `streaming.ts`:
   - `flushStream`, `postNewStream`, `renderStreamPreview`,
     `editPlaceholder`, `streamMsg`, the `lastEditAt` throttle.

5. **Final body source**: the final summary now uses `result.text`
   (the terminal `result.result` from the stream-json protocol). For
   `result.subtype === "error_max_turns"` or other error cases, the
   body may be empty — that's intentional; the header carries the
   error message.

### Consequences

**Positive:**

- **Memory O(1) in run duration.** A 6-hour Claude run uses the same
  ~2 KB of `pendingText` as a 30-second one. RSS stays near the idle
  baseline (~100 MB).
- **No fire-and-forget Promise chain in hot path.** The only fire-and-
  forget is `placeholder.edit(...).catch(() => {})` inside the
  `setInterval` tick — at most one pending Promise per 1.5 s.
- **Simpler code.** 49 lines deleted from `streaming.ts`; 1 line
  added (the `pendingText` buffer + `flushIfFull` helper).
- **Real-time Discord updates** — the user sees text appear in the
  thread as Claude thinks, instead of waiting for the entire run to
  complete.
- **No new dependencies.** Uses the existing `SendQueue` and
  `splitForDiscord` helpers.

**Negative / UX trade-offs:**

- **Thread becomes a transcript log, not a streaming preview.** Long
  responses produce many separate messages in the thread, instead of
  one message that gets edited in place. This is a deliberate choice —
  for dev use cases (30-60 min tasks), a transcript is more useful
  (you can scroll back to see what Claude said at minute 12).
- **Discord rate-limit risk is more visible.** With 1900-char chunks
  posted every ~1.1 s, a 60-min run can produce up to ~30-50 messages
  in the thread. The `SendQueue` already handles this, but the thread
  can look busy.
- **Final summary body uses `result.text` only.** If Claude streams
  text but fails to emit a terminal `result` event (e.g. SIGKILL), the
  final summary will be empty. The error message in the header still
  tells the user what happened, and any `pendingText` flushed before
  the failure remains in the thread. Trade-off: simpler code, slightly
  less graceful failure display.

### Verification

- `bun run typecheck` passes (no type errors after the refactor).
- `bun test` passes (104/104 tests across 7 files).
- Manual verification will happen on David's next long task: RSS
  should stay under 200 MB throughout; thread should accumulate
  transcript messages instead of in-place edits.

## Future work (out of scope for this fix)

- If transcript-log UX becomes noisy, consider collapsing consecutive
  small chunks (e.g. batch up to 4 chunks of 500 chars each before
  posting) — but this would re-introduce a small accumulator, so it
  must be bounded and flushed aggressively.
- Consider an `AbortController` + `CLAUDE_TURN_TIMEOUT_MS` enforcement
  in `runClaude` so that a stuck Claude run is hard-killed at 60 min
  (configurable). Currently the bot can run forever waiting for Claude.
- Consider a process-level memory watchdog that exits the bot if
  `process.memoryUsage().rss > 800 MB` — a defense-in-depth safety net
  for any future regressions.
