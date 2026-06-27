# claude-bridge — System Architecture

## High-Level Diagram

Three layers stacked on a single Discord bot process:

```
                    ┌────────────────────────────────────────┐
                    │ Discord                                │
                    │  Channel: #dev                         │
                    │  ├─ @bot <prompt>     (1-shot)         │
                    │  └─ /project start    (Hermes PM loop) │
                    └────────────────────┬───────────────────┘
                                         │ Discord WebSocket
                    ┌────────────────────▼───────────────────┐
                    │ claude-bridge bot                      │
                    │                                        │
                    │  ┌────────────┐    ┌─────────────┐     │
                    │  │ @bot flow  │    │ /project    │     │
                    │  │ (mention   │    │  (Hermes    │     │
                    │  │  parser)   │    │  commands)  │     │
                    │  └─────┬──────┘    └──────┬──────┘     │
                    │        │                  │            │
                    │        ▼                  ▼            │
                    │  ┌──────────┐   ┌──────────────────┐  │
                    │  │ runner   │   │ Hermes           │  │
                    │  │  (CLI or │   │  orchestrator    │  │
                    │  │   SDK)   │   │  + planner/judge │  │
                    │  └─────┬────┘   │  + executor      │  │
                    │        │        │  + typing        │  │
                    │        │        │  + state on disk │  │
                    │        │        └────────┬─────────┘  │
                    │        │                 │            │
                    │        └────────┬────────┘            │
                    │                 ▼                     │
                    │       ┌─────────────────┐             │
                    │       │ runViaSdk()     │             │
                    │       │ (per task)      │             │
                    │       └─────────────────┘             │
                    └─────────────────────┬───────────────┘
                                          │
                                          ▼
                    ┌────────────────────────────────────────┐
                    │ Claude Code (host subprocess)          │
                    │  cwd = <work dir>                      │
                    │  Files written directly to host        │
                    └────────────────────────────────────────┘
```

For the Hermes layer, see [`docs/operations/0003-hermes-agent.md`](operations/0003-hermes-agent.md).
For the underlying runners (CLI vs SDK), see "IPC: Bot ↔ Claude" below.

## File / Data Flow

### @bot mention flow (1-shot)

```
Discord message
   │
   ▼
[bot] parse mention → { threadName, repoUrl|localPath, prompt }
   │
   ▼
[bot] CREATE thread (autoArchiveDuration: 60)
   │
   ▼
[bot] INSERT INTO sessions (thread_id, repo_url|local_path, repo_path, ...)
   │
   ▼
[bot] if repoUrl: git clone <url> → TASKS_ROOT/<thread-id>/
   │
   ▼
[bot] forward to runner (CLI: spawn claude -p; SDK: query())
   │
   ▼
[bot] streams events back to thread (in-place edits or auto-surfaced text)
[bot] on completion: UPDATE sessions SET claude_session = <newId>
   │
   ▼
[claude] writes files to <work dir> on the host (no mount)
[claude] exits → process reaped → tracking removed

user can: cd <work dir> && code .
```

### /project start flow (Hermes — long-running)

```
Discord: @bot /project start "build a CLI todo app"
   │
   ▼
[messageCreate] strip @bot mention → recognize /project
   │
   ▼
[hermesCommands] handleProjectStart
   │
   ▼
[state.ts] mkdir <HERMES_DIR>/projects/<uuid>/ + write state.json
[state.ts] INSERT INTO sessions (so /status, /kill still work)
   │
   ▼
[hermesCommands] msg.startThread({ name: "📋 <goal>" })
   │
   ▼
[orchestrator] runProject(uuid) — fire and forget
   │
   ▼
   ┌─ planning ─┐  planner (LLM) → Task[] → state.json
   │
   ▼
   ┌─ executing ┐  for each pending task with deps satisfied:
   │            │    executor.runViaSdk() → Claude Code
   │            │    on done/fail → saveState + journal
   │
   ▼
   ┌─ judging ───┐  judge (LLM) → verdict: done | needs_more | stuck
   │            │
   │  needs_more: append nextTasks, re-enter executing
   │  stuck / failed: Discord escalation
   │  done: completion message
   │
   ▼
[orchestrator] finally: typing.stop()

Meanwhile (on bot restart):
[index.ts] resumeActiveProjects(hermesDir) re-fires for any
            non-terminal project found on disk.
```

## Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| `src/index.ts` | Entry point: load config, open DB, start Discord client, install signal handlers |
| `src/config.ts` | Load + validate env vars (Discord, paths, SDK options, kill switch `CLAUDE_USE_SDK`) |
| `src/logger.ts` | Structured logging (dev = pretty, prod = JSON) |
| `src/cleanup.ts` | Track active `claude` subprocess PIDs; SIGTERM them on bot shutdown (CLI path only) |
| `src/discord/client.ts` | discord.js client setup, intent config |
| `src/discord/handlers/messageCreate.ts` | Detect @bot mention in channel, route thread replies, dispatch CLI vs SDK runner |
| `src/discord/handlers/streaming.ts` | Runner orchestrator (CLI: stream parsing + SendQueue + placeholder; SDK: `query()` + tool dispatch + auto-surface CC plain text) |
| `src/discord/handlers/commands.ts` | Slash command matchers + handlers (`/kill`, `/status`, `/projects`, `/repo`, `/help`, `/use-cli`, `/use-sdk`) |
| `src/discord/handlers/hermesCommands.ts` | `/project start|status|list|plan|kill|resume` — see Hermes section below |
| `src/discord/parser.ts` | Extract target (URL / local path / project name / new project) from mention |
| `src/memoryMonitor.ts` | In-process RSS self-watchdog. Exits bot if `process.memoryUsage().rss` exceeds `BOT_RSS_THRESHOLD_MB`. Optional trace mode appends every sample to `data/ram-trace.log` (CSV) when `BOT_RAM_TRACE=1`. Defense-in-depth if OS-level `scripts/memory-watchdog.sh` is disabled. |
| `src/hermes/types.ts` | `ProjectState`, `Task`, `JournalEntry`, `HermesRuntimeConfig` types |
| `src/hermes/state.ts` | Atomic `state.json` I/O (write-tmp + rename), `journal.log` append, project listing. One project = one dir under `<HERMES_DIR>/projects/<uuid>/`. |
| `src/hermes/planner.ts` | LLM-based goal decomposition. Uses SDK `query()` with `claude-haiku-4-5` (configurable) and `permissionMode: "plan"` (no tool calls). Returns parsed `Task[]`. |
| `src/hermes/judge.ts` | LLM-based self-assessment. Verdict shapes: `done` / `needs_more` (with new tasks) / `stuck`. |
| `src/hermes/executor.ts` | Wraps `runViaSdk` with task semantics: builds the task prompt from goal + previous task outcomes, tracks `attempts` and `lastError`. |
| `src/hermes/orchestrator.ts` | Main state machine: `planning → executing ⇄ judging → done \| failed \| killed`. Safety caps check (`shouldStop`), per-task retry, judge loop. Includes `resumeActiveProjects()` for bot restart recovery. |
| `src/hermes/duration.ts` | `parseDuration(s)` — parses `"30m"` / `"2h"` / `"1d"` / `"1h30m"` strings into ms. Used by `/project setMode auto <duration>`. See [ADR-0004](operations/0004-setmode-auto-duration.md). |
| `src/hermes/typing.ts` | `TypingIndicator` class — keeps Discord typing on for the whole orchestrator run. 8s refresh (Discord typing expires at 10s). `unref`'d for safety. |
| `src/hermes/discord.ts` | Embed/format helpers: `formatPlanMessage`, `formatTaskStart`, `formatTaskDone`, `formatCompletion`, `formatEscalation`, `formatStatusEmbed`, `HERMES_PREFIX` (`🪪 Hermes:`). |
| `src/db/index.ts` | bun:sqlite wrapper, schema migration (additive for `mode`, `runner_kind`, etc.), typed CRUD on sessions |
| `src/db/schema.sql` | sessions table schema (base columns; additive migrations applied at boot) |
| `src/agent/runner.ts` | CLI runner: `Bun.spawn` wrapper around `claude -p --stream-json`; parses stream-json events |
| `src/agent/sdkRunner.ts` | SDK runner: wraps `query()` from `@anthropic-ai/claude-agent-sdk`; manages per-thread active queries; auto-surfaces CC's plain text replies |
| `src/agent/discordTool.ts` | The four custom tools (`discord_send`, `discord_typing`, `discord_react`, `discord_read_history`) exposed to CC via `createSdkMcpServer()` |
| `src/agent/systemPrompt.ts` | Loads the user's system prompt file and prepends a Discord-specific instruction block on the SDK path |
| `src/agent/events.ts` | TypeScript types for `claude --output-format stream-json` events (CLI path) |
| `src/agent/*.test.ts` | Unit tests for runners, tool handlers, system prompt, DB migration |
| `src/projects/registry.ts` | Auto-scan `PROJECTS_ROOT`; load optional `projects.json` aliases |
| `src/utils/path.ts` | `~` → `$HOME` expansion |
| `src/utils/git.ts` | `git clone` host-side helper (only used for git URL targets) |

