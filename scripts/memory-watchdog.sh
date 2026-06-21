#!/usr/bin/env bash
# memory-watchdog.sh — keep Claude-bridge alive when RAM pressure hits
#
# Cron via ~/Library/LaunchAgents/com.claude.memory-watchdog.plist
# StartInterval=60 (every 60s)
#
# Why: claude-bridge's spawn-claude preflight requires 500MB free. When the
# Mac runs low, every @bot message errors with "insufficient memory". On the
# 2026-06-22 5th silent death, the bot RSS climbed to 7GB+ (V8 heap thrashing
# under memory pressure) and looked dead from the user's perspective while
# the process was still R-state with 0 new log output. This watchdog:
#   1. Logs warnings to data/memwatch.log with 15-min cooldown
#   2. Shows a macOS notification banner so David sees it offline
#   3. Kills the bot when RSS > 1GB or system free < 200MB so KeepAlive
#      can fresh-restart it cleanly (better than zombie 7GB heap)
#   4. Posts a Discord message to #developer-home so the alert is visible
#      inside Discord regardless of OS notifications
#
# Silent on healthy runs — watchdog pattern.

set -u

LOG=/Users/davidchu/www/claude-bridge/data/memwatch.log
COOLDOWN_FILE=/tmp/memwatch.last_alert
COOLDOWN_FILE_KILL=/tmp/memwatch.last_kill
COOLDOWN_SEC=900
COOLDOWN_KILL_SEC=300
BOT_RSS_MAX_MB=1024
SYSTEM_FREE_MIN_MB=200
ENV_FILE=/Users/davidchu/www/claude-bridge/.env
NOTIFY_SCRIPT=/Users/davidchu/www/claude-bridge/scripts/notify-discord.sh

ts() { date +%Y-%m-%dT%H:%M:%S%z; }

free_mb() {
  local pages
  pages=$(vm_stat | awk '/^Pages free:/ {gsub(/\./,"",$3); print $3}')
  echo $(( pages * 16 / 1024 ))
}

bot_rss_mb() {
  local pid
  pid=$(pgrep -f "bun run src/index.ts" | head -1)
  if [ -z "$pid" ]; then
    echo 0
    return
  fi
  local rss_kb
  rss_kb=$(ps -o rss= -p "$pid" 2>/dev/null || echo 0)
  echo $(( rss_kb / 1024 ))
}

now=$(date +%s)
free=$(free_mb)
bot_rss=$(bot_rss_mb)
ts_now=$(ts)

mkdir -p "$(dirname "$LOG")"
echo "[$ts_now] free=${free}MB bot_rss=${bot_rss}MB" >> "$LOG"

