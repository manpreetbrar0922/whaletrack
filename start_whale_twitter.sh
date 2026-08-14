#!/bin/bash
# WhaleTrack Twitter Alert Daemon — start/restart script

DIR=/Users/manpreetbrar/whaletrack
PID_FILE="$DIR/whale_daemon.pid"

cd "$DIR"

# ── Guard: refuse to start a second instance ────────────────────────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "✅ Daemon already running (PID $OLD_PID) — not starting another"
    exit 0
  else
    echo "⚠️  Stale PID file (PID $OLD_PID) — removing"
    rm -f "$PID_FILE"
  fi
fi

# Kill any lingering instance by name just in case PID file was missing
pkill -f "whale_alert_twitter" 2>/dev/null; sleep 1

# Load Twitter API keys + Telegram config
# set -a makes every sourced variable automatically exported to child processes
set -a
source /Users/manpreetbrar/.bullpen/.env
source /Users/manpreetbrar/whaletrack/.env
set +a

# Start as background daemon
nohup /usr/local/bin/node "$DIR/whale_alert_twitter.cjs" >> "$DIR/twitter_bot.log" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"
echo "✅ WhaleTrack Twitter daemon started (PID $DAEMON_PID)"
echo "   Polls every 60s | Sports cooldown: 3min | Regular cooldown: 25min"
echo "   Logs: tail -f $DIR/twitter_bot.log"