## SQLite Schema

```sql
CREATE TABLE sessions (
  thread_id        TEXT PRIMARY KEY,           -- Discord snowflake
  channel_id       TEXT NOT NULL,
  repo_url         TEXT,                       -- git URL (clone required) — null when local_path is set
  local_path       TEXT,                       -- local filesystem path (no clone) — null when repo_url is set
  repo_path        TEXT NOT NULL,              -- resolved work dir: TASKS_ROOT/<thread-id> or expand(local_path)
  container_id     TEXT,                       -- (forward-compat; cleared on /kill in host-based mode)
  claude_session   TEXT,                       -- Claude Code session ID for --resume
  status           TEXT NOT NULL DEFAULT 'active',  -- active | idle | killed | done
  created_at       INTEGER NOT NULL,           -- unix ms
  last_activity_at INTEGER NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0,
  -- Phase 0 (autopilot feature, added in commit f70f6ea):
  mode             TEXT NOT NULL DEFAULT 'manual',  -- manual | autopilot
  milestone_goal   TEXT,
  milestone_criteria TEXT,
  -- Phase 2: per-thread runner selection
  runner_kind      TEXT NOT NULL DEFAULT 'sdk'     -- 'cli' | 'sdk'
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);
CREATE INDEX idx_sessions_runner_kind ON sessions(runner_kind);
```

`runner_kind` is added by an additive migration at boot (mirroring
the `mode` pattern). Legacy rows created before the migration read as
`'cli'` via `rowToSession`'s `?? 'cli'` fallback, preserving prior
behavior until the user explicitly switches them with `/use-sdk`.

## IPC: Bot ↔ Claude

Two paths depending on the runner:

### CLI runner (`runner_kind = "cli"`)

The bot reads Claude's stdout directly (no intermediary):

```
[bot]  ─── stdout pipe ──→  [parseJsonLines]  ─── events ──→  [discord edit]
         stream-json
```

`src/agent/runner.ts` (host-side):
```typescript
const proc = Bun.spawn({
  cmd: ["claude", "-p", prompt, "--output-format", "stream-json",
        "--verbose", "--permission-mode", mode, "--resume", sessionId],
  cwd: repoPath,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});

for await (const event of parseJsonLines(proc.stdout)) {
  // dispatch to callbacks (onTextDelta, onToolUse, onThinking, onResult)
}
```

The subprocess is tracked in `cleanup.ts` so SIGTERM on the bot propagates
to in-flight `claude` runs (no orphan processes).

### SDK runner (`runner_kind = "sdk"`)

The bot uses `@anthropic-ai/claude-agent-sdk`'s `query()` function, which
spawns a `claude` subprocess internally. The SDK manages the stream and
dispatches MCP tool calls to our registered handlers.

```
[bot]  ─── query({ prompt, options }) ───→  [SDK subprocess (managed)]
                                                       │
       for-await SDKMessage ◄─── stream-json events ───┘
              │
              ├─ assistant (text block)     → strip <thinking>, auto-post to Discord
              ├─ assistant (tool_use block) → SDK calls our handler (e.g. discord_send)
              │                                  handler.posts via SendQueue → Discord
              ├─ system/init (session_id)    → persist for resume
              └─ result (success/error)      → edit placeholder with stats header
```

