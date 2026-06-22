#!/usr/bin/env bash
# Manual E2E smoke for M2.11 — `/project setMode auto <duration>`.
#
# This script does NOT run Hermes itself. It walks David through the
# manual steps + verification commands so the E2E pass is reproducible
# and the criteria are explicit.
#
# Pre-conditions:
#   - Bot is running (`bun run dev` or `launchd` loaded)
#   - A Hermes project thread exists in the configured channel
#   - You have permission to send /project setMode in that thread
#
# Usage:
#   1. Open the project thread in Discord
#   2. Run this script in a terminal — it prints each step
#   3. After each step, verify the expected output in Discord
#
# Exit code 0 = all steps observed; non-zero = mismatch.

set -uo pipefail

THREAD_URL="${1:-}"
if [[ -z "$THREAD_URL" ]]; then
  echo "Usage: $0 <discord-thread-url>"
  echo ""
  echo "Pass the thread URL so you can copy/paste the bot's /project"
  echo "commands directly. The script only prints expected Discord"
  echo "output and timing — you do the actual sending."
  exit 64
fi

echo "=== M2.11 manual E2E smoke ==="
echo "Thread: $THREAD_URL"
echo ""
echo "Step 1 — arm a 1m timer on an active (planning/executing) project:"
echo "  /project setMode auto 1m"
echo ""
echo "Expected Discord output (within 1s):"
echo "  🔧 Project mode → \`auto\`, timer = \`1m\`..."
echo "  (no 'Cannot change mode while project is active' gate)"
echo ""
echo "Step 2 — confirm status embed shows live countdown:"
echo "  /project status"
echo ""
echo "Expected: a new line in the embed:"
echo "  ⏱ Timer: 0:59..1:00 remaining (auto, 1m)"
echo ""
echo "Step 3 — wait ~70s (longer than 1m, plus a judge-pass window)."
echo "  The orchestrator's next judge pass (after the timer fires) will"
echo "  see state.timer.expiresAt past and call softExit(..., 'duration_expired')."
echo ""
echo "Expected Discord output (after 60–90s):"
echo "  🪪 Hermes: ⏱ **Auto-mode duration elapsed** — project stopped at next judge pass."
echo "  Tasks completed: <n>/<total>. Elapsed: <n> min."
echo "  Use /project resume to continue (without the old timer)..."
echo ""
echo "Step 4 — confirm state is now killed (duration_expired):"
echo "  /project status"
echo ""
echo "Expected: 'Status: \`killed\` | Mode: \`auto\`' (or 'manual' if you flipped)"
echo "  No timer line (cleared by softExit)."
echo ""
echo "Step 5 — verify journal entry:"
echo "  ls -lt ~/.claude/hermes/<project-id>/state.json"
echo "  cat ~/.claude/hermes/<project-id>/journal.jsonl | tail -5"
echo ""
echo "Expected journal tail:"
echo "  {...,\"type\":\"status\",\"message\":\"mode changed → auto (timer=1m)\",...}"
echo "  {...,\"type\":\"status\",\"message\":\"killed (duration_expired)\",...}"
echo "  {...,\"type\":\"timer\",\"message\":\"timer fired at judge boundary\",...}"
echo ""
echo "=== If any step fails ==="
echo "  - 'Cannot change mode while project is active': M2.7 not applied."
echo "    Re-check commit 2b08360 + handleProjectSetMode in src/discord/handlers/hermesCommands.ts"
echo "  - No timer line in status: M2.8 not applied."
echo "    Re-check src/hermes/discord.ts formatTimerLine + formatStatusEmbed"
echo "  - softExit never fires: M2.4 not wired into runProject judge block."
echo "    Re-check src/hermes/orchestrator.ts checkTimerExpired call site"
echo ""
