# claude-bridge — Code Audit (Phase 1)

> Read 17 source files + config + deploy + docs.
> Categorized: 🔴 bugs/risks · 🟡 reliability · 🟢 maintainability · 🔵 performance · ⚪ feature gaps

---

## 🔴 Bugs / Risks (production could break)

### R1. `MAX_CONCURRENT_CONTAINERS` and `IDLE_TIMEOUT_MIN` are declared but **never enforced**
- `src/config.ts:42-43` reads them
- `src/cleanup.ts` only has process tracking + SIGTERM — no concurrency cap, no idle sweep
- Taskboard explicitly flags this: "Open Questions: *enforcement deferred*"
- **Risk**: bot will happily spawn 50 concurrent `claude -p` processes if 50 threads are active → exhausts memory, file descriptors, Anthropic rate limits
- **Fix**: in `handleMessageCreate` (or a wrapper), check `activeProcessCount() >= maxConcurrentContainers` and reply "⏳ N runs in flight, please wait" before spawning. Add a `setInterval` idle sweep in `index.ts` that calls `setStatus(threadId, 'idle')` for sessions with `last_activity_at < now - IDLE_TIMEOUT_MIN*60_000`.

### R2. `runClaude` stderr pipe is **drained only after exit** — deadlock potential
- `src/agent/runner.ts:198` `await new Response(proc.stderr).text()` — this only happens after the `for await` loop ends
- If `claude` writes >64KB to stderr while the bot is mid-parse of stdout, the child blocks on its next stderr write
- **Risk**: silent hangs; user sees the bot "thinking" forever with no error
- **Fix**: spawn a second `for await` task in parallel that drains stderr continuously and logs warnings as they come.

### R3. `gitClone` runs without a timeout — `git clone` of a huge repo can hang indefinitely
- `src/utils/git.ts:14-22` — no timeout, no progress feedback
- **Risk**: thread is silently stuck; user has no way to know whether to wait or `/kill`
- **Fix**: wrap with `Promise.race` against a 5-min timeout (configurable). On timeout: `proc.kill()`, return error.

### R4. `optionalInt` accepts negative numbers
- `src/config.ts:21-27` — `parseInt("-1", 10)` is `-1`, not rejected
- **Risk**: `MAX_CONCURRENT_CONTAINERS=-1` is "unlimited"; `IDLE_TIMEOUT_MIN=-1` means "sweep every minute to the future"
- **Fix**: add `if (n < 0) throw new Error(...)`.

### R5. `Bun.spawn` is called with no `env` sanitization
- `src/agent/runner.ts:139` — `env: { ...process.env }` forwards the entire process env, including Discord token, `~/.aws/credentials`, etc.
- **Risk**: lower here because `claude` is a trusted local tool, but worth flagging if anyone ever sets a non-default `cwd`. Also a leak surface for any future "approval" feature.
- **Fix**: consider explicitly listing the env keys to pass (PATH, HOME, USER, ANTHROPIC_API_KEY, etc.). Or document the trust model.

### R6. `isValidLocalPath` does an `existsSync` check but the user can race a deletion between check and use
- `src/discord/parser.ts:181` + `src/discord/handlers/messageCreate.ts:341-346`
- Low risk in single-user, low-concurrency local use, but flag it.
- **Fix**: in `runClaude`, wrap the `Bun.spawn` in try/catch and produce a clear "work dir disappeared" error if it fails with `ENOENT`.

