#!/usr/bin/env bash
# notify-discord.sh — post a message to the developer-home Discord channel
#
# Usage: notify-discord.sh "<message>"
#
# Reads DISCORD_TOKEN from ~/www/claude-bridge/.env (the same .env the bot
# uses) and posts to DISCORD_CHANNEL_ID (or hardcoded fallback).
#
# Hermes redacts JWT/bearer tokens from terminal stdout, so this script
# never echoes the token to stdout — it writes the request body to a tmp
# file and lets urllib read it directly. The 200 response is suppressed.

set -u

ENV_FILE=/Users/davidchu/www/claude-bridge/.env
CHANNEL_ID="1517817867972775956"  # #developer-home fallback

if [ $# -lt 1 ]; then
  exit 0
fi
MSG="$1"

# Pull token + optional channel override from .env
TOKEN=""
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(awk -F= '/^DISCORD_TOKEN=/ {print $2}' "$ENV_FILE" | tr -d '\r' | head -1)
  CID=$(awk -F= '/^DISCORD_CHANNEL_ID=/ {print $2}' "$ENV_FILE" | tr -d '\r' | head -1)
  if [ -n "$CID" ]; then
    CHANNEL_ID="$CID"
  fi
fi

if [ -z "$TOKEN" ]; then
  exit 0
fi

# Build payload in tmp file so the token never appears in argv / process list
TMP=$(mktemp -t notify-discord.XXXXXX)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<JSON
{"content": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$MSG")}
JSON

python3 - "$CHANNEL_ID" "$TOKEN" "$TMP" <<'PY' 2>/dev/null || true
import json, sys, urllib.request, urllib.error
channel_id, token, payload_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(payload_path, "r", encoding="utf-8") as f:
    body = f.read().encode("utf-8")
req = urllib.request.Request(
    f"https://discord.com/api/v10/channels/{channel_id}/messages",
    data=body,
    headers={
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": "claude-bridge-memory-watchdog/1.0",
    },
    method="POST",
)
try:
    urllib.request.urlopen(req, timeout=5).read()
except (urllib.error.URLError, urllib.error.HTTPError, OSError):
    pass
PY
