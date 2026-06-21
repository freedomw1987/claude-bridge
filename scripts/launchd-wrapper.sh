#!/usr/bin/env bash
# launchd-wrapper.sh — singleton guard for claude-bridge bot
#
# Problem: launchd + macOS sometimes leaks a stale `bun run src/index.ts`
#          instance when the previous run crashed silently with exit 0.
#          Multiple zombies accumulate RSS and starve Claude spawns.
#
# Fix: on entry, kill any OTHER `bun run src/index.ts` whose CWD matches
#      $PWD (i.e. the claude-bridge workdir). Then exec the real command.
#
# Wired into ~/Library/LaunchAgents/com.claudebridge.bot.plist
# ProgramArguments[0] = /bin/bash /Users/davidchu/www/claude-bridge/scripts/launchd-wrapper.sh
# ProgramArguments[1..] = bun run start
#
# Hard safety: only targets the configured CWD; never blanket-kills bun.

set -euo pipefail

WORKDIR="/Users/davidchu/www/claude-bridge"
SELF_PID=$$
LOG=/tmp/launchd-wrapper.log

ts() { date +%Y-%m-%dT%H:%M:%S%z; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

cd "$WORKDIR"
log "wrapper start pid=$SELF_PID cmd=$*"

# Find all bun processes running src/index.ts whose CWD matches WORKDIR.
# lsof gives the CWD via the file descriptor on the dir; ps -o command
# is the cross-platform alternative. POSIX-portable — macOS bash 3.2
# ships without `mapfile`, so accumulate via while-read into a string.
ZOMBIES=""
while IFS= read -r pid; do
  [ -z "$pid" ] && continue
  [ "$pid" = "$SELF_PID" ] && continue
  cwd=$(lsof -d cwd -p "$pid" -F n 2>/dev/null | awk '/^n/ {sub(/^n/,""); print; exit}')
  if [ "$cwd" = "$WORKDIR" ]; then
    if [ -z "$ZOMBIES" ]; then
      ZOMBIES="$pid"
    else
      ZOMBIES="$ZOMBIES $pid"
    fi
  fi
done < <(ps -A -o pid=,command= | awk '/bun run src\/index\.ts/ {print $1}')

if [ -n "$ZOMBIES" ]; then
  count=$(echo "$ZOMBIES" | wc -w | tr -d ' ')
  log "found $count zombie bun instance(s): $ZOMBIES"
  for pid in $ZOMBIES; do
    log "kill -TERM $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in $ZOMBIES; do
    if kill -0 "$pid" 2>/dev/null; then
      log "kill -9 $pid (did not exit gracefully)"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  log "zombie cleanup done"
else
  log "no zombies found"
fi

# Exec the real command (replace this shell; preserve PID so launchd tracking works)
log "exec $*"
exec "$@"
