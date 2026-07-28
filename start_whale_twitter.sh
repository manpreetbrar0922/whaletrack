#!/bin/bash
# WhaleTrack Twitter Alert Daemon — start/restart script

cd /Users/manpreetbrar/whaletrack

# Kill any existing instance
pkill -f "node whale_alert_twitter.cjs" 2>/dev/null; sleep 1

# Load Twitter API keys + Telegram config
source /Users/manpreetbrar/.bullpen/.env
source /Users/manpreetbrar/whaletrack/.env

# Start as background daemon
nohup /usr/local/bin/node /Users/manpreetbrar/whaletrack/whale_alert_twitter.cjs >> /Users/manpreetbrar/whaletrack/twitter_bot.log 2>&1 &
echo "✅ WhaleTrack Twitter daemon started (PID $!)"
echo "   Polls every 60s | Sports cooldown: 3min | Regular cooldown: 25min"
echo "   Logs: tail -f /Users/manpreetbrar/whaletrack/twitter_bot.log"
