#!/usr/bin/env bash
# ram-trace-summary.sh — summarize data/ram-trace.log produced during a run.
#
# Used after a long task to confirm SDK-era RSS stayed below the 800 MB
# self-watchdog threshold. If peak > 500 MB, the streaming fix from
# ADR-0002 may have regressed — file an issue.
#
# Usage: bun run ram:summary

set -u

TRACE="/Users/davidchu/www/claude-bridge/data/ram-trace.log"

if [ ! -f "$TRACE" ]; then
  echo "No trace file at $TRACE"
  echo "Set BOT_RAM_TRACE=1 in .env and restart the bot to enable tracing."
  exit 0
fi

echo "=== RAM Trace Summary ==="
echo "File:  $TRACE"
echo "Lines: $(wc -l < "$TRACE" | tr -d ' ')"
echo ""

# Skip comment header lines and the column header.
data=$(grep -v "^#" "$TRACE" | grep -v "^ts," || true)
if [ -z "$data" ]; then
  echo "(no samples yet — wait for next sample interval, default 30s)"
  exit 0
fi

echo "$data" | awk -F, '
NR==1 { first_ts = $1 }
{ last_ts = $1
  rss += $2
  if (max == "" || $2 > max) max = $2
  if (min == "" || $2 < min) min = $2
  count++
  if ($2 > 500) above_500++
  if ($2 > 700) above_700++
}
END {
  printf "First sample:  %s\n", first_ts
  printf "Last sample:   %s\n", last_ts
  printf "Sample count:  %d\n", count
  printf "RSS min:       %d MB\n", min
  printf "RSS max:       %d MB\n", max
  printf "RSS avg:       %.1f MB\n", rss/count
  printf "Above 500 MB:  %d samples (%.1f%%)\n", above_500+0, (above_500+0)*100/count
  printf "Above 700 MB:  %d samples (%.1f%%)\n", above_700+0, (above_700+0)*100/count
}'

echo ""
echo "=== Last 5 samples ==="
echo "$data" | tail -5
echo ""

# Verdict
peak=$(echo "$data" | awk -F, '{if($2>max) max=$2} END{print max}')
if [ "$peak" -lt 200 ]; then
  echo "✅ Peak RSS ${peak} MB — well within healthy range (ADR-0002 O(1) claim holds)"
elif [ "$peak" -lt 500 ]; then
  echo "⚠️  Peak RSS ${peak} MB — moderate; check if a single long task is responsible"
elif [ "$peak" -lt 800 ]; then
  echo "⚠️  Peak RSS ${peak} MB — high; investigate before next long task"
else
  echo "🔴 Peak RSS ${peak} MB — exceeds 800 MB self-watchdog threshold!"
  echo "   The streaming fix from ADR-0002 may have regressed. File an issue."
fi
