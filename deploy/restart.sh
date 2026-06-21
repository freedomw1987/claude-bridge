#!/usr/bin/env bash
# deploy/restart.sh — Cross-platform restart for claude-bridge.
#
# Auto-detects launchd (macOS) or systemd (Linux) and uses the right
# service manager. If the service is not running, starts it instead
# of erroring out.
#
# Usage:
#   deploy/restart.sh           # restart (or start if not running)
#   deploy/restart.sh --update  # git pull --ff-only + bun install, then restart
#   deploy/restart.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

UPDATE=false
case "${1:-}" in
    "") ;;
    -u|--update) UPDATE=true ;;
    -h|--help)
        sed -n '2,12p' "$0"
        exit 0
        ;;
    *)
        echo "Unknown option: $1 (use --help)" >&2
        exit 2
        ;;
esac

cd "$REPO_ROOT"

if $UPDATE; then
    echo "==> git pull --ff-only"
    git pull --ff-only
    echo "==> bun install --frozen-lockfile"
    bun install --frozen-lockfile
fi

case "$(uname -s)" in
    Darwin)
        LABEL="com.claudebridge.bot"
        DOMAIN="gui/$(id -u)"
        if launchctl list 2>/dev/null | grep -q "$LABEL"; then
            echo "==> launchctl kickstart -k $DOMAIN/$LABEL"
            launchctl kickstart -k "$DOMAIN/$LABEL"
        else
            PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
            if [[ ! -f "$PLIST" ]]; then
                echo "Service not loaded and plist missing at $PLIST" >&2
                echo "See deploy/DEPLOY.md for install instructions." >&2
                exit 1
            fi
            echo "==> launchctl bootstrap $DOMAIN $PLIST"
            launchctl bootstrap "$DOMAIN" "$PLIST"
            launchctl enable "$DOMAIN/$LABEL"
            echo "==> launchctl kickstart -k $DOMAIN/$LABEL"
            launchctl kickstart -k "$DOMAIN/$LABEL"
        fi
        ;;
    Linux)
        UNIT="claude-bridge.service"
        # Prefer user-level (no sudo); fall back to system-level
        if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
            echo "==> systemctl --user restart $UNIT"
            systemctl --user restart "$UNIT"
        elif systemctl is-active --quiet "$UNIT" 2>/dev/null; then
            echo "==> sudo systemctl restart $UNIT"
            sudo systemctl restart "$UNIT"
        elif systemctl --user is-enabled --quiet "$UNIT" 2>/dev/null; then
            echo "==> systemctl --user start $UNIT"
            systemctl --user start "$UNIT"
        elif systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
            echo "==> sudo systemctl start $UNIT"
            sudo systemctl start "$UNIT"
        else
            echo "Service $UNIT not installed. See deploy/DEPLOY.md." >&2
            exit 1
        fi
        ;;
    *)
        echo "Unsupported OS: $(uname -s)" >&2
        exit 1
        ;;
esac

echo "==> done"
