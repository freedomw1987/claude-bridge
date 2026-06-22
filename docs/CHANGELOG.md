# Changelog — claude-bridge

所有重要改動嘅時序日誌。Tag 嘅 message 係呢份 file 嘅濃縮版。
詳細 discussion 睇 [docs/operations/](operations/) 入面嘅 ADR, retros 睇 [docs/retros/](retros/)。

---

## [v2.0.0] — 2026-06-22

**Hermes 自動化開化 — 由「人手逐 task」進化到「David 講 goal, Hermes 自動拆 plan + 派 Claude Code + 自己 judge」**

呢個 milestone 將 claude-bridge 由 1-shot bridge 升級做 3-tier 自主 agent loop:
David (董事長) → Hermes Agent (PM) → Claude Code (工程師)。

### 🎯 主要功能

- **/project start** — David 喺 Discord channel 用一句話講 goal, Hermes 開新 thread + state machine 自動跑
- **/project list / status / plan / kill / resume** — 完整 project lifecycle 指令
- **3-tier agent loop** — David → Hermes → Claude Code, 每層有清晰 contract
- **Per-project state persistence** — `<hermesDir>/projects/<id>/` 下面 `state.json` + `plan.md` + `journal.log` + `artifacts/`, 寫入用 write-to-tmp + rename 確保 atomic
- **Orchestrator state machine** — `planning → executing → judging → done|failed|killed|timed_out|parse_error`, 9 個 terminal + non-terminal states
- **Auto-mode timer (ADR-0004)** — `/project setMode auto <duration>` 自動 re-arm, live countdown embed, kill reason = `duration_expired`
- **/project adopt** — 將 plain Claude Code thread 升級做 Hermes-managed, 保留原 session context
- **/project delete** — 清死 project (`--all-failed` bulk mode), active project refuse 保護
- **Discord interface** — 所有 Hermes message 加 `🪪 Hermes:` prefix 區分 Claude Code output

### 🛡️ Safety caps (per project)

| Cap | Default | Env var |
|---|---|---|
| Max iterations | 20 | `HERMES_MAX_ITERATIONS` |
| Max cost (cents) | 500 ($5.00) | `HERMES_MAX_COST_USD` |
| Max wall-clock (hours) | 4 | `HERMES_MAX_WALL_HOURS` |
| Max attempts per task | 3 | `HERMES_MAX_ATTEMPTS_PER_TASK` |
| Planner timeout | 15 min | `HERMES_PLANNER_TIMEOUT_MS` |

### 🔧 Reliability + UX (呢個 milestone 期間嘅 6 個 RG fix)

- **RG-002** — Strip `<ant_thinking>` + `<thinking>` 由 CC output, 避免 Discord 顯示噪音
- **RG-004** — `/project adopt` + thread-upgrade workflow + retroactive retrospective
- **RG-005** — Hermes runner send callbacks 用 `makeClaudeSend` 包, 防 race
- **RG-006** — `/project setMode auto` auto-resumes terminal project, 唔使人手 resume
- **RG-007** — `/project adopt` auto-kills same-repoRoot conflicts, 避免兩個 project 爭同一個 repo
- **RG-008** — Planner timeout → `status="timed_out"` + populated `killedReason` (解決 5-min 神秘 crash)
- **RG-009** — `/project delete` 完整 audit trail + active-project refusal
- **RG-010** — Planner JSON parse guard, `<think>` orphan-opener workaround

### 🏗️ Infrastructure

- **Turn timeout** (60 min default) — 防止單個 CC run hang 死成個 bot
- **RSS self-watchdog** — process RSS > 800MB 自動 exit, 配合 OS-level watchdog 做 defense-in-depth
- **RAM tracing** — `BOT_RAM_TRACE=1` 開 CSV log, 方便 debug SDK-era long-task 行為
- **SendQueue** — Discord sends rate-limited, 防止 429

### 📊 Scale

| Metric | v1.3.0 | v2.0.0 |
|---|---|---|
| Hermes 模組 LOC | — | ~1900 |
| 新 file | — | 12 |
| Test count | 109 | 182 (+73) |
| State files | — | 4 (state.json + plan.md + journal.log + artifacts/) |

### 📚 文檔

- `docs/operations/0003-hermes-agent.md` — ADR-0003 (核心架構決策)
- `docs/operations/0004-setmode-auto-duration.md` — ADR-0004 (auto-mode timer)
- `docs/ARCHITECTURE.md` — 已更新到 3-tier agent model
- `docs/MILESTONES.md` — M2.1–M2.11 + RG-001~RG-010 timeline
- `docs/retros/2026-06-22-m2-phase-1.5.md` — Hermes phase retrospective
- `docs/retros/2026-06-22-rg004-thread-adopt.md` — `/project adopt` retro
- `docs/claude-bridge-overview.html` — Boss-facing system overview, 可直接 Discord share

### 🚀 Migration / Rollback

純 additive。新嘅 `HERMES_*` env vars 全部 namespaced, 唔會撞舊 config。
Rollback = `git revert v2.0.0` 或 `rm -rf src/hermes/ src/discord/handlers/hermesCommands.ts`。
舊 `@bot` mention flow 完全唔受影響。

---

## [v1.3.0] — 2026-06-22

**Bridge runner migrate to Claude Agent SDK + memory fixes**

由 `Bun.spawn` CLI subprocess path 換做 `@anthropic-ai/claude-agent-sdk` in-process transport。
Structured tools (`discordTool.ts`) 讓 agent 喺 turn 內 post/edit/kill Discord message。
詳見 `git show v1.3.0` 同 ADR 內部 notes。

---

## [v1.2.0] — 2026-06-21

**Drop memory check (personal use, hard cap sufficient)**

移除晒所有 memory-based preflight / retry / dynamic-cap logic。
Single-user deployment 唔再 spuriously reject, OOM protection 改由 `MAX_CONCURRENT_CONTAINERS` 行 hard cap。

---

## [v1.1.0] — 2026-06-21

**Production hardening + UX + reliability**

Phase 1 audit (`docs/AUDIT.md`) follow-up + user UX feedback。

Highlights:
- `MAX_CONCURRENT_CONTAINERS` 真正 enforce, idle sweep mark timed-out sessions, git clone 有 timeout
- stderr drained in parallel with stdout (唔再撞 64KB pipe deadlock)
- Discord sends rate-limited via `SendQueue` (唔再 429)
- `/help` slash command + helpful error messages
- Subprocess memory preflight (防 OOM)
- Split 851-line `messageCreate.ts` 入 5 個 focused modules
- Test coverage 42 → 109 (+159%)

---

## [v1.0.0] — 2026-06-21

**First stable release**

Discord-to-Claude-Code bridge, post-supervisor re-baseline。
737035c initial bridge 基礎上加入:
- `deploy/restart.sh` cross-platform (launchd / systemd) service helper
- `splitForDiscord` stream-preserving splitter, long CC response 唔再 truncated
- 9 unit tests for splitter (73 tests total pass, typecheck clean)

Supersedes supervisor-era experimental work (preserved on `abandoned/supervisor-wip` branch)。