`src/agent/sdkRunner.ts` (host-side):
```typescript
// RG-012: per-run factory — each handler closure captures the per-run
// thread + send. No shared mutable state, so concurrent SDK runs on
// different threads cannot cross-contaminate.
const tools = createDiscordTools({ thread, send });
const mcpServer = createSdkMcpServer({
  name: "discord-bridge",
  tools, // [discordSendTool, discordTypingTool, discordReactTool, discordReadHistoryTool]
});

const q = query({
  prompt,
  options: {
    cwd: session.repoPath,
    resume: session.claudeSession,
    mcpServers: { "discord-bridge": mcpServer },
    systemPrompt: await readSystemPrompt(), // prepended with Discord block
    permissionMode: config.claude.sdkPermissionMode,
    canUseTool: async (name) =>
      name.startsWith("mcp__discord-bridge__")
        ? { behavior: "allow" }
        : { behavior: "allow" },
  },
});

for await (const msg of q) {
  // track sessionId, tool count, auto-surface CC text
}
```

Sessions persist on disk under `~/.claude/projects/<encoded-cwd>/` and
are resumed by passing `options.resume = <sessionId>` on subsequent
runs. Active queries are tracked in an in-memory `Map<threadId, Query>`
so `/kill` can call `query.close()` to abort mid-flight.

#### Why a Zod 3 pin is required

The `@modelcontextprotocol/sdk` that the agent SDK embeds uses
`zod-to-json-schema@^3` to convert tool schemas to JSON Schema for the
MCP protocol. That library is Zod 3 only — it reads `_def.typeName`,
which doesn't exist on Zod 4 schemas (they have `_def.type` and a
`_zod` field). Mixing Zod 4 with the MCP layer produces "Zod validation
error" at the permission layer and every tool call fails.

`package.json` therefore pins `"zod": "^3.25"` and adds an
`overrides` entry so the entire dependency tree resolves to a single
Zod 3. The startup diagnostic in `sdkRunner.ts` logs the resolved
zod version so regressions are easy to spot.

## Host Paths

| Purpose | Path |
|---------|------|
| Bot repo | `~/Sites/localhost/claude-bridge/` |
| Session DB | `<repo>/data/sessions.db` |
| Per-thread work dir (git URL targets) | `~/www/discord-claude-tasks/<thread-id>/` |
| Per-thread work dir (project / local path) | the resolved project / path itself |
| Claude config (shared) | `~/.claude/` (read by `claude` directly) |

## Configuration (env vars)

| Var | Default | Description |
|-----|---------|-------------|
| `DISCORD_TOKEN` | (required) | Bot token from Discord dev portal |
| `DISCORD_CHANNEL_ID` | (required) | Channel where bot listens |
| `DISCORD_USER_ID` | (required) | Your Discord user ID (only allow your mentions) |
| `TASKS_ROOT` | `~/www/discord-claude-tasks` | Per-thread work dirs parent (git URL targets) |
| `PROJECTS_ROOT` | `~/www` | Directory scanned for project names |
| `PROJECTS_CONFIG` | (empty) | Optional `projects.json` for aliases / exclude / hidden |
| `DATA_DIR` | `./data` | SQLite + logs |
| `IDLE_TIMEOUT_MIN` | `30` | (reserved) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Cap on simultaneous claude runs |
| `LOG_LEVEL` | `info` | debug / info / warn / error |
| `CLAUDE_DEFAULT_PERMISSION_MODE` | `acceptEdits` | Passed to `claude --permission-mode` |
| `CLAUDE_TURN_TIMEOUT_MS` | `3600000` | Hard cap on a single Claude run (60 min). SDK aborts via `AbortController`. |
| `BOT_RSS_THRESHOLD_MB` | `800` | In-process RSS self-watchdog. Bot exits if `process.memoryUsage().rss` exceeds this. Defense-in-depth if OS-level `scripts/memory-watchdog.sh` is disabled. |
| `BOT_RSS_SAMPLE_INTERVAL_MS` | `30000` | Self-watchdog sample interval. |
| `BOT_RAM_TRACE` | `0` | `1` enables CSV trace logging of RSS + heap to `data/ram-trace.log` for offline long-task validation. |
| `HERMES_DIR` | `<DATA_DIR>/hermes` | Hermes project state root. |
| `HERMES_MODEL` | `claude-haiku-4-5` | Model for Hermes's own planner + judge LLM calls. |
| `HERMES_MAX_ITERATIONS` | `20` | Per-project hard cap on total task attempts. |
| `HERMES_MAX_COST_USD` | `500` | Per-project cost cap, in cents ($5.00 default). |
| `HERMES_MAX_WALL_HOURS` | `4` | Per-project wall-clock cap. |
| `HERMES_MAX_ATTEMPTS_PER_TASK` | `3` | Retries per task before marking failed. |
| `HERMES_RESUME_ON_STARTUP` | `1` | `1` re-fires orchestrator for non-terminal projects on bot start. |