### R7. `process.kill(pid, "SIGTERM")` in `cleanup.ts` does not wait for actual exit
- `src/cleanup.ts:27-33` — sends SIGTERM, then immediately clears the set and lets the bot exit
- **Risk**: if a child is in the middle of a long sync, it can be orphaned (parent dies → child becomes init's child, keeps running with files open)
- **Fix**: in `killAllProcesses`, after SIGTERM, wait a grace period (e.g. 2s) and SIGKILL the survivors. Optionally block the process exit on this.

### R8. `claudeSession` is stored as empty string when no resume session, never normalized
- `src/db/index.ts:99-103` — `setClaudeSession(threadId, "")` will happily write `""` to the column
- The schema allows NULL but never sets NULL on a fresh run
- **Risk**: minor — a row with `claude_session = ''` looks identical to `claude_session IS NULL` in app code, but if any future query does `WHERE claude_session = 'something'`, it won't match empty strings correctly
- **Fix**: store NULL when there's no session (change the type to `string | null` and write `null` on `onSessionId("")`).

---

## 🟡 Reliability

### L1. `forwardToClaude` is ~300 lines and embeds five concerns
- `src/discord/handlers/messageCreate.ts:485-794`
- Concerns: stream throttling, message edit, placeholder finalization, header building, question detection, reaction on completion
- **Fix**: extract into 3-4 modules: `streamRenderer.ts`, `summaryBuilder.ts`, `runWithDiscordCallbacks.ts` (or one orchestrator file)

### L2. No retry on Discord rate-limit errors
- Many `try/catch` blocks in `messageCreate.ts` (lines 567, 608, 704, 754) just `// ignore rate-limit`
- discord.js has built-in rate-limit handling but only for some calls; the `.edit()`/`.send()` calls here don't use the rest client helper
- **Fix**: at minimum, log the rate-limit error with the retry-after seconds so it shows up in `LOG_LEVEL=debug`. Better: factor all `thread.send` / `msg.edit` through a single `sendOrLog(channel, content)` helper that retries once on 429.

### L3. `parseMention` regex matches URLs *anywhere* in the text — including inside the prompt
- `src/discord/parser.ts:51-63` — `extractRepoUrl` returns the first URL match in the *stripped* content, which includes the prompt body
- **Risk**: if the user writes `@bot help me debug https://github.com/foo/bar/blob/main/auth.js` thinking it's just context, the bot will try to `git clone` the repo
- **Fix**: only look for URLs that come at the start, end, or after a clear preposition. Or require the URL be the only "target" (no prompt allowed alongside, or URL must be first token).

### L4. `applyTarget` doesn't reset the in-flight session state
- `src/discord/handlers/messageCreate.ts:426-464` — `/repo <new>` updates DB fields, but if there's a `runClaude` in flight, that subprocess is still pointed at the old `cwd`
- **Risk**: minor — the in-flight call completes against the old dir, the next message uses the new one. Inconsistency.
- **Fix**: log a warning, and document that `/repo` is "for the next message" semantics.

### L5. `idempotencyKey` for /repo /kill: not implemented
- The same `/kill` issued twice will both reply "Session killed" (line 257) — the second is a no-op but the user gets a confusing reply
- **Fix**: if status is already 'killed', reply "Already killed" instead.

### L6. `claudeSession` value can be `""` from a failed first run
- If `claude` exits before emitting the `init` event, `sessionId` stays as `opts.sessionId ?? ""`
- `setClaudeSession(threadId, "")` writes empty string, which is then passed as `--resume ""` to the next run
- **Fix**: skip `setClaudeSession` if empty; also in the next `runClaude`, if `opts.sessionId === ""`, treat it as no resume.

### L7. No graceful handling of `claude` being missing at startup
- `src/agent/runner.ts:127-132` throws per-call, but the bot still starts up
- A user who forgets to install `claude` will see the bot online but every request fails
- **Fix**: in `index.ts` startup, do a `Bun.which("claude")` check and log a fatal warning if missing.

### L8. `ProjectRegistry` is loaded once on startup — never reloaded
- `src/index.ts:31` — `new ProjectRegistry({...})` calls `reload()` in constructor
- If the user creates a new project in `~/www/` while the bot is running, `/projects` won't show it
- **Fix**: add a `/reload` slash command or watch the directory. Low priority for single-user.

---

## 🟢 Maintainability

### M1. `messageCreate.ts` is 795 lines — single largest file
- Already noted as L1 from a *reliability* angle
- From maintainability: hard to grep, hard to test, hard to review
- **Fix**: split into `mention.ts` (top-level mention flow), `threadReply.ts` (thread reply flow), `slashCommands.ts`, `streamRenderer.ts`, `summary.ts`

### M2. `void ChannelType;` at the bottom of `messageCreate.ts:796`
- This is a "force-import" hack — the type is imported but never used
- The import was probably leftover from when the file did thread-channel switching
- **Fix**: delete the import and the `void` statement.

### M3. Dead config keys: `docker.agentImage`, `docker.network`
- `src/config.ts:46-49` — Week 3 Docker was abandoned, but the keys remain
- The schema even has a `container_id` column "kept for forward compat"
- **Fix**: remove the `docker` block from `config.ts` and `.env.example`. Drop `container_id` from the schema. (Backward-compat note: existing DB rows with `container_id IS NOT NULL` will be fine after the column is dropped with a migration.)

### M4. Dead DB methods: `setContainer()`, `delete()`
- `src/db/index.ts:93-97, 119-121` — `setContainer` is no longer called (Docker removed), `delete` is no longer called (no session cleanup flow)
- **Fix**: either wire them up (delete = `/sessions` or admin command, setContainer = future) or remove.

### M5. `lint` script in `package.json` references a non-existent file
- `package.json:9` — `"lint": "bun run scripts/lint.ts"` but `scripts/lint.ts` doesn't exist (only `migrate.ts`)
- **Fix**: either add a real lint script (e.g. `bun run --print src/index.ts 2>&1 | head` placeholder) or remove the line. Or use `biome` / `eslint`.

### M6. `isValidLocalPath` exposes `existsSync` check that is duplicated in `applyTarget`
- `parser.ts:170-185` and `handlers/messageCreate.ts:443-450` both do path validation
- **Fix**: consolidate; consider returning a discriminated union.

### M7. `TOOL_ICON` is a const but `formatToolUse` switches on the same name — duplicated source of truth
- `handlers/messageCreate.ts:158-222` (switch) and `209-222` (icon map)
- If a new tool is added, both must be updated
- **Fix**: merge into one `formatToolUse(name, input): { icon, detail }` returning both fields.

### M8. `containsQuestion` heuristic is locale-fragile
- `handlers/messageCreate.ts:117-133` — checks for English phrases only
- Mixed Chinese/English responses (your use case) will miss "你想" / "需要我"
- **Fix**: add Chinese/your-language patterns. Or use a simpler heuristic: any `?` / `？` in last 250 chars AND no period immediately before.

### M9. `@/*` path alias declared in tsconfig but no runtime resolution
- `tsconfig.json:27-29` declares `"@/*": ["src/*"]`
- But `bun` doesn't auto-resolve this for runtime imports; the `Bun.build` config also doesn't have an alias
- Currently no `@/...` imports exist, so it's harmless — but it's a footgun
- **Fix**: either remove from tsconfig or add a `bunfig.toml` alias + document the convention.

### M10. `tsconfig` is missing `noUncheckedIndexedAccess`
- Strict mode is on, but `arr[i]` still returns `T`, not `T | undefined`
- The code uses a lot of `arr[arr.length - 1]` patterns that would benefit
- **Fix**: enable it. May surface 2-3 minor fixes in runner.ts and messageCreate.ts.

### M11. Magic numbers scattered in `messageCreate.ts`
- 1900 (Discord chunk size), 1800 (overflow threshold), 800 (throttle ms), 150 (post delay), 8000 (typing tick), 200/150/120/100/80/60 (truncate limits)
- **Fix**: extract to a `constants.ts` with named constants and short comments.

### M12. `optional` and `optionalInt` in `config.ts` are not exported
- Reusable validation helpers that other modules (e.g. plugins) might want
- **Fix**: either export or inline-document the validation policy.

### M13. `logger.ts` doesn't include log correlation across requests
- A single stream run emits ~50 logs with no shared ID
- Hard to grep a specific run's history
- **Fix**: add a `runId` (short random) that gets attached to all logs from a single `runClaude` invocation.

---

## 🔵 Performance

### P1. `forwardToClaude` does 1 Discord edit per text delta
- `onTextDelta` calls `editPlaceholder()` (throttled) and `flushStream()` (unthrottled)
- If `claude` emits a long burst, `flushStream` can post many messages rapidly
- The 150ms `setTimeout` (lines 576, 593, 756) is the only rate-limit damper
- **Risk**: Discord global rate limits are 5 messages / 5s per channel; a burst will hit them
- **Fix**: wrap all `thread.send` calls in a single rate-limited queue (e.g. p-queue or a simple `Promise` chain with delays).

### P2. `ProjectRegistry` reads the entire `PROJECTS_ROOT` with `withFileTypes` and `statSync` on every entry
- `src/projects/registry.ts:94-117` — 61 dirs = 61 `statSync` calls, blocking the event loop
- For 61 dirs this is fast (<50ms), but scales linearly
- **Fix**: use `readdirSync(root, { withFileTypes: true })` (already does) and skip the inner `statSync` if `entry.isDirectory()` is true. The `isSymbolicLink` case can be checked lazily. Saves one syscall per entry.

### P3. `parseMention` is called synchronously per message
- 5 regex passes plus `projects.resolve` (Map.get) per token
- For 61 projects and a 50-word message, ~300 Map lookups in the fallback case
- Fast enough, but if the project count grows to 1000s, this becomes noticeable
- **Fix**: build a precomputed `Set<string>` of known project names for O(1) token matching. Currently uses `Map.get` per token which is O(1) already, but with string allocations for `toLowerCase` per call.

### P4. `setInterval` for typing indicator is never cleared if a promise rejects
- `startTypingIndicator` returns a `stop()` function — `forwardToClaude` calls it at line 682
- But if `runClaude` throws *synchronously* before `stopTyping = startTypingIndicator` line is reached, no leak
- Actually the line is right after `await thread.send("⏳ Running...")`, so by the time `runClaude` is called, `stopTyping` is bound. **No issue here**, just flagging that the pattern is correct.

### P5. `db.setLocalPath` does an UPDATE that resets `repo_path` — can race with `forwardToClaude`
- `src/db/index.ts:111-117` — UPDATE in applyTarget vs. UPDATE in `forwardToClaude` via `touch()` (only touches `last_activity_at` though, so no actual race)
- **Not an issue** — touch only updates `last_activity_at`. Just confirming.

---

## ⚪ Feature Gaps (from taskboard + observation)

### F1. Web dashboard for active sessions
- Taskboard stretch goal. Lowest cost: a `GET /sessions` HTTP endpoint on a small Bun.serve() that returns JSON. ~50 LoC.

### F2. Approval gate for dangerous ops
- Taskboard stretch goal. Today: `permissionMode` is passed to `claude`, defaults to `acceptEdits`. To add a gate: intercept `tool_use` events in `onToolUse`, if `name === "Bash"` and `command` matches a danger pattern, post a "⏸️ waiting for approval" and wait for `y/n` reaction.

### F3. Auto-cleanup of `~/www/discord-claude-tasks/*`
- `taskRepoPath` creates a per-thread dir for git-URL sessions
- These accumulate forever; no sweep
- **Fix**: add to the idle sweep (R1) — when a session goes idle, after 24h delete its `TASKS_ROOT/<threadId>/` if `repo_url` is set.

### F4. Multi-user support
- By design, single-user. The `DISCORD_USER_ID` check at `messageCreate.ts:231` enforces it. If multi-user ever needed: per-user `allowedUserIds[]` and per-thread ownership checks.

### F5. `MAX_CONCURRENT_CONTAINERS` actually enforced (R1 is the bug; F5 is the feature)

### F6. `IDLE_TIMEOUT_MIN` actually enforced (same as above)

### F7. Slack/Telegram adapters
- Taskboard stretch. The `parseMention` + `handleMessageCreate` could be split into a `dispatcher` interface, with Discord being one adapter. ~1-2 days of work per adapter.

### F8. Cost / token metrics export
- Today: per-message summary in the thread. No aggregate view.
- **Fix**: log to a `runs.jsonl` (one line per `runClaude` completion) with `{ts, sessionId, durationMs, costUsd, tokens, toolCount}`. Then a simple `bun run scripts/stats.ts` to aggregate.

### F9. `/diff` slash command — show what files Claude changed
- Useful follow-up after a session
- **Fix**: `git -C <repoPath> diff --stat HEAD@{1} HEAD` (or `git status`)

### F10. `restart.sh` is in `deploy/` but not wired to launchd / systemd
- Check `deploy/restart.sh` — manual-only today
- **Fix**: add a `--restart` to the plist, or document the manual workflow.

---

## Quick Stats

| Area | Count | Top priority |
|------|-------|--------------|
| 🔴 Bugs / Risks | 8 | R1, R2 (enforcement + pipe deadlock) |
| 🟡 Reliability | 8 | L1, L3 (split file, regex strictness) |
| 🟢 Maintainability | 13 | M1, M3, M5 (split, dead code, broken lint script) |
| 🔵 Performance | 5 | P1 (rate-limit queue) |
| ⚪ Feature Gaps | 10 | F1, F2, F3 (dashboard, approval, cleanup) |
| **Total** | **44** | |

## Recommended next phase (if you proceed)

1. **One PR** for: R1 (enforce concurrency + idle sweep) + R3 (git timeout) + R4 (negative-int check) + R6 (work-dir ENOENT) — all small, contained, all "make production safer"
2. **One PR** for: M2 + M3 + M5 (delete `void ChannelType;`, drop docker config, drop broken `lint` script) — pure cleanup
3. **One PR** for: L1 + M1 (split `messageCreate.ts` into 3-4 modules) — the biggest maintainability win
4. **One PR** for: R2 + P1 (stderr drain + send-queue) — reliability + perf
5. **Then** F1 (dashboard) as a self-contained feature

Each PR is independently shippable. Together: ~1-2 weeks of focused work.