should_alert() {
  local level=$1
  if [ ! -f "$COOLDOWN_FILE" ]; then
    return 0
  fi
  local last
  last=$(awk -F: '{print $1}' "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  local last_level
  last_level=$(awk -F: '{print $2}' "$COOLDOWN_FILE" 2>/dev/null || echo "")
  if ! [[ "$last" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if [ "$level" = "CRITICAL" ] && [ "$last_level" != "CRITICAL" ]; then
    return 0
  fi
  [ $(( now - last )) -ge $COOLDOWN_SEC ]
}

should_kill() {
  if [ ! -f "$COOLDOWN_FILE_KILL" ]; then
    return 0
  fi
  local last
  last=$(cat "$COOLDOWN_FILE_KILL" 2>/dev/null || echo 0)
  if ! [[ "$last" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  [ $(( now - last )) -ge $COOLDOWN_KILL_SEC ]
}

notify_discord() {
  if [ -x "$NOTIFY_SCRIPT" ]; then
    bash "$NOTIFY_SCRIPT" "$1" || true
  fi
}

restart_bot() {
  local reason="$1"
  local bot_pid
  bot_pid=$(pgrep -f "bun run src/index.ts" | head -1)
  if [ -z "$bot_pid" ]; then
    echo "[$ts_now] restart_bot: no bot pid, skipping" >> "$LOG"
    return 1
  fi
  echo "[$ts_now] restart_bot: killing pid=$bot_pid reason=$reason" >> "$LOG"
  kill -TERM "$bot_pid" 2>/dev/null || true
  sleep 5
  kill -KILL "$bot_pid" 2>/dev/null || true
  echo "$now" > "$COOLDOWN_FILE_KILL"
  notify_discord "♻️ bot restarted by watchdog — $reason (bot RSS was ${bot_rss}MB, system free ${free}MB)"
}

top3=$(ps -arcwwwxo "pid=,rss=,command=" -A 2>/dev/null | \
  awk 'NR>1 && $2+0 > 0 {printf "%sMB  %s\n", $2/1024, substr($0, index($0,$3))}' | \
  head -3)

if [ "$bot_rss" -gt "$BOT_RSS_MAX_MB" ]; then
  if should_kill; then
    msg="bot RSS ${bot_rss}MB > ${BOT_RSS_MAX_MB}MB cap"
    echo "[$ts_now] BOT_RSS_CRITICAL: $msg" >> "$LOG"
    restart_bot "$msg"
  fi
  if should_alert CRITICAL; then
    echo "[$ts_now] CRITICAL: $msg" >> "$LOG"
    echo "$now:CRITICAL" > "$COOLDOWN_FILE"
    printf "%s\n\nTop 3 RSS:\n%s" "$msg" "$top3"
    osascript -e "display notification \"${msg}\" with title \"claude-bridge memory\" subtitle \"bot RSS ${bot_rss}MB > 1GB\"" 2>/dev/null || true
  fi
  exit 0
fi

if [ "$free" -lt "$SYSTEM_FREE_MIN_MB" ]; then
  if should_kill; then
    msg="system free ${free}MB < ${SYSTEM_FREE_MIN_MB}MB critical"
    echo "[$ts_now] SYSTEM_FREE_CRITICAL: $msg" >> "$LOG"
    restart_bot "$msg"
  fi
  if should_alert CRITICAL; then
    msg2="claude-bridge: free RAM ${free}MB < ${SYSTEM_FREE_MIN_MB}MB critical. Claude spawns failing."
    echo "[$ts_now] CRITICAL: $msg2" >> "$LOG"
    echo "$now:CRITICAL" > "$COOLDOWN_FILE"
    printf "%s\n\nTop 3 RSS:\n%s" "$msg2" "$top3"
    osascript -e "display notification \"${msg2}\" with title \"claude-bridge memory\" subtitle \"free ${free}MB < 200MB\"" 2>/dev/null || true
  fi
elif [ "$free" -lt 500 ]; then
  if should_alert CRITICAL; then
    msg="claude-bridge: free RAM ${free}MB < 500MB critical. Claude spawns failing."
    echo "[$ts_now] CRITICAL: $msg" >> "$LOG"
    echo "$now:CRITICAL" > "$COOLDOWN_FILE"
    printf "%s\n\nTop 3 RSS:\n%s" "$msg" "$top3"
    osascript -e "display notification \"${msg}\" with title \"claude-bridge memory\" subtitle \"free ${free}MB < 500MB critical\"" 2>/dev/null || true
  fi
elif [ "$free" -lt 1024 ]; then
  if should_alert WARN; then
    msg="claude-bridge: free RAM ${free}MB low (warn). Spawns may start failing soon."
    echo "[$ts_now] WARN: $msg" >> "$LOG"
    echo "$now:WARN" > "$COOLDOWN_FILE"
    printf "%s\n\nTop 3 RSS:\n%s" "$msg" "$top3"
    osascript -e "display notification \"${msg}\" with title \"claude-bridge memory\" subtitle \"free ${free}MB\"" 2>/dev/null || true
  fi
fi

exit 0