## Security Boundary

```
[Discord]        ── bot process ──  [claude subprocess on host]
 untrusted                              semi-trusted
                          │
                          └─ runs with the bot user's permissions
                          └─ can read/write <work dir> (project or TASKS_ROOT/<thread>)
                          └─ reads ~/.claude/ (config, skills, creds)
                          └─ has network access (for git, npm, claude API)
                          └─ CAN see the rest of the user's home dir
                             (no isolation — this is the trade-off for
                              skipping Docker)
```

If you need stronger isolation, see the abandoned Week 3 milestone
in `MILESTONES.md` for the original Docker plan.

## Hermes Agent (Phase 3)

Hermes is the **autonomous project manager** layer on top of Claude Code.
See [`docs/operations/0003-hermes-agent.md`](operations/0003-hermes-agent.md)
for the full design ADR. This section is a quick reference for the
architecture.

**Three-tier model:**

```
David (Chairman) — sets direction, /project start, monitors /status
        ↓
Hermes (PM) — plans, tracks, judges
        ↓ invokes runViaSdk() per task
Claude Code (Engineer) — writes code, runs tests
        ↓
Deliverable → David
```

**Key design decisions:**

- **State on disk** (`<HERMES_DIR>/projects/<uuid>/`): `state.json` (atomic),
  `plan.md` (human-readable), `journal.log` (append-only). Not in SQLite —
  the project tree IS the source of truth.
- **Time-bounded auto mode** (`/project setMode auto <duration>`, ADR-0004):
  user-facing affordance to give Hermes autonomous control for a fixed
  wallclock window. Soft-exit at the next `judging` boundary when the
  timer fires; status lands in `killed` with reason `duration_expired`.
  `<duration>` is parsed as `30m` / `2h` / `1d` / `1h30m` and clamped
  to `HERMES_MAX_WALL_HOURS` as a safety floor. See
  [ADR-0004](operations/0004-setmode-auto-duration.md).
- **One project = one Discord thread.** The thread ID maps to a single
  project. `/project start` creates the thread; subsequent `/project status`
  etc. operate in the existing thread.
- **Model split**: Hermes's own planner + judge use `claude-haiku-4-5`
  (cheap, hot-loop). The actual code-writing is done by Claude Code
  (default `claude-sonnet-4-6`) via the existing `runViaSdk()`.
- **Safety caps** (per project, configurable):
  - `HERMES_MAX_ITERATIONS` (default 20)
  - `HERMES_MAX_COST_USD` (default 500 cents = $5.00)
  - `HERMES_MAX_WALL_HOURS` (default 4)
  - `HERMES_MAX_ATTEMPTS_PER_TASK` (default 3)
- **Discord typing on for the whole run** via `TypingIndicator` (8s
  refresh). Covers planning LLM, waiting on Claude Code, and judge LLM.
- **Resume on bot restart** via `HERMES_RESUME_ON_STARTUP=1` (default).
  Non-terminal projects are re-fired by scanning `<HERMES_DIR>/projects/`.
- **Mention handling**: `/project` works with or without a leading
  `@bot` mention. `messageCreate.ts` strips the mention before checking,
  so `parseMention`'s path-detection doesn't misinterpret `/project` as
  an absolute path (regression fixed 2026-06-22).

**Rollback:** `rm -rf src/hermes/ src/discord/handlers/hermesCommands.ts` +
revert `messageCreate.ts` and `index.ts` changes. No SQLite migration,
no env-var conflicts.
