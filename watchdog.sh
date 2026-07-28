#!/bin/bash
# WhaleTrack Watchdog — auto-restarts crashed daemons + alerts Telegram
# Runs every 2 min via cron

BOT_TOKEN=$(grep "^BOT_TOKEN" /Users/manpreetbrar/whaletrack/.env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
ADMIN_CHAT_ID=$(grep "^ADMIN_CHAT_ID" /Users/manpreetbrar/whaletrack/.env | cut -d'=' -f2 | tr -d '"' | tr -d "'")

send_alert() {
  local msg="$1"
  if [ -n "$BOT_TOKEN" ] && [ -n "$ADMIN_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${ADMIN_CHAT_ID}\",\"text\":\"${msg}\",\"parse_mode\":\"HTML\"}" > /dev/null
  fi
}

# ── Check Twitter daemon ─────────────────────────────────────────────
if ! pgrep -f "node.*whale_alert_twitter.cjs" > /dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠️ Twitter daemon DOWN — restarting..."
  bash /Users/manpreetbrar/whaletrack/start_whale_twitter.sh >> /Users/manpreetbrar/whaletrack/watchdog.log 2>&1
  sleep 3
  if pgrep -f "node.*whale_alert_twitter.cjs" > /dev/null; then
    send_alert "✅ WhaleTrack: Twitter daemon restarted automatically"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✅ Twitter daemon restarted"
  else
    send_alert "🚨 WhaleTrack: Twitter daemon FAILED to restart — check server!"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ❌ Twitter daemon failed to restart"
  fi
fi

# ── Check Telegram bot ───────────────────────────────────────────────
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
