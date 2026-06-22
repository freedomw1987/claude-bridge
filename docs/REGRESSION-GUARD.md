# Regression Guard — claude-bridge

> 目的:追蹤所有修過嘅 bug + 所有 lock-in invariants,確保日後唔會重新踩坑。
> 規則:每個 bug fix 必須喺呢度留 entry(紅線 13)。M2 series 嘅 timer invariants
> 喺呢度 lock 埋,作為日後 refactor `armProjectTimer` / `softExit` 嘅防護。

## 索引

| Entry ID | 描述 | 發現日期 | 影響版本 | Root Cause / Invariant | Regression Test | 狀態 |
|----------|------|---------|---------|------------------------|-----------------|------|
| RG-001 | `/project setMode auto <duration>` timer integration 嘅 invariant set (M2.4–M2.11, ADR-0004) | 2026-06-22 | Phase 1.5 lock | [see](#rg-001) | `src/hermes/orchestrator.test.ts` E2E block (3 tests) | LOCKED |
| RG-002 | CC's `<ant_thinking>...</ant_thinking>` blocks leak into Discord if not stripped | 2026-06-22 | v1.1.0 (pre-fix) | [see](#rg-002) | `src/discord/handlers/format.test.ts` (15 tests) + `src/agent/discordTool.test.ts` (3 integration tests) | FIXED |

---

<a id="rg-001"></a>
### RG-001 — M2 timer-softExit integration invariants (ADR-0004)

**發現日期**: 2026-06-22
**發現者**: @Developer (M2.11 E2E lock-in)
**影響版本**: Phase 1.5 (M2.1–M2.11)
**修復版本**: Phase 1.5 (M2.11 commit, see commits `d47285b..a12c30d`)
**修復者**: @Developer
**Commits**: `d47285b`(M2.1)..`a12c30d`(M2.9); M2.11 e2e test in this commit

#### 症狀
呢個唔係 bug,係**invariant set** — 將 M2 series 嘅 timer 行為 lock 埋,防止日後 refactor 喺以下三個 scenario 走樣:

1. **Active project 嘅 timer 到期後冇 softExit**(bot 會無限跑,撞 cost cap)
2. **Soft-exit 寫咗 state.json 但 journal 冇 entry**(事後 audit 唔到)
3. **Bot 重啟後 timer 過咗 deadline 但冇觸發 softExit**(resume path leak)

#### Invariant Set(必須一齊保持)

| # | Invariant | Lock test |
|---|-----------|-----------|
| I-1 | `armProjectTimer` + 200ms deadline + callback → callback fires at 200ms (±50ms) | E2E test 1 |
| I-2 | callback path (resumeActiveProjects shape) re-loads state from disk → sees fresh status, bails if `!isActive(fresh)` | E2E test 1 |
| I-3 | `softExit(reason="duration_expired")` writes: `state.json` with `status=killed`, `killedReason="duration_expired"`, `timer=undefined`, `endedAt` set | E2E test 1 |
| I-4 | `softExit` writes a journal entry containing "auto-mode duration expired" + the requested duration string | E2E test 1 |
| I-5 | `softExit` posts exactly **one** Discord message with the `formatTimerExpired` text (⏱ header) | E2E test 1 |
| I-6 | `softExit(reason="manual_switch")` writes `killedReason="manual_switch"`, journal entry contains "manual switch cancelled auto-mode timer", Discord message contains "manual switch" | E2E test 2 |
| I-7 | `armProjectTimer` with `expiresAt <= now` returns `null` (no setTimeout) and fires callback via `queueMicrotask` | E2E test 3 + armProjectTimer unit tests |
| I-8 | `softExit` clears the live timer handle (calls `clearTimeout(state.timer.handle)` before mutating) | softExit unit test (existing) |

#### 防止再發(防護措施)

- [x] **Regression test (E2E)**: `src/hermes/orchestrator.test.ts` 入面個 `describe("E2E M2.11 — timer fires → softExit (duration_expired)")` block,3 個 test 覆蓋 invariants I-1..I-7
- [x] **Code comment**: `src/hermes/orchestrator.ts:170-187` 嘅 judge boundary check block 加咗 `// ADR-0004 M2.4: timer boundary check before invoking judge LLM.`
- [x] **Invariant statement**: ADR-0004 寫咗 "Why soft-exit at judge verdict, not at task boundary" 嘅 trade-off analysis
- [x] **No silent failure**: `softExit` throw `Error` from 個 callback 個 inner `.catch` (E2E test 1 用 `throw err` 確認 silent fail 會 surface 返出嚟)

#### Refactor Guard

任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/hermes/orchestrator.test.ts` 並確認 3 個 E2E test + 8 個 softExit/armProjectTimer unit test 全部 PASS
2. 對住 invariant table I-1..I-8 逐個 check 冇違反
3. 改 `softExit` 或 `armProjectTimer` 嘅 signature 必須 update 個 E2E test + 任何 caller(`resumeActiveProjects` 喺 `src/hermes/orchestrator.ts:482`)

#### 相關 Issue / Discussion
- ADR-0004: `docs/operations/0004-setmode-auto-duration.md`
- M2 series plan: `f04630f`
- `docs/MILESTONES.md` Phase 2 (M2.1–M2.11)

---

<a id="rg-002"></a>
### RG-002 — `<ant_thinking>...</ant_thinking>` leaks into Discord

**發現日期**: 2026-06-22
**發現者**: @David (用戶回報:「收到的訊息，都只有``」)
**影響版本**: v1.1.0 (Day 4 SDK migration, pre-fix)
**修復版本**: commit in this PR (post-Phase 1.5)
**修復者**: @Developer
**Commit**: (this commit)

#### 症狀
- User 喺 Discord thread send 一個 prompt
- CC 跑完,auto-post 一個 final answer
- User 收到嘅訊息入面**只有 raw `` 標籤 + thinking 文字**,冇 CC 嘅 final answer
- 或者: 個 raw 結構 leak 入 Discord,user 睇到 XML 標籤
- 仲有一個 side effect: `contentLength: 2102` 觸發 `discord_send` 嘅 max-length guard(1900 chars)→ tool return errorResult → CC 收到「split into multiple calls」error → CC retry 個 stripped version(783 chars)→ user 睇到嘅後段 + 冇前段 context

#### Root Cause(為何會壞)
1. CC / Anthropic extended thinking 用幾種 tag variants:
   - `<thinking>...</thinking>` (older CC, generic)
   - `<ant_thinking>...</ant_thinking>` (Anthropic extended, most common 2025-2026)
   - `<think>...</think>` (some 3rd-party mirrors)
2. `src/discord/handlers/format.ts` 入面 `stripThinkTags(text)` **只 strip 咗 `</think>` 單個 closing tag**,冇 strip opening `<thinking>` / `<ant_thinking>`,亦冇匹配成對 tag 嘅 content
3. `src/agent/discordTool.ts` 嘅 `discordSendTool` handler **冇 call `stripThinkTags`** —— 直接 forward `input.content` 去 `target.reply(content)` / `deps.send(content)`
4. `src/agent/sdkRunner.ts:293` 嘅 auto-post path 用 inline regex `/<thinking>[\s\S]*?<\/thinking>/g` —— **只識 `<thinking>`,唔識 `<ant_thinking>`**
5. `src/discord/handlers/streaming.ts:467` 用緊 `stripThinkTags` 個 broken version,一樣 leak

#### Invariants(必須一齊保持)

| # | Invariant | Lock test |
|---|-----------|-----------|
| I-1 | `stripThinkTags` strips all three variants (`<thinking>`, `<ant_thinking>`, `<think>`) | `format.test.ts` cases 2, 3, 4 |
| I-2 | `stripThinkTags` handles multi-line blocks (code fences, paragraphs) | `format.test.ts` case 5 |
| I-3 | `stripThinkTags` handles multiple blocks in one string | `format.test.ts` case 6 |
| I-4 | `stripThinkTags` strips dangling closing tag without opener (CC truncation case) | `format.test.ts` case 7 |
| I-5 | `stripThinkTags` strips dangling opening tag without closer (CC truncation case) | `format.test.ts` case 8 |
| I-6 | `stripThinkTags` is case-insensitive on tag names | `format.test.ts` case 13 |
| I-7 | `stripThinkTags` tolerates extra whitespace inside tag | `format.test.ts` case 14 |
| I-8 | `stripThinkTags` returns empty for input that is ONLY a thinking block | `format.test.ts` case 12 + 19:03:52 log line pin |
| I-9 | `discordSendTool` calls `stripThinkTags` BEFORE length check | `discordTool.test.ts` case 1 (ant_thinking) + 2 (thinking) + 3 (length reduction) |
| I-10 | `discordSendTool` posts the stripped content, not the raw | `discordTool.test.ts` case 3 (`expect(sentContent).toBe(finalAnswer)`) |
| I-11 | `sdkRunner.ts` auto-post path uses the same `stripThinkTags` helper (no inline regex) | grep `discordSendTool` & `sdkRunner.ts` for `stripThinkTags` import — must share |
| I-12 | `streaming.ts` CLI path uses the same `stripThinkTags` helper | grep `streaming.ts` for `stripThinkTags` import |

#### 防止再發(防護措施)
- [x] **Comprehensive regex** covers all 3 tag variants in `format.ts` (`THINKING_TAG_RE`)
- [x] **Defensive dangling-tag strip** for partial CC outputs
- [x] **`discordSendTool` wired** to call `stripThinkTags` BEFORE length check (saves CC from spurious "split into multiple" errors)
- [x] **`sdkRunner.ts` uses shared helper** (no inline regex duplication)
- [x] **15 unit tests** for `stripThinkTags` covering all variants + edge cases
- [x] **3 integration tests** in `discordTool.test.ts` proving the tool actually posts stripped content
- [x] **All 322 tests pass** + typecheck clean

#### Refactor Guard

任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/discord/handlers/format.test.ts` 並確認 15 個 `stripThinkTags` test 全部 PASS
2. 跑 `bun test src/agent/discordTool.test.ts` 確認 3 個 RG-002 integration test PASS
3. 對住 invariant table I-1..I-12 逐個 check 冇違反
4. 改 `stripThinkTags` 嘅 signature 必須 update 全部 3 個 caller(`discordSendTool`、`sdkRunner.ts`、`streaming.ts`)
5. 加新嘅 thinking tag variant(eg. `<claude_thinking>`)必須 extend `THINKING_TAG_RE` + 加 test case

#### Detection signal(出現以下即有 leak)
- 喺 Discord 見到任何含 `<think` / `<ant_think` / `<think>` 字串嘅訊息
- `data/bot.log` 入面 `discord_send called` event 嘅 `contentLength` 接近或超過 1900,跟住 retry
- 任何 user report「收到嘅訊息只有 thinking 冇 answer」

#### 相關 Issue / Discussion
- Original symptom: 2026-06-21T19:03:52 Discord thread(`<ant_thinking>...</ant_thinking>` leak)
- 2026-06-22T02:44:45 Discord thread(`contentLength: 2102` → max-length fail → retry stripped to 783)
- Both reproducible by `bun test src/discord/handlers/format.test.ts` "matches the actual log line" case


## RG-003 — Hermes metadata collapse + Claude Code reply prefix (UX-3)

### Problem
- Discord thread 內嘅 Hermes orchestrator metadata(`📋 Plan ready`、`✅ task 1 done (30s, $0.12)`)佔據大量 visual space,**蓋過 Claude Code 嘅實際 engineering output**(edit / test / build)
- Hermes 嘅 multi-line 格式 (`- **task-id** title`、`⏳ Starting execution...`)spam thread,用戶睇唔到 CC 喺做咩
- **尤其喺 auto → manual mode 切換期間**:David 用 `/project setMode manual` 接管,需要睇返 CC 之前嘅 output 做 context — 但舊格式 Hermes metadata 同 CC reply 視覺上完全混合,**David 唔知邊段係 CC、邊段係 Hermes**

### Symptom (what David saw before fix)
```
[Hermes] 🪪 Hermes: 📋 **Plan ready** — 5 tasks for: *fix auth bug*
[Hermes] 🪪 Hermes:
[Hermes] 🪪 Hermes: - **auth-fix** Fix authentication bug _(after setup)_
[Hermes] 🪪 Hermes: - **login-page** Add login UI _(after auth-fix)_
[Hermes] 🪪 Hermes: - **rate-limit** Add rate limiting _(after auth-fix)_
[Hermes] 🪪 Hermes: - **tests** Write tests _(after auth-fix, login-page)_
[Hermes] 🪪 Hermes: - **docs** Update docs _(after tests)_
[Hermes] 🪪 Hermes:
[Hermes] 🪪 Hermes: ⏳ Starting execution (mode=auto, budget=$5.00, max iters=20)...
[CC] I'll fix the authentication bug. Starting by reading the auth module.
[CC] Done. Added the missing check.
[Hermes] 🪪 Hermes: ✅ **auth-fix done** in 30.0s ($0.12)
[Hermes] 🪪 Hermes: Progress: 1/5 (20%) | Total $0.12 | 1 iter
[Hermes] 🪪 Hermes: ▶️ **Task 2/5: login-page** Add login UI
[Hermes] 🪪 Hermes: > Build the React login form component
```

User impression: "Hermes 講咗好多 metadata,CC 嘅實際工作 output 好細聲"

### Root Cause (why it broke)
1. `src/hermes/discord.ts` 嘅 `formatPlanMessage` / `formatTaskStart` / `formatTaskDone` / `formatTaskFail` / `formatCompletion` / `formatEscalation` / `formatStatusEmbed` / `formatTimerExpired` 全部用 multi-line format with headers (`**Plan ready**`)、blank lines、`> description` blockquotes — 一個 event 4-8 行
2. CC 嘅 reply 經 `discord_send` tool(`sdkRunner.ts`)或 CLI streaming (`streaming.ts`) 直接 `thread.send(content)` — **冇任何 sender prefix**,user 無從分辨 Hermes vs CC
3. 尤其 `formatStatusEmbed` 仲塞 `Workspace: \`/path\``、`Status: \`active\` | Mode: \`auto\`` 嘅 verbose label

### Fix
1. **`makeClaudeSend(thread, queue?)`** 喺 `src/discord/handlers/streaming.ts` 新增 — 包 `thread.send`,prefix `"🤖 **Claude Code:"` 喺 first chunk,continuation chunk bare(因為 Discord 視覺上 burst 一齊出)
2. **Hermes formatter 全部 collapse 去單行**:
   - `formatPlanMessage`: `📋 Plan: 5 tasks (mode=auto, budget=$5.00, max iters=20) → starting execution`
   - `formatTaskStart`: `▶️ 1/5 auth-fix [attempt 2]`
   - `formatTaskDone`: `✅ auth-fix 30.0s $0.12 (1/5 • $0.12 • 1 iter)`
   - `formatTaskFail`: `❌ auth-fix attempt 1: <error short> → retrying|escalating`
   - `formatCompletion`: `🎉 done 4/5 30m $0.42 • 1 iter • <verdict short>`
   - `formatEscalation`: `⚠️ escalated: <reason short> — reply or \`/project kill\``
   - `formatStatusEmbed`: 3 行(`📊 status=... mode=...` / `tasks: ...` / `cost: ... • iter: ... • ...`) + optional `⏱ Timer:` line
   - `formatTimerExpired`: `⏱ duration elapsed — stopped at judge pass (...)`
3. **`truncateInline()`** helper 處理 multi-line error 字串 → single-line collapse
4. **Wire-up**:
   - `runViaSdkWrapper` 用 `makeClaudeSend(thread, queue)` 取代 raw `queue.send(thread.send, content)`
   - `runViaClaudeCli` 一樣
   - Placeholder 用 raw queue send(冇 prefix),edit in place 維持 header line 簡潔

### Invariants (必須一齊保持)

| # | Invariant | Lock test |
|---|-----------|-----------|
| I-1 | `CLAUDE_PREFIX === "🤖 **Claude Code:**"` (不變) | `streaming.test.ts` "CLAUDE_PREFIX is stable" |
| I-2 | `makeClaudeSend` 對 short reply 加 prefix 喺 first message | `streaming.test.ts` "short single reply" |
| I-3 | `makeClaudeSend` 對 long reply split chunks,prefix 只喺 first chunk | `streaming.test.ts` "long reply that exceeds Discord limit" |
| I-4 | `makeClaudeSend` 對 empty content throws(防止 silent message loss) | `streaming.test.ts` "empty content throws" |
| I-5 | `makeClaudeSend` 接受 SendQueue,所有 send 都行經 queue | `streaming.test.ts` "with a SendQueue" |
| I-6 | `formatStatusEmbed` 冇 timer 時係 3 行,有 timer 時 4 行 | `discord.test.ts` "renders compact 3-line status" + "appends timer line as 4th line" |
| I-7 | 所有 Hermes formatter (`formatPlanMessage` / `formatTaskStart` / `formatTaskDone` / `formatTaskFail` / `formatCompletion` / `formatEscalation` / `formatStatusEmbed` / `formatTimerExpired`) output 唔包含 `\n` (single-line guarantee) | grep test for `\n` in output (manual review) |
| I-8 | `formatTimerExpired` 仍然包括 `duration elapsed` 短語(REGRESSION-GUARD RG-002 softExit test pin) | `orchestrator.test.ts` "softExit (M2.4)" |
| I-9 | `runViaSdkWrapper` 同 `runViaClaudeCli` 兩條 path 都 call `makeClaudeSend`,prefix wiring 一致 | grep `streaming.ts` for `makeClaudeSend` import + call sites (≥ 2) |
| I-10 | Placeholder (`⏳ Working...` / `⏳ Running Claude Code...`) 用 raw queue send 唔加 prefix,edit 嘅 header line 唔會重覆 prefix | grep `streaming.ts` line 152 / 268 region — verify raw `queue.send` call |

### 防止再發 (防護措施)
- [x] **`makeClaudeSend` wrapper** centralizes prefix logic — 唔可以喺 runner path 直接 `thread.send` (要 grep 過 `streaming.ts` 確認冇 raw `thread.send` 直接 call 用作 CC reply)
- [x] **Single-line Hermes formatters** — multi-line 格式係 silent footgun,新 contributor 可能 refactor 返 multi-line
- [x] **`truncateInline()` helper** 用 regex collapse multi-line 內容 → single-line,防止 overflow
- [x] **5 unit tests** for `makeClaudeSend` (prefix, chunking, empty, queue, stability)
- [x] **2 unit tests** for `formatStatusEmbed` collapse (3-line + 4-line)
- [x] **Update 2 existing tests** for `formatTimerExpired` 新 phrase (`duration elapsed` 取代 `Auto-mode duration elapsed`)
- [x] **All 328 tests pass** + typecheck clean

### Refactor Guard
任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/discord/handlers/streaming.test.ts` 並確認 5 個 `makeClaudeSend` test 全部 PASS
2. 跑 `bun test src/hermes/discord.test.ts` 確認 8 個 `formatStatusEmbed` test 全部 PASS
3. 跑 `bun test src/hermes/orchestrator.test.ts` 確認 2 個 `formatTimerExpired` softExit test PASS
4. 對住 invariant table I-1..I-10 逐個 check 冇違反
5. 改 Hermes formatter 嘅 output format 必須 keep single-line guarantee — multi-line 必須要 justification 加返(例如 spec change)
6. 改 `makeClaudeSend` 簽名必須 update 兩個 caller (`runViaSdkWrapper` 同 `runViaClaudeCli`)

### Detection signal (出現以下即 UX-3 走樣)
- 任何 Hermes 訊息 > 2 行(可能有 contributor 加返 multi-line)
- 任何 CC reply 冇 `🤖 **Claude Code:**` prefix
- Discord thread 入面見到 `📋 **Plan ready**` 或 `✅ **task-id done**` 嘅舊格式 phrase
- User report「睇唔到 Claude 喺做咩」或「Hermes 訊息太多」

### 相關 Discussion
- Original symptom: 2026-06-22 David 講「感覺到在開發」 → Hermes metadata 蓋過 CC output
- 2026-06-22 跟進:David 講「setMode manual 中途用戶接管,thread 要有 cc 嘅內容,先可以人去接管」 → auto→manual handover 視覺斷裂
- Decision log: `docs/MILESTONES.md` (待補 entry)

---

## RG-004: `/project adopt` thread-upgrade workflow (2026-06-22)

**Symptom**: David 喺 plain CC session thread (`@bot <prompt>` 開)入面打 `/project setMode auto 1m` 撞 `❌ No Hermes project in this thread.` 嘅 NG UX — 而家只有 `/project start` 喺 top-level 先可以開 Hermes project, 變相要求 David 喺未傾好需求前就要 commit 落 Hermes state machine。

**Root cause**: Hermes project 同 Claude Code session 係兩個獨立 system, 之前 join 嘅唯一地方係 `/project start` (top-level only)。 Thread 開咗 CC session 之後要 promote 變 Hermes-managed project 冇 explicit path。

**Fix** (commit pending): 新加 `/project adopt "<goal>" [auto <duration>] [manual]` command, 喺 plain CC session thread 入面 promote 個 thread 變 Hermes-managed project (with `adoption` field 寫 audit trail), 同時可選 arm auto-mode timer。

### Decision log
- Spec: `/project adopt "<goal>" [auto <duration>] [manual]` (Option C, David 揀)
- Default mode = `auto`, duration default = `HERMES_MAX_WALL_HOURS` (4h, 跟 safety cap)
- Duration clamp: 超過 4h → clamp + reply "capped at 4h"
- Soft reject existing Hermes project:「⚠️ This thread already has a Hermes project (`goal: <preview>`, status=...). To re-adopt, kill it first with `/project kill`, or use `/project setMode` to change mode.」(3B)
- State shape: `state.adoption = { fromSession: true, adoptedAt, originalRepoPath, originalSessionId }` (4C)
- Pre-flight 1: thread 必須有 CC session (`store.get(threadId)` 唔 null), 否則 reject
- Pre-flight 2: thread 必須冇 Hermes project, 否則 soft-reject with goal preview
- Adoption field 純 audit trail — orchestrator 同 executor 都唔 branch on it

### Invariants (必須一齊保持)

| # | Invariant | Lock test |
|---|-----------|-----------|
| I-1 | `matchAdopt` 接受 `/project adopt "<goal>"`, default mode = auto | `hermesCommands.test.ts` "matches ... with no mode (defaults to auto)" |
| I-2 | `matchAdopt` 接受 `/project adopt "<goal>" auto 1h` | "matches ... auto 1h (auto with duration)" |
| I-3 | `matchAdopt` 接受 `/project adopt "<goal>" manual` | "matches ... manual" |
| I-4 | `matchAdopt` 拒絕 `'<goal>'` single quotes (only double quotes) | "rejects unquoted goal" |
| I-5 | `matchAdopt` 拒絕 goal < 3 chars (e.g. "x", "ab") | "rejects goal shorter than 3 chars" |
| I-6 | `matchAdopt` 拒絕 `manual 1h` 組合 (manual 係 wallclock-free) | "rejects manual + duration" |
| I-7 | `matchAdopt` 拒絕 `auto 1h manual` 同 `manual auto` (conflicting mode tokens) | "rejects conflicting mode tokens" |
| I-8 | `matchAdopt` 拒絕 trailing garbage (e.g. `auto 30m extra`) | "rejects trailing garbage" |
| I-9 | `matchAdopt` 接受 `@bot /project adopt "..."` (mention-stripped) | "handles @bot mention prefix" |
| I-10 | `matchAdopt` 係 case-insensitive (`AUTO` / `Manual` 都 work) | "case-insensitive on mode" |
| I-11 | `dispatchHermesCommand` 喺 top-level channel 拒絕 `/project adopt`(要 in thread) | routing check + "❌ ... must be invoked in an existing thread" reply |
| I-12 | `dispatchHermesCommand` 將 `/project adopt` 加埋落 `❓ Unknown` subcommand list | grep `hermesCommands.ts:dispatchHermesCommand` unknown reply list |
| I-13 | `handleProjectAdopt` 拒絕冇 CC session 嘅 thread | "No Claude Code session in this thread" reply |
| I-14 | `handleProjectAdopt` soft-reject 已有 Hermes project 嘅 thread (3B wording) | "⚠️ This thread already has a Hermes project" reply |
| I-15 | `handleProjectAdopt` 拒絕 invalid duration (e.g. `auto 30min`) | "Cannot parse duration" reply |
| I-16 | `handleProjectAdopt` clamp 超過 4h duration + reply "capped at 4h" | "capped at ... the safety cap" |
| I-17 | `adoptProject` 寫 state.adoption field 帶 fromSession=true, adoptedAt, originalRepoPath, originalSessionId | inspect saved state.json after adopt |
| I-18 | `adoptProject` 寫 journal entry 帶 type="adopt" | grep journal.log for "thread adopted from CC session" |
| I-19 | `adoptProject` 唔 overwrite 已有 Hermes project(soft reject before write) | I-14 |
| I-20 | `JournalEntryType` 包括 "adopt" | grep `types.ts` JournalEntryType union |

### 防止再發 (防護措施)
- [x] **15 new matchAdopt tests** 喺 `hermesCommands.test.ts` 全部 PASS
- [x] **Type-check clean** (tsc --noEmit)
- [x] **All 344 tests pass** (328 + 16 new matchAdopt tests)
- [x] **Default mode = auto** 寫死喺 `matchAdopt`, 唔可以 silent default manual
- [x] **Soft-reject wording 3B** 固定 string, 將來改 UX 必須 update RG entry
- [x] **Pre-flight 1 + 2 順序固定** (session check 先, existing project check 後) — 反轉會撞 race

### Refactor Guard
任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/discord/handlers/hermesCommands.test.ts` 並確認 15 個 `matchAdopt` test 全部 PASS
2. 跑 `bun test` 全 suite (344/344 + 1 skip)
3. 對住 invariant table I-1..I-20 逐個 check 冇違反
4. 改 `state.adoption` 嘅 shape 必須 update I-17
5. 改 soft-reject wording 必須 update I-14 + spec 在此 entry
6. 改 default mode 由 auto 改 manual 必須 update I-1 + David explicit approve

### Detection signal (出現以下即 RG-004 走樣)
- David 喺 plain thread 打 `/project setMode auto 1m` 仲係見 `No Hermes project`(即我哋冇 suggest `/project adopt` 替代)
- David 喺 plain thread 用 `/project adopt` 後, `/project status` 冇顯示 `adoption` field(冇 audit trail)
- David 喺有 Hermes project 嘅 thread 用 `/project adopt` 居然 overwrite(soft-reject 失效)
- Hermes projects 數量突然爆升(冇 soft-reject, 重複 adopt 多次)
- `state.json` 冇 `journal` entry `type: "adopt"`(audit trail 漏寫)

### 相關 Discussion
- 2026-06-22 David 講「我大部分時間都不會叫hermes 去直接開一個項目,一開始項目要談需求」→ workflow gap 確認
- 2026-06-22 David 揀 Option C over A (auto-upgrade with placeholder) + B (prompt for goal inline)
- 2026-06-22 Decision 1A (default = auto 4h) + 2A (soft-reject existing project) + 3B (preview goal in reject) + 4C (structured adoption field)

---

## RG-005: Hermes runner paths bypassed `makeClaudeSend` (2026-06-22)

**Symptom**: David 喺 Discord thread `1518449774817181837` (auto-mode Hermes project) 內觀察到 Claude Code 嘅 reply 全部**冇** `🤖 **Claude Code:**` prefix — 20 條 message 全部 0/20 有 prefix。對比 `streaming.ts:forwardToClaude` 嘅 CC reply 一直有 prefix, 出現明顯 UX 不一致。

**Root cause**: UX-3 (commit `e8f43ea`) 將 `streaming.ts:212,336` 嘅 `forwardToClaude` 包咗 `makeClaudeSend`, 但漏咗另外兩個 call site:
- `hermes/orchestrator.ts:runProject` (line 291, auto-mode task executor) — 直接 `(content) => deps.thread.send(content).then(...)`, 冇 prefix
- `hermes/orchestrator.ts:runManualProject` (line 655, manual-mode runner) — 直接 `deps.thread.send(content)`, 冇 prefix

兩個 call site 都將個 `send` callback 傳入 `runViaSdk`, 由 `sdkRunner.ts:301` 喺 CC 嘅 text-only assistant message 時 auto-post 到 Discord — 由於 callback 本身冇 prefix, 出現「raw CC text 冇 tag 落到 Discord」嘅 regression。

**Fix** (commit pending): 
1. `hermes/orchestrator.ts:291,655` 兩個 call site 改用 `makeClaudeSend(deps.thread)` 包裹
2. `discord/handlers/streaming.ts` 加 branded type `PrefixedSend = (content: string) => Promise<Message> & { readonly __brand: "PrefixedSend" }`, 強制 `runViaSdk` 同 `ExecutorDeps` 嘅 `send` param 必須係 `PrefixedSend` — 任何 raw `thread.send` wrapper 會喺 typecheck 階段 fail
3. `makeClaudeSend` return type 改為 `PrefixedSend`(配合 branded type)
4. 加 audit test 喺 `orchestrator.test.ts` RG-005 describe block (mock `runViaSdk` capture 個 callback, 確認 fake thread 收到 prefixed text)

### Decision log
- Branded type 唔放 generic types.ts: keep 喺 `discord/handlers/streaming.ts` 因為 `PrefixedSend` 同 `CLAUDE_PREFIX` / `makeClaudeSend` 係同一個 UX-3 嘅 cohesive unit
- 唔改 `runViaSdk` 入面 `send: Promise<Message>` 嘅 internal call(sdkRunner 內部唔 care 個 callback 係咪 prefix, 佢只 forward), 只 enforce 入口 signature
- Audit test 用 `mock.module("../agent/sdkRunner")` capture callback 然後 manual invoke 確認 wire-level prefix 行為(brand 係 typecheck-only, 唔可以喺 runtime assert)

### Invariants (必須一齊保持)

| #  | Invariant | Lock test |
|----|-----------|-----------|
| I-1 | `runProject` (auto-mode) 個 `send` callback 傳入 `runViaSdk` 必須係 `PrefixedSend` | `orchestrator.test.ts` "RG-005 ... runProject auto-mode wraps send with makeClaudeSend" |
| I-2 | `runManualProject` 個 `send` callback 傳入 `runViaSdk` 必須係 `PrefixedSend` | `orchestrator.test.ts` "RG-005 ... runManualProject wraps send with makeClaudeSend" |
| I-3 | `runViaSdk` 嘅 `send` param type = `PrefixedSend`(raw thread.send 會 typecheck fail) | `tsc --noEmit` 0 errors |
| I-4 | `ExecutorDeps.send` type = `PrefixedSend` | `tsc --noEmit` 0 errors |
| I-5 | `makeClaudeSend(thread, queue?)` return type = `PrefixedSend` | `tsc --noEmit` 0 errors |
| I-6 | `PrefixedSend` 嘅 `__brand` 係 `readonly` 唔可以 mutate | grep `streaming.ts` 確認 `readonly __brand: "PrefixedSend"` |
| I-7 | Hermes thread 嘅 CC reply 全部 100% 有 `🤖 **Claude Code:**` prefix | Discord audit: count of bot messages with no prefix = 0 |
| I-8 | `CLAUDE_PREFIX = "🤖 **Claude Code:**"` 唔可以改(snapshot for Discord message identity) | `streaming.test.ts` "CLAUDE_PREFIX is stable" |

### 防止再發 (防護措施)
- [x] **Branded `PrefixedSend` type** 喺 `streaming.ts` typecheck-level enforcement
- [x] **2 new RG-005 audit tests** 喺 `orchestrator.test.ts` 全部 PASS
- [x] **All 346 tests pass** (344 + 2 new RG-005 tests)
- [x] **Type-check clean** (tsc --noEmit)
- [x] **Subagent verified regression**: temporarily breaking `claudeSend = makeClaudeSend(...)` line 確認 test 立即 fail
- [x] **3 call sites audited**: streaming.ts:217, orchestrator.ts:291, orchestrator.ts:655 全部 satisfy `PrefixedSend`

### Refactor Guard
任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/hermes/orchestrator.test.ts` 並確認 RG-005 嘅 2 個 test 全部 PASS
2. 跑 `bunx tsc --noEmit` 確認 typecheck clean(I-3, I-4, I-5 強制)
3. 改 `CLAUDE_PREFIX` 必須 update I-8 + David explicit approve(prefix 係 Discord message identity, 改咗會 confuse audit log)
4. 改 `PrefixedSend` 嘅 brand 形狀(由 `"PrefixedSend"` 改其他) 必須 update I-6 + 確認所有 call site 仍然 satisfy
5. 任何新 call site 加落 `runViaSdk` 必須 type `send: PrefixedSend` 同 wrap with `makeClaudeSend`
6. 任何新 Hermes runner 寫 `executeTask(...)` 必須 confirm `ExecutorDeps.send = makeClaudeSend(...)`

### Detection signal (出現以下即 RG-005 走樣)
- Hermes-managed project 嘅 thread CC reply 冇 prefix(brand wrap 漏咗 / raw thread.send pass-through)
- `tsc --noEmit` 報 `Argument of type '(content: string) => Promise<Message>' is not assignable to parameter of type 'PrefixedSend'` (新 call site 冇 satisfy branded type)
- 改咗 `makeClaudeSend` 嘅 return type 由 `PrefixedSend` 改返 `(content: string) => Promise<Message>` (weakens type enforcement)
- 改咗 `PrefixedSend.__brand` 由 `readonly` 改 mutable(可以用 mutation 偽造 brand)
- Hermes project 嘅 Discord thread 內 CC output 同 Hermes status 視覺上混淆

### 相關 Discussion
- 2026-06-22 David 講「給我看看 discord thread ID= 1518449774817181837 嗎?輸出沒有您講的 hermes: 和 cc: 的 prefix」→ 揭發呢個 regression
- 2026-06-22 David 揀 fix approach = F2 (branded type) + F3 (audit test), reject F1 (minimal fix without enforcement)
- 2026-06-22 紅線 13/14 落實: branded type 係 typecheck-level 防護, audit test 係 runtime 防護, 兩層互補

---

## RG-006: `/project setMode auto` did not auto-resume terminal project (2026-06-22)

**Symptom**: David 喺一個 Hermes-managed project thread 入面順序執行 `/project setMode manual` → `/project setMode auto` 嘅時候, setMode auto 雖然 reply "Project mode → auto, timer = 4h", 但 Hermes orchestrator 冇 resume — 後續 message 全部 fall through 去 Claude Code(forwardToClaude), user 期望 Hermes 接手嘅 workflow 斷裂。要手動再打 `/project resume` 先至 work, 對 user 嚟講係 NG UX。

**Root cause**: `handleProjectSetMode` 嘅 auto branch(line 699-755 修補前)只做:
1. Parse + clamp duration
2. Set `state.mode = "auto"`
3. Arm wallclock timer
4. Save state + append journal

**冇** 任何 trigger `runProject` resume 個 orchestrator loop 嘅 logic。 設計文檔(line 602-606 修補前)明文寫住: "If terminal, this is a no-op for the running loop but the next /project resume will pick up the timer" — 即係 by design 用戶要打兩次 command(setMode auto + resume)。但 user 嘅 mental model 係: "切返 auto = 交返俾 Hermes = 自動接住做"。

**Fix** (commit pending): `handleProjectSetMode` 嘅 auto branch 喺 arm timer 之後加 `if (!isActive(state))` block:
- Capture pre-resume status (用 `fromStatus` local var)
- Set `state.status = "executing"`, `state.endedAt = null`, `saveState`
- Append journal `auto-resumed by /project setMode auto (was <fromStatus>)`
- 讀 `session = store?.get(threadId)` 拎 `claudeSession` resume token
- `runProject(state.id, { hermesDir, thread, claudeSession, userMsgStub: msg }).catch(...)` fire-and-forget

`handleProjectSetMode` signature 加 `store?: SessionStore` 5th param(向後兼容, test fixture 用 mock store)。`dispatchHermesCommand` 喺 line 871 call site 將 `ctx.store` 傳入。

Reply message wording 分兩 case:
- 個 project 係 terminal → "Hermes was idle; resuming orchestrator now — it will plan remaining tasks and drive Claude Code through them."
- 個 project 係 active → 維持舊 "Hermes will plan tasks, drive Claude Code through each one, and self-assess completion."

Doc comment line 601-608 改 wording, 講明 auto-resume 係 expected behavior。

### Decision log
- Auto-resume 只喺 terminal state 觸發(active 唔觸發) — 避免 race condition 雙 orchestrator loop 同時跑
- `fromStatus` 用 local var 捕捉, 唔好直接用 `state.status` 因為 `state.status = "executing"` 已經 mutate 咗
- `store` 設為 optional 因為 test fixture 用 mock, 但 production `dispatchHermesCommand` 永遠 pass `ctx.store`
- Reply message wording "Hermes was idle" / "Hermes will plan tasks" 兩 case 揀 current-state 而不是 future-intent, 避免誤導
- 紅線 13: 呢個係 user-flow bug, 而非 logic bug — audit test mock `runProject` capture call args, 確認 wire-level 行為

### Invariants (必須一齊保持)

| #  | Invariant | Lock test |
|----|-----------|-----------|
| I-1 | `setMode auto` 喺 terminal project(`status` ∈ {`killed`, `failed`, `done`}) 會 trigger `runProject(projectId, ...)` | `hermesCommands.test.ts` "RG-006 ... I-1: setMode auto on a TERMINAL project triggers runProject" |
| I-2 | `setMode auto` 喺 terminal project 會 flip `state.status = "executing"` + clear `state.endedAt` | "I-2: ... flips status to executing and clears endedAt" |
| I-3 | `setMode auto` 喺 terminal project 會 append journal entry 包含 "auto-resumed by /project setMode auto (was <preStatus>)" | "I-3: ... appends 'auto-resumed by /project setMode auto' journal entry" |
| I-4 | `setMode auto` 喺 active project(`status` ∈ {`planning`, `executing`, `judging`}) **唔會** call `runProject` | "I-4: ... on an ACTIVE project does NOT call runProject" |
| I-5 | `setMode manual` 永遠 **唔會** call `runProject`(auto-resume 係 auto-only 行為) | "I-5: setMode manual does NOT call runProject" |
| I-6 | `setMode auto` 冇 duration 嘅時候用 `HERMES_MAX_WALL_HOURS` cap (default 4h), 個 `state.timer.requestedDuration` 包含 "(default)" marker | "I-6: setMode auto without duration uses the safety cap default (4h)" |
| I-7 | Reply message wording: terminal 個 case 包含 "resuming orchestrator", active 個 case 包含 "will plan tasks" (互斥) | "I-7: ... contains 'resuming orchestrator' when project is terminal" + "I-7 (active): ... 'will plan tasks' phrasing" |
| I-8 | `handleProjectSetMode` 個 signature 必須接受 `store?: SessionStore` 5th param | grep `hermesCommands.ts` 確認 `store?: SessionStore` |
| I-9 | `dispatchHermesCommand` 喺 setMode match 個 call site 必須 pass `ctx.store` | grep `dispatchHermesCommand` 確認 `ctx.store,` |
| I-10 | `setMode auto` 個 audit journal entry 必須 capture pre-resume status 喺 "was <fromStatus>" suffix, 而唔好寫 "was executing" | grep journal.log 確認 "was killed" / "was failed" / "was done" suffix, 唔應該 "was executing" |

### 防止再發 (防護措施)
- [x] **8 RG-006 audit tests** 喺 `hermesCommands.test.ts` 全部 PASS(7 invariants + 1 bonus explicit duration test)
- [x] **All 355 tests pass** (346 + 9 new — 8 invariants + 1 bonus)
- [x] **Type-check clean** (tsc --noEmit)
- [x] **3 call sites audited**: line 612 (signature), line 781 (auto-resume logic), line 871 (dispatcher call site) 全部 satisfy contract

### Refactor Guard
任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/discord/handlers/hermesCommands.test.ts` 並確認 RG-006 嘅 8 個 test 全部 PASS
2. 跑 `bunx tsc --noEmit` 確認 typecheck clean(I-8, I-9 強制)
3. 改 `handleProjectSetMode` 嘅 auto branch 必須保持 auto-resume 行為 — 移除 / weaken 會撞 I-1, I-2, I-3
4. 改 reply message wording 必須 update I-7
5. 改 `fromStatus` 個 capture pattern(例如直接用 `state.status`) 會 silently break I-10(個 audit log 寫 "was executing" 失去 audit trail 意義)
6. 改 `store` 變 required param 會撞 production call site(必須 `ctx.store` 已經有)
7. 改 `runProject(...)` 嘅 fire-and-forget pattern(例如改 `await`)會 block message handler

### Detection signal (出現以下即 RG-006 走樣)
- David 喺 terminal project 打 `/project setMode auto` 仲要打 `/project resume` 先 work(我哋 silently 拎走咗 auto-resume)
- Hermes-managed project 嘅 journal.log 入面有 `auto-resumed by /project setMode auto (was executing)` — 即係 `fromStatus` capture 失效, audit trail 失去原 status info
- 個 `runProject` 喺 active project 都被 call 咗 → 撞 race condition, 個 orchestrator loop 有 duplicate instance
- `setMode manual` 都 trigger resume → 紅線 1 違反(manual 應該 pause orchestrator, 唔 resume)
- `handleProjectSetMode` 個 signature 冇 `store` 5th param → `dispatchHermesCommand` call site 撞 TS error

### 相關 Discussion
- 2026-06-22 David 揀 fix approach = Option 1 (auto-resume 喺 setMode auto), 拒絕 Option 2 (doc-only), Option 3 (新 `/project restart`), Option 4 (skip)
- 2026-06-22 David 講「docs 都要跟」 → commit 同時 update doc comment (line 601-608) + reply message wording
- 2026-06-22 紅線 13: 8 個 invariants 全部有對應 lock test, audit trail 完整
- 2026-06-22 subagent 喺 audit test 寫作時 timeout(49 calls 600s), 我接手完成 + 修 3 個 subagent 嘅 bugs: (a) tmpRoot subdir mismatch, (b) threadId collision, (c) `fromStatus` mutate-before-use
