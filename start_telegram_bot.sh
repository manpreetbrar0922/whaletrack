#!/bin/bash
# WhaleTrack Telegram Bot — start/restart script
# Run this to (re)start the bot after code changes

cd /Users/manpreetbrar/whaletrack

# Kill any existing bot instance
pkill -f "node bot/index.js" 2>/dev/null; sleep 1

# Load env from .env file
export $(grep -v '^#' .env | xargs)

# Start the bot
nohup /usr/local/bin/node bot/index.js >> bot.log 2>&1 &
echo "✅ WhaleTrack Telegram Bot started (PID $!)"
echo "   Logs: tail -f /Users/manpreetbrar/whaletrack/bot.log"
