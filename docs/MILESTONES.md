# claude-bridge — Milestones

## Week 1 — Discord Skeleton

**Goal**: Bot online, mentions work, threads get created.

### Tasks
- [x] T1.1: project skeleton (package.json, tsconfig, env loading)
- [x] T1.2: discord.js client connects, logs ready
- [x] T1.3: detect `@bot` mention in configured channel
- [x] T1.4: create thread from mention message
- [x] T1.5: parse repo URL from message (github/gitlab patterns)
- [x] T1.6: SQLite session store (create + read)
- [x] T1.7: thread metadata inserted on creation
- [x] T1.8: basic logger
- [x] T1.9: README with setup instructions

### Deliverable
- Bot runs with `bun run dev`
- `@bot hello` in #dev creates a thread called "hello"
- URL parse works for common patterns
- Session row exists in `data/sessions.db`

---

## Week 2 — Claude Code CLI Integration

**Goal**: A single thread can call Claude Code and get a response.

### Tasks
- [x] T2.1: agent runner wrapper around `claude -p --stream-json`
- [x] T2.2: spawn subprocess from bot, pipe output back
- [x] T2.3: parse stream-json events → typed objects
- [x] T2.4: send claude output as Discord message
- [x] T2.5: edit Discord message as output streams
- [x] T2.6: handle `--resume <sessionId>` for follow-ups

### Deliverable
- Mentioning `@bot summarize README.md` actually runs Claude Code
- Output appears in the thread (in-place edits, throttled)
- Second mention in same thread resumes the session

---

## Week 3 — Docker Containerization

**Goal**: Each thread runs in its own Docker container for isolation.

### Status: ❌ **Abandoned**

After a first implementation (one-off containers per message, then a
long-running container with `container.attach()` + manual stdout demux)
we ran into reliability issues with multi-turn streaming and decided the
isolation wasn't worth the complexity for a single-user local bot.
The Docker code was removed and we settled on the host-based CLI
implementation that's in `main` now (see `src/agent/runner.ts`).

If isolation ever becomes important, the abandoned Docker implementation
can be revived from git history. The `sessions.container_id` column is
kept (and cleared on `/kill`) for forward compat.

### Tasks
- [~] T3.1: Dockerfile for agent (Bun + Claude Code CLI) — abandoned
- [~] T3.2: docker-compose.yml for one-shot container runs — abandoned
- [~] T3.3: agent entry inside container: read prompt, run claude, stream out — abandoned
- [~] T3.4: host-side Dockerode spawner — abandoned
- [~] T3.5: mount `~/.claude` (ro) and per-thread workspace dir — abandoned
- [~] T3.6: git clone happens on host before container start — kept (host-only)
- [~] T3.7: container ID stored in SQLite — column kept for forward compat
- [~] T3.8: cleanup task: stop idle containers — N/A in host-based mode
- [~] T3.9: `/kill` slash command destroys container — kept, now kills subprocess

### Deliverable
- ~~Thread starts a real container~~
- ~~Files written by claude appear on host~~
- ~~Container dies on idle or `/kill`, files persist~~

The host-based alternative delivers the same end result (one process
per message, files persist on host, `/kill` stops the run) without
requiring a Docker daemon.

---

## Week 4 — Streaming, Session, Polish

**Goal**: Real interactive dev experience.

### Tasks
- [x] T4.1: rich Discord embeds (tool calls, file edits, bash)
- [x] T4.2: in-place message editing as stream progresses
- [x] T4.3: error handling (subprocess crash, claude error)
- [x] T4.4: slash commands (`/repo`, `/kill`, `/status`, `/projects`)
- [x] T4.5: graceful shutdown (SIGTERM all subprocesses on bot SIGTERM)
- [x] T4.6: launchd / systemd service file
- [x] T4.7: production deploy guide
- [x] T4.8: final README + architecture diagrams

### Deliverable
- Production-ready, runs on host reboot
- Smooth dev experience from Discord

---

## Stretch (post v1)

- [ ] Web dashboard showing all active sessions
- [ ] Approval gate for dangerous commands
- [ ] Multi-user support
- [ ] Voice channel commands
- [ ] Slack / Telegram adapters

---

## Phase 1 — Claude Agent SDK path (parallel to CLI)

**Goal**: Eliminate the `pendingText` / `flushIfFull` leak class by giving
Claude Code a tool to talk to Discord directly, instead of having the
bot parse the entire stream-json output.

### Context

The CLI runner ingests every `stream-json` event from Claude and
buffers text in the bot process (`pendingText`). The 10 GB leak
(`5f2693a`) was the most visible symptom, but the bot's hot path
remained a stream-parsing + chunking pipeline no matter what. The
Claude Agent SDK lets us instead spawn `claude` with an in-process MCP
server, where Claude decides when to send by calling our tools.

### Tasks
- [x] Install `@anthropic-ai/claude-agent-sdk@^0.3.185`
- [x] Add `CLAUDE_USE_SDK`, `CLAUDE_SDK_MODEL`, `CLAUDE_SDK_PERMISSION_MODE` to `config.claude`
- [x] `src/agent/systemPrompt.ts` — load user's system prompt file, cache once
- [x] `src/agent/discordTool.ts` — four tools via `createSdkMcpServer` + `tool()` factory (Zod schemas, MCP-style `CallToolResult` handlers)
- [x] `src/agent/sdkRunner.ts` — `query()` per Discord message with `options.resume`; tracks active queries for `/kill`; surfaces final stats header
- [x] `src/discord/handlers/streaming.ts` — branches on `config.claude.useSdk`; SDK path bypasses `pendingText` / `flushIfFull` / `editInterval` entirely
- [x] `src/discord/handlers/commands.ts` — `/kill` for SDK path calls `abortSdkRun(threadId)`
- [x] Tests: `discordTool.test.ts` (12 tests), `sdkRunner.test.ts` (5 tests)

