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
