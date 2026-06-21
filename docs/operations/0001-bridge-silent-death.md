# ADR-0001 — claude-bridge silent-death incident + fix

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** David Chu, claude-bridge (agent)

## Context

On 2026-06-21 at 09:59 HKT, David sent `@bot aged-system 項目做phase1b` in the
configured dev channel. The bot never replied. No thread was created, no
error appeared in `bot.err.log`, no log line was emitted after 10:17 HKT
(spawning claude). Yet:

- `launchctl list` showed `com.claudebridge.bot` PID 69953 still running
- `ps` showed the bot's `bun run src/index.ts` process alive (1h47m uptime)
- `/gateway/bot` returned `session_start_limit: 1000/1000` remaining,
  meaning the bot had never disconnected its ws (so Discord thought the
  bot was still listening)
- But every subsequent David message in the channel went unanswered

In other words: **the bot was alive but silently deaf**. Subsequent
investigation via REST API confirmed this — a fresh injected message
also got no reply.

## Root cause (three layered)

1. **macOS Background process + ws keepalive:** When `ProcessType=Background`
   in the LaunchAgent plist, macOS aggressively throttles network sockets
   after the app is "idle" (no UI). The Discord gateway WebSocket
   connection is silently severed by the kernel without an event
   surfacing in Node/Bun, and discord.js's auto-reconnect logic does
   not always re-fire `Resumed` after this kind of OS-level teardown.
   `session_start_limit` remaining=1000/1000 confirmed that the bot
   never noticed the disconnect.

2. **No `unhandledRejection` / `uncaughtException` trap:** `src/index.ts`
   only hooked `SIGINT` / `SIGTERM`. Any async error thrown outside the
   per-handler `.catch(err => log.error(...))` chain (such as from the
   ws heartbeat tick, or a future code path) was silently swallowed.
   The process kept running, KeepAlive was satisfied, no restart.

3. **Plist `KeepAlive.SuccessfulExit=false` (already fixed in commit
   72653b8):** Caused a separate earlier symptom — graceful SIGTERM
   exit would never respawn. This was addressed previously; the
   current incident was a different failure mode layered on top.

## Decision

Implement defense in depth so that any of the above failure modes
results in either (a) a logged error or (b) a process exit that
launchd KeepAlive will respawn:

1. **Global error traps in `src/index.ts`:**
   - `process.on('unhandledRejection', ...)` — log full reason + stack
   - `process.on('uncaughtException', ...)` — log + `setTimeout(() => process.exit(1), 250)`
     to flush the log line first. KeepAlive (`Crashed=true`) will
     respawn.

2. **Gateway health probe in `src/index.ts`:** Every 5 minutes, check
   `client.ws.status`. If it is not `READY (0)` or `RECONNECTING (2)`,
   start a grace timer. If the disconnect persists for more than 10
   minutes, log the failure and `process.exit(1)` — letting KeepAlive
   respawn with a clean ws handshake. Also adds explicit
   `ShardDisconnect` / `ShardReconnecting` event handlers in
   `src/discord/client.ts` for visibility.

3. **Hard resource limits (plist):** Add `NumberOfFiles=512` next to
   the existing `NumberOfProcesses=3` and `ResidentSetSize=1GB`.
   Background processes are more prone to fd exhaustion under network
   throttling; an explicit cap makes the failure mode predictable.

4. **launchd-wrapper.sh singleton guard (commit 72653b8):** Already in
   place. Kills any stale `bun run src/index.ts` whose CWD matches the
   project root before exec'ing the real command, preventing the
   4-zombie scenario observed earlier.

5. **Memory watchdog (commit 72653b8):** Already in place. Logs free
   RAM every 60s with 15-min cooldown; fires `osascript` banner at
   <1GB (warn) and <500MB (critical) — preventing the silent
   "insufficient memory to spawn claude" failure mode.

## Consequences

**Positive:**
- Any future silent death either leaves an error in `data/bot.err.log`
  (visible in `tail` / Discord alerts) or causes a clean process exit
  that launchd respawns within `ThrottleInterval=10s`.
- Gateway health probe means the worst-case "stuck deaf" window is
  bounded at 10 minutes, with explicit logging.
- `unhandledRejection` trap will surface bugs that previously would
  have been invisible — strict but necessary.

**Negative / Risks:**
- `process.exit(1)` on `uncaughtException` is aggressive — a single
  unhandled error mid-session kills the bot. Acceptable because
  KeepAlive respawns in <10s and the alternative is silent failure.
- Gateway probe's 10-min grace might be too generous for some scenarios.
  Tunable; default errs on the side of fewer false-positive respawns.
- `NumberOfFiles=512` could be too low for bot's full fd budget. If
  `EMFILE` errors appear, raise to 1024.

## Verification

- typecheck: `bun run typecheck` passes
- live reload: `launchctl bootstrap` with the updated plist succeeded;
  bot PID 1040 alive, `discord ready` in logs, `gateway health probe
  started` log line present
- E2E: awaiting David's manual `@bot ping` to confirm a thread is
  created and Claude spawns

## Follow-ups (out of scope for this fix)

- Consider running the bot under `ProcessType=Standard` (not
  Background) to see if macOS throttles less aggressively. Trade-off:
  higher CPU scheduling class, may fight for CPU with foreground apps.
- Consider a thin heartbeat from bot to its own `/users/@me` endpoint
  every 60s to keep the kernel from declaring the ws idle.
- Once macOS 15+ Tahoe is widely deployed, revisit the throttling
  behavior of `Background` processes.
