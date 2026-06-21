#!/usr/bin/env bash
# memory-watchdog.sh — keep Claude-bridge alive when VM free RAM gets low
#
# Cron via ~/Library/LaunchAgents/com.claude.memory-watchdog.plist
# StartInterval=60 (every 60s)
#
# Why: claude-bridge's spawn-claude preflight requires 500MB free. When the
# Mac runs low, every @bot message errors with "insufficient memory". This
# watchdog watches free RAM and:
#   1. Logs warnings to data/memwatch.log with 15-min cooldown
#   2. Shows a macOS notification banner so David sees it without watching logs
#   3. Prints a one-line alert (cron captures stdout → /tmp)
#   4. Lists the top 3 RSS processes for fast diagnosis
#
# Silent on healthy runs — watchdog pattern (no_agent=True cron).

set -u

LOG=/Users/davidchu/www/claude-bridge/data/memwatch.log
COOLDOWN_FILE=/tmp/memwatch.last_alert
COOLDOWN_SEC=900   # 15 min between alerts

ts() { date +%Y-%m-%dT%H:%M:%S%z; }
free_mb() {
  # vm_stat: "Pages free: 4085."  (one row). Page size is 16384 bytes on arm64.
  local pages
  pages=$(vm_stat | awk '/^Pages free:/ {gsub(/\./,"",$3); print $3}')
  echo $(( pages * 16 / 1024 ))   # convert pages * 16KB → MB
}

now=$(date +%s)
free=$(free_mb)
ts_now=$(ts)

mkdir -p "$(dirname "$LOG")"
echo "[$ts_now] free=${free}MB" >> "$LOG"

should_alert() {
  local level=$1
  if [ ! -f "$COOLDOWN_FILE" ]; then
    return 0
  fi
  local last
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  local last_level
  last_level=$(awk -F: '{print $2}' "$COOLDOWN_FILE" 2>/dev/null || echo "")
  # Always re-alert on critical regardless of cooldown
  if [ "$level" = "CRITICAL" ] && [ "$last_level" != "CRITICAL" ]; then
    return 0
  fi
  [ $(( now - last )) -ge $COOLDOWN_SEC ]
}

# Top 3 RSS processes (excluding the watchdog itself) — fast triage context
top3=$(ps -arcwwwxo "pid=,rss=,command=" -A 2>/dev/null | \
  awk 'NR>1 && $2+0 > 0 {printf "%sMB  %s\n", $2/1024, substr($0, index($0,$3))}' | \
  head -3)

if [ "$free" -lt 500 ]; then
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
# Healthy: exit 0, no stdout. Silent watchdog.
exit 0
