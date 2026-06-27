#!/usr/bin/env bash
# ram-trace-summary.sh — thin wrapper that delegates to the TypeScript analyzer.
#
# The actual analysis lives in scripts/ram-trace-analyze.ts (TypeScript,
# unit-tested). This shim just invokes it with default args. Keeping the
# bash entrypoint so existing workflows (`bun run ram:summary`) work
# unchanged.
#
# Usage:
#   bun run ram:summary
#   bun run ram:summary --json         # pass through to the analyzer
#   bun run ram:summary --threshold 600

set -uo pipefail

cd "$(dirname "$0")/.."

exec bun run scripts/ram-trace-analyze.ts "$@"