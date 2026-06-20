# claude-bridge — Product Requirements Document

## Vision

A Discord bot that turns Discord threads into Claude Code development tasks.
Each Discord thread = one Claude Code session running as a host subprocess
(working dir is the project's directory; files are written directly to the host).

## Target User

Personal use, single Discord user. Runs on the user's host machine.

## Core Workflow

```
Discord Channel
  └─ User: "@bot fix auth bug on github.com/foo/bar"
        ↓
  Bot: creates thread "Fix auth bug on foo/bar"
        ↓
  Bot: resolves target → project dir, local path, or TASKS_ROOT/<thread-id>
  Bot: if git URL → git clone into TASKS_ROOT/<thread-id>/
  Bot: spawns `claude -p --stream-json` with that work dir
        ↓
  Thread #1 ── claude subprocess on host
     │  ── user: "add unit tests too"
     │  ── claude: streams response back into the thread
     │  ── files written directly to work dir, visible in user's editor
     ↓
  User sends /kill or quits the bot → subprocess killed, files remain
```

## Functional Requirements

### F1 — Mention Detection & Thread Creation
- Bot listens in a configured Discord channel
- On `@bot` mention in a non-thread message: create a new thread
- Reply in the new thread with acknowledgment
- Store thread metadata in SQLite

### F2 — Target Resolution
- Extract one of: git URL, local path, project name (from `~/www/`), or `new <name>`
- Supported URL patterns: `github.com/...`, `gitlab.com/...`, raw URL, `git@github.com:...`
- Prepositions like "in foo" / "on foo" / "use foo" resolve a project name
- If nothing matches: ask user in thread for a target via `/repo`
- Validate URL / path before use

### F3 — Claude Code Subprocess (host-based)
- One `claude` subprocess per message
- Working directory is the resolved target: project dir, local path, or `TASKS_ROOT/<thread-id>`
- Subprocess runs `claude -p --output-format stream-json --verbose --permission-mode <mode> [--resume <sid>]`
- Streamed JSON events on stdout are demuxed and typed
- Files written by claude appear directly on the host (no mount / no container)

### F4 — Interactive Streaming (Week 4)
- User messages in thread → forwarded to the in-flight subprocess (or a new one)
- claude-code output → streamed to Discord as it generates
- Edit Discord messages as chunks arrive (throttled ~800ms)
- Show tool calls, file edits, bash commands as compact status lines
- React to the user's message with ✅/❌ on completion

### F5 — Session Persistence (Week 4)
- Use `claude --resume <session-id>` to continue across messages
- Session ID stored in SQLite per thread
- Sessions survive bot restarts; the new run picks up the saved session ID

### F6 — Cleanup (Week 4)
- Manual `/kill` command: kill the subprocess, keep files + session row
- Graceful shutdown: SIGTERM all in-flight subprocesses on `SIGINT` / `SIGTERM`
- (Future) Idle-timeout sweep is reserved but not yet implemented

## Non-functional Requirements

- **Latency**: First claude response within 10s of mention
- **Reliability**: Bot survives host reboot (systemd / launchd)
- **Security**: `claude` runs with the bot user's host permissions. No container/sandbox.
  - The work dir is the only place claude is expected to write
  - Network access is unrestricted (needed for git, npm, claude API)
  - `~/.claude/` (config + creds) is read by `claude` directly
- **Cost**: Only pay for actual claude API calls

## Out of Scope (v1)

- Multi-user / multi-tenant
- Public bot exposure
- Approval gates for dangerous ops (default `acceptEdits` is enough)
- Web UI / dashboard
- Voice channels
- Container isolation (Docker was tried in Week 3 and abandoned — see MILESTONES.md)

## Open Questions

- Max concurrent `claude` runs? (Decision: 5, configurable — *enforcement deferred*)
- Idle timeout? (Decision: 30 min, configurable — *reserved, not yet enforced*)
