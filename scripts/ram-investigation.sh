#!/usr/bin/env bash
# ram-investigation.sh — diagnose what's eating system free RAM.
#
# Why: 2026-06-21 22:20-22:35 the OS-level watchdog (scripts/memory-watchdog.sh)
# killed the bot 4 times in 15 minutes because system free RAM was stuck at
# 60-170 MB, oscillating around the 200 MB kill threshold. Root cause was
# never diagnosed before the watchdog plist was disabled. This script produces
# a one-page report so the culprit is identifiable in 30 seconds.
#
# Usage: bun run ram:investigate

set -u

BOT_DIR="/Users/davidchu/www/claude-bridge"
LOG="$BOT_DIR/data/memwatch.log"

echo "=========================================="
echo "  System RAM Investigation Report"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=========================================="
echo ""

# --- VM stats summary -------------------------------------------------
echo "=== VM Stats (raw) ==="
vm_stat
echo ""

# --- Free MB -----------------------------------------------------------
free_pages=$(vm_stat | awk '/^Pages free:/ {gsub(/\./,"",$3); print $3}')
active_pages=$(vm_stat | awk '/^Pages active:/ {gsub(/\./,"",$3); print $3}')
inactive_pages=$(vm_stat | awk '/^Pages inactive:/ {gsub(/\./,"",$3); print $3}')
wired_pages=$(vm_stat | awk '/^Pages wired down:/ {gsub(/\./,"",$4); print $4}')
compressed_pages=$(vm_stat | awk '/^Pages occupied by compressor:/ {gsub(/\./,"",$5); print $5}')

free_mb=$(( free_pages * 16 / 1024 ))
active_mb=$(( active_pages * 16 / 1024 ))
inactive_mb=$(( inactive_pages * 16 / 1024 ))
wired_mb=$(( wired_pages * 16 / 1024 ))
compressed_mb=$(( compressed_pages * 16 / 1024 ))

echo "=== Free RAM ==="
echo "Free:       ${free_mb} MB"
echo "Active:     ${active_mb} MB"
echo "Inactive:   ${inactive_mb} MB"
echo "Wired:      ${wired_mb} MB"
echo "Compressed: ${compressed_mb} MB"
echo ""

# --- Top 15 processes by RSS ------------------------------------------
echo "=== Top 15 Processes by RSS ==="
printf "%6s  %-7s  %s\n" "RSS" "PID" "COMMAND"
printf -- "----------------------------------------\n"
ps -arcwwwxo "pid=,rss=,command=" -A 2>/dev/null | \
  awk 'NR>1 && $2+0 > 0 {printf "%6d  %-7s  %s\n", $2/1024, $1, substr($0, index($0,$3))}' | \
  head -15
echo ""

# --- Top 3 consumers --------------------------------------------------
echo "=== Top 3 Consumers ==="
ps -arcwwwxo "pid=,rss=,command=" -A 2>/dev/null | \
  awk 'NR>1 && $2+0 > 0' | sort -k2 -n -r | head -3 | \
  while read -r pid rss cmd; do
    cmd_short=$(echo "$cmd" | cut -c1-60)
    echo "$((rss/1024)) MB  PID $pid  $cmd_short"
  done
echo ""

# --- Known memory hogs heuristic --------------------------------------
echo "=== Known Memory Hogs (Chrome / Electron / Docker / VS Code / node) ==="
hogs=$(ps -arcwwwxo "command=" -A 2>/dev/null | \
  grep -ciE "Chrome|Chrome Helper|Electron|Docker|Code Helper|/node |VSCode")
echo "Matching processes: $hogs"
if [ "$hogs" -gt 0 ]; then
  echo "Details:"
  ps -arcwwwxo "pid=,rss=,command=" -A 2>/dev/null | \
    grep -iE "Chrome|Chrome Helper|Electron|Docker|Code Helper|/node |VSCode" | \
    awk '{printf "  %d MB  PID %s  %s\n", $2/1024, $1, substr($0, index($0,$3))}' | \
    head -10
fi
echo ""

# --- Bot RSS -----------------------------------------------------------
echo "=== Bot RSS ==="
bot_pid=$(pgrep -f "bun run src/index.ts" | head -1)
if [ -n "$bot_pid" ]; then
  bot_rss_kb=$(ps -o rss= -p "$bot_pid" 2>/dev/null || echo 0)
  bot_rss_mb=$(( bot_rss_kb / 1024 ))
  bot_etime=$(ps -o etime= -p "$bot_pid" 2>/dev/null | tr -d ' ')
  echo "Bot PID $bot_pid  RSS: ${bot_rss_mb} MB  Up: $bot_etime"
else
  echo "Bot not running"
  bot_rss_mb=0
fi
echo ""

# --- Last watchdog log entries -----------------------------------------
echo "=== Last 10 Watchdog Log Lines ==="
if [ -f "$LOG" ]; then
  tail -10 "$LOG"
else
  echo "(no memwatch.log — watchdog may never have run, or plist was disabled)"
fi
echo ""

# --- Summary -----------------------------------------------------------
echo "=========================================="
echo "  SUMMARY"
echo "=========================================="
echo "System free: ${free_mb} MB"
echo "Bot RSS:     ${bot_rss_mb} MB"
echo "Hogs:        $hogs matching processes"
echo ""

if [ "$free_mb" -lt 200 ]; then
  echo "⚠️  CRITICAL: system free < 200 MB"
  echo "   Likely culprit is one of the top 3 consumers above."
  echo "   Decision tree:"
  echo "   - Recognizable app (browser / IDE / Docker) → close it"
  echo "   - Many small processes → wired memory pressure, consider reboot"
  echo "   - Persistent after closing apps → raise watchdog thresholds in"
  echo "     scripts/memory-watchdog.sh (BOT_RSS_MAX_MB / SYSTEM_FREE_MIN_MB)"
elif [ "$free_mb" -lt 500 ]; then
  echo "⚠️  WARNING: system free < 500 MB"
  echo "   The OS watchdog (200 MB kill threshold) will trigger occasionally."
  echo "   Recommend closing heavy apps before re-enabling the watchdog."
else
  echo "✅ System free is healthy (>500 MB)"
  echo "   Safe to re-enable the OS watchdog plist at current thresholds."
fi
echo ""
