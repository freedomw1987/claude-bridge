# Deployment

claude-bridge runs as a long-lived process that bridges Discord to Claude Code.
Below: production setup for macOS (launchd) and Linux (systemd).

## Prerequisites

- Bun ≥ 1.3
- `claude` CLI on `$PATH` (e.g. `/opt/homebrew/bin/claude`)
- Discord bot token (see README.md)

## Configure env

```bash
cp .env.example .env
# Edit .env, fill in real DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_USER_ID
```

The `WorkingDirectory` and `PATH` in `com.claudebridge.bot.plist` assume
`/Users/davidchu/Sites/localhost/claude-bridge` and the system install
locations. Edit if your setup differs.

## macOS — launchd

```bash
# 1. Copy the plist
cp deploy/com.claudebridge.bot.plist ~/Library/LaunchAgents/

# 2. Edit paths inside the plist if your username or bun path differs
#    (default assumes /Users/davidchu and /Users/davidchu/.bun/bin/bun
#     and /opt/homebrew/bin for the claude CLI)

# 3. Load it
launchctl load ~/Library/LaunchAgents/com.claudebridge.bot.plist

# 4. Check it's running
launchctl list | grep claudebridge
tail -f ~/Sites/localhost/claude-bridge/data/bot.log
```

> Heads up: launchd's `PATH` does **not** inherit your shell's `PATH`.
> If `claude` lives somewhere not in the plist's `EnvironmentVariables.PATH`
> (e.g. `~/.local/bin`), the bot will log
> `Executable not found in $PATH: "claude"`. Add the directory to the
> plist's `PATH` and reload.

To unload:
```bash
launchctl unload ~/Library/LaunchAgents/com.claudebridge.bot.plist
```

## Linux — systemd

```bash
# 1. Edit deploy/claude-bridge.service — replace YOUR_USER with your username
#    Also ensure the PATH includes the directory holding `claude`.

# 2. Install
sudo cp deploy/claude-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable claude-bridge
sudo systemctl start claude-bridge

# 3. Check status
sudo systemctl status claude-bridge
sudo journalctl -u claude-bridge -f
```

## Local dev (no service manager)

```bash
bun install
bun run dev   # watches for changes
```

## Files written at runtime

| Path | Purpose |
|------|---------|
| `data/sessions.db` | SQLite session store |
| `data/bot.log` | launchd stdout (macOS only) |
| `data/bot.err.log` | launchd stderr (macOS only) |
| `~/www/discord-claude-tasks/<thread-id>/` | Per-thread repo clone (git URL targets) |

The `~/www/discord-claude-tasks/` directory accumulates over time. To clean up
old task dirs:

```bash
# Show all task dirs (with last modified time)
ls -lt ~/www/discord-claude-tasks/

# Delete a specific one
rm -rf ~/www/discord-claude-tasks/<thread-id>

# Delete all
rm -rf ~/www/discord-claude-tasks/*
```

The `data/sessions.db` keeps metadata but doesn't lock you out of deleting
the workdirs. Active `claude` processes (in the running bot) will fail to
find their workdir if you delete it mid-task.

## Logs

`LOG_LEVEL=debug` shows per-message detail. `info` (default) shows spawn / exit
events. `warn` / `error` filter to problems.

## Health check

In Discord, send `/status` in any thread created by the bot. It shows:
- thread ID
- session status
- repo URL + work dir
- claude session ID
- message count

## Upgrading

A cross-platform `deploy/restart.sh` handles pull + install + restart on both
macOS (launchd) and Linux (systemd). It restarts the service if running, or
starts it if not.

```bash
# Pull latest, install deps, then restart
./deploy/restart.sh --update

# Just restart (no pull)
./deploy/restart.sh
```

Manual equivalent (macOS):

```bash
cd ~/Sites/localhost/claude-bridge
git pull
bun install
launchctl unload ~/Library/LaunchAgents/com.claudebridge.bot.plist
launchctl load ~/Library/LaunchAgents/com.claudebridge.bot.plist
```

## Uninstall

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.claudebridge.bot.plist
rm ~/Library/LaunchAgents/com.claudebridge.bot.plist

# Linux
sudo systemctl disable claude-bridge
sudo systemctl stop claude-bridge
sudo rm /etc/systemd/system/claude-bridge.service

# Optional: remove data
rm -rf ~/Sites/localhost/claude-bridge/data
# (task workdirs at ~/www/discord-claude-tasks/* are yours to keep or delete)
```
