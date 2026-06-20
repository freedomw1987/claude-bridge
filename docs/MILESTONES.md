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
