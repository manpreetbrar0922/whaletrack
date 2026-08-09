#!/bin/bash
# WhaleTrack Watchdog — auto-restarts crashed daemons + alerts Telegram
# Runs every 2 min via cron

BOT_TOKEN=$(grep "^BOT_TOKEN" /Users/manpreetbrar/whaletrack/.env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
ADMIN_CHAT_ID=$(grep "^ADMIN_CHAT_ID" /Users/manpreetbrar/whaletrack/.env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
PID_FILE="/Users/manpreetbrar/whaletrack/whale_daemon.pid"

send_alert() {
  local msg="$1"
  if [ -n "$BOT_TOKEN" ] && [ -n "$ADMIN_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${ADMIN_CHAT_ID}\",\"text\":\"${msg}\",\"parse_mode\":\"HTML\"}" > /dev/null
  fi
}

# ── Check Twitter daemon ─────────────────────────────────────────────────────
# Use PID file first (most reliable), fall back to pgrep
DAEMON_UP=false
if [ -f "$PID_FILE" ]; then
  SAVED_PID=$(cat "$PID_FILE")
  if kill -0 "$SAVED_PID" 2>/dev/null; then
    DAEMON_UP=true
  fi
fi
# Double-check with pgrep in case PID file is stale
if ! $DAEMON_UP && pgrep -f "whale_alert_twitter" > /dev/null; then
  DAEMON_UP=true
fi

if ! $DAEMON_UP; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠️ Twitter daemon DOWN — restarting..."
  rm -f "$PID_FILE"  # remove stale PID file so start script doesn't block
  bash /Users/manpreetbrar/whaletrack/start_whale_twitter.sh >> /Users/manpreetbrar/whaletrack/watchdog.log 2>&1
  sleep 3
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    send_alert "✅ WhaleTrack: Twitter daemon restarted automatically"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✅ Twitter daemon restarted (PID $(cat $PID_FILE))"
  else
    send_alert "🚨 WhaleTrack: Twitter daemon FAILED to restart — check server!"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ❌ Twitter daemon failed to restart"
  fi
fi

# ── NEW: Check Telegram env vars are loaded in running process ───────────────
# Bot might be running but missing BOT_TOKEN (happens if manually restarted wrong)
BOT_PID=$(pgrep -f "whale_alert_twitter.cjs" | head -1)
if [ -n "$BOT_PID" ]; then
  PROC_ENV=$(ps eww -p "$BOT_PID" 2>/dev/null)
  if ! echo "$PROC_ENV" | grep -q "BOT_TOKEN"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠️ BOT_TOKEN missing from running process — restarting with correct envs..."
    pkill -f "whale_alert_twitter.cjs" 2>/dev/null
    rm -f "$PID_FILE"
    sleep 2
    bash /Users/manpreetbrar/whaletrack/start_whale_twitter.sh >> /Users/manpreetbrar/whaletrack/watchdog.log 2>&1
    sleep 3
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      send_alert "✅ WhaleTrack: Telegram env fixed — bot restarted with correct credentials"
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✅ Restarted with BOT_TOKEN loaded (PID $(cat $PID_FILE))"
    fi
  fi
fi

# ── Check Telegram bot ───────────────────────────────────────────────────────
if ! pgrep -f "node.*bot/index.js" > /dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠️ Telegram bot DOWN — restarting..."
  bash /Users/manpreetbrar/whaletrack/start_telegram_bot.sh >> /Users/manpreetbrar/whaletrack/watchdog.log 2>&1
  sleep 3
  if pgrep -f "node.*bot/index.js" > /dev/null; then
    send_alert "✅ WhaleTrack: Telegram bot restarted automatically"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✅ Telegram bot restarted"
  else
    send_alert "🚨 WhaleTrack: Telegram bot FAILED to restart — check server!"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ❌ Telegram bot failed to restart"
  fi
fi
