#!/usr/bin/env bash
# Aggregate smoke-test runner for claude-bridge.
#
# Runs every Hermes M# E2E smoke script + the matching automated
# `bun test` blocks, then prints a one-line summary so you can decide
# whether to ship / deploy / hand off without reading 100 lines of
# output.
#
# Usage:
#   bun run smoke                      # run all
#   bun run smoke --m2                 # only the M2 block
#   bun run smoke --m2 --automated     # only the automated half
#
# Exit code: 0 if every block passed, 1 otherwise.
#
# Per-block scripts live in scripts/smoke-*.sh — each one is the manual
# E2E walkthrough. The "automated" path runs the bun test block that
# covers the same invariants (faster, no Discord interaction).

set -uo pipefail

cd "$(dirname "$0")/.."

ONLY=""
AUTOMATED_ONLY=0
MANUAL_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --m2) ONLY="m2" ;;
    --automated) AUTOMATED_ONLY=1 ;;
    --manual) MANUAL_ONLY=1 ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

# 1. Automated: bun test of orchestrator / Hermes M# invariants
run_automated() {
  local label="$1"
  local pattern="$2"
  echo "--- [automated] $label — bun test $pattern ---"
  if bun test "$pattern"; then
    return 0
  else
    echo "❌ [automated] $label FAILED"
    return 1
  fi
}

# 2. Manual: print the script's expected output + verify preconditions
run_manual() {
  local label="$1"
  local script="$2"
  if [[ ! -x "$script" ]]; then chmod +x "$script"; fi
  echo "--- [manual]    $label — $script ---"
  echo "(This script prints each step + expected Discord output."
  echo " Run it inside a Discord thread context; it does NOT send"
  echo " anything on its own.)"
  "$script" || true   # manual scripts intentionally non-zero when
                      # the user passes --help / empty thread URL
}

should_run() {
  local key="$1"
  [[ -z "$ONLY" || "$ONLY" == "$key" ]]
}

RESULTS=()

if should_run "m2"; then
  if (( MANUAL_ONLY == 0 )); then
    if run_automated "M2.x orchestrator invariants" "src/hermes/orchestrator.test.ts"; then
      RESULTS+=("automated:M2 PASS")
    else
      RESULTS+=("automated:M2 FAIL")
    fi
  fi
  if (( AUTOMATED_ONLY == 0 )); then
    run_manual "M2.11 setMode auto duration" "scripts/smoke-m2.sh"
    RESULTS+=("manual:M2.11 printed")
  fi
fi

echo ""
echo "=== smoke summary ==="
printf '  %s\n' "${RESULTS[@]}"
echo ""

# Exit non-zero if any automated block failed
if printf '%s\n' "${RESULTS[@]}" | grep -q FAIL; then
  exit 1
fi
exit 0