### Deliverable
- `CLAUDE_USE_SDK=1` opts the whole bot into the SDK path; CLI path is preserved verbatim for fallback
- SDK path produces identical end-user UX: stats header + CC messages in thread + ✅ reaction
- `pendingText`, `flushIfFull`, `toolUses[]` accumulation in streaming handler are gone from the SDK branch — leak class removed by construction

### Notes
The MCP layer in `@modelcontextprotocol/sdk` uses `zod-to-json-schema@^3`
which is **Zod 3 only**. The Claude Agent SDK itself ships Zod 4
internally; mixed versions cause every tool call to fail with
`Zod validation error`. We pin `"zod": "^3.25"` and add an `overrides`
entry in `package.json` so the whole tree resolves to a single Zod 3.

---

## Phase 1 follow-up — System prompt forces `discord_send`

**Symptom** (discovered in first smoke test): with the SDK path enabled,
Claude ran for 89.9s and used 6 tools (Read, Bash, etc.) but never called
`discord_send`. The bot displayed the stats header and nothing else.

**Root cause**: CC's default behavior is to produce a final text
response. The text from the assistant message is not posted to Discord
— only `discord_send` tool calls are. CC's training didn't push it
toward the MCP tools, so it defaulted to text + a few built-in tool
calls.

**Fix** (`src/agent/systemPrompt.ts`): prepend a strong
`DISCORD_PROMPT_PREFIX` to the user's system prompt file. The prefix
mandates `discord_send` for any visible output, with WRONG/RIGHT
examples contrasting the two behaviors.

### Tasks
- [x] Add `DISCORD_PROMPT_PREFIX` constant with mandatory rules + tool reference + correct/incorrect examples
- [x] Compose `cached = DISCORD_PROMPT_PREFIX + "\n\n" + userPrompt` at boot

---

## Phase 2 — Per-thread runner control

**Goal**: Make the SDK the default runner for all new threads, with
per-thread overrides and a global kill switch. CLI runner code stays
in place (removed in Phase 3).

### Tasks
- [x] `src/types.ts` — `RunnerKind = "cli" | "sdk"`, `runnerKind` field on `Session`
- [x] `src/db/index.ts` — additive migration adds `runner_kind` column with default `'sdk'`; new `setRunnerKind()` method; `rowToSession` falls back to `'cli'` for legacy rows
- [x] `src/db/index.ts` — `store.create()` accepts optional `runnerKind` argument (default `'sdk'`)
- [x] `src/discord/handlers/streaming.ts` — branch becomes `config.claude.useSdk && session.runnerKind === "sdk"` (env var is global kill switch, per-thread decides)
- [x] `src/discord/handlers/commands.ts` — `/use-cli`, `/use-sdk` commands; `/status` shows runner kind; `/kill` checks `session.runnerKind` (not env var) to decide whether to abort SDK query
- [x] `src/discord/help.ts` — document new commands + SDK default
- [x] Tests: 4 new db migration tests + 13 new commands tests

### Deliverable
- New threads default to SDK runner
- `/use-cli` / `/use-sdk` switches per-thread
- `CLAUDE_USE_SDK=0` forces CLI globally (kill switch)
- Existing threads created before the migration continue on CLI until the user explicitly switches them
- `/status` shows the runner kind for transparency

### Notes
- SDK session IDs and CLI session IDs use different on-disk formats
  (different subkeys under `~/.claude/projects/`). Switching runners
  mid-thread loses context; this is documented but not enforced.
- `/use-sdk` calls `abortSdkRun(threadId)` if a run is in flight, so
  the new runner takes effect immediately on the next message.

---

## Phase 1.5 follow-up — Auto-surface CC plain text

**Symptom** (after Zod 3 fix): CC produced well-formed text replies
but still didn't call `discord_send` reliably. Discord users saw only
the stats header.

**Root cause**: even after Zod was fixed and CC *attempted*
`discord_send`, many calls still failed (intermittent runtime
issues, e.g. content length validation). When CC tried and failed,
subsequent text replies would have been duplicated if we always
auto-posted, so the previous "only post if CC didn't use send" gate
suppressed all text.

**Fix** (`src/agent/sdkRunner.ts`): for each assistant message:
- If `msg.message.content` contains any `tool_use` block, skip
  auto-post (CC's content already reaches Discord via `discord_send`).
- Otherwise, strip `<thinking>...</thinking>` blocks, split via
  `splitForDiscord(1900)`, and post each chunk via the
  SendQueue-wrapped `send`. Empty after stripping → skip.

### Result
The user sees CC's text replies regardless of whether CC successfully
called `discord_send`. Duplicates are possible but rare and tolerable.

---

## Phase 3 — Remove CLI runner (not started)

Stable for ≥2 weeks on SDK, then delete `src/agent/runner.ts` and
`src/agent/events.ts` and the CLI branch in `streaming.ts`.
`runner_kind` column can stay (or be removed) — preference TBD.
