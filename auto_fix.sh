#!/bin/bash
# ============================================================
# WhaleTrack Auto-Fix — runs every 5 minutes via cron
# Detects problems and fixes them automatically.
# Only alerts you (desktop + email) when it CANNOT fix something.
# ============================================================

LOG=/Users/manpreetbrar/whaletrack/auto_fix.log
DIR=/Users/manpreetbrar/whaletrack
BULLPEN=/opt/homebrew/bin/bullpen
NODE=/usr/local/bin/node

FIXED=0      # things we fixed automatically
UNFIXED=0    # things that need human eyes
FIXES=""     # summary of what was auto-fixed
ALERTS=""    # summary of what couldn't be fixed

fix()  { FIXED=$((FIXED+1));   FIXES="$FIXES\n  ✅ FIXED: $1";  echo "  [FIX] $1" >> $LOG; }
alert(){ UNFIXED=$((UNFIXED+1)); ALERTS="$ALERTS\n  ❌ ALERT: $1"; echo "  [ALERT] $1" >> $LOG; }
info() { echo "  [info] $1" >> $LOG; }

echo "" >> $LOG
echo "=== AUTO-FIX $(date) ===" >> $LOG

# ─────────────────────────────────────────────────────────────
# FIX 1: Site responding?
# ─────────────────────────────────────────────────────────────
SITE_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 'https://whaletrack.app' 2>/dev/null)
if [ "$SITE_CODE" = "200" ]; then
    info "Site OK (200)"
else
    alert "Site returned HTTP $SITE_CODE — Vercel may be down, check https://vercel.com/dashboard"
fi

# ─────────────────────────────────────────────────────────────
# FIX 2: Dead slugs in activity feed — auto-build blocklist
# ─────────────────────────────────────────────────────────────
ACTIVITY_DATA=$(curl -sf --max-time 20 'https://whaletrack.app/api/activity' 2>/dev/null)
DEAD_SLUGS_FILE="$DIR/dead_slugs.json"

if [ -n "$ACTIVITY_DATA" ]; then
    DEAD=$(echo "$ACTIVITY_DATA" | python3 -c "
import sys, json, urllib.request, urllib.error, os

trades = json.load(sys.stdin)
dead_file = '$DEAD_SLUGS_FILE'

# Load existing blocklist
existing = []
if os.path.exists(dead_file):
    try:
        with open(dead_file) as f:
            existing = json.load(f)
    except: pass

new_dead = list(existing)
newly_found = []

for t in trades[:10]:  # check first 10
    slug = t.get('slug', '')
    if not slug or slug.startswith('0x') or len(slug) < 5:
        continue
    if slug in existing:
        continue
    try:
        url = f'https://polymarket.com/event/{slug}'
        req = urllib.request.Request(url, headers={'User-Agent': 'WhaleTrack-AutoFix/1.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            pass  # alive
    except urllib.error.HTTPError as e:
        if e.code == 404:
            new_dead.append(slug)
            newly_found.append(slug)
    except: pass

if new_dead != existing:
    with open(dead_file, 'w') as f:
        json.dump(list(set(new_dead)), f, indent=2)

print(f'found:{len(newly_found)}')
for s in newly_found: print(f'  DEAD:{s}')
" 2>/dev/null)

    NEW_DEAD=$(echo "$DEAD" | grep "^found:" | cut -d: -f2)
    if [ "${NEW_DEAD:-0}" -gt 0 ]; then
        SLUGS=$(echo "$DEAD" | grep "DEAD:" | awk -F: '{print $2}' | tr '\n' ' ')
        fix "Blocked $NEW_DEAD dead slug(s) from activity feed: $SLUGS"
    else
        info "No new dead slugs"
    fi
fi

# ─────────────────────────────────────────────────────────────
# FIX 3: twitter_seen_trades.json bloat — prune to last 300
# ─────────────────────────────────────────────────────────────
SEEN_FILE="$DIR/twitter_seen_trades.json"
if [ -f "$SEEN_FILE" ]; then
    SIZE=$(wc -c < "$SEEN_FILE")
    if [ "$SIZE" -gt 200000 ]; then
        python3 -c "
import json
with open('$SEEN_FILE') as f:
    d = json.load(f)
# Keep last 300 entries if it's a list, or last 300 keys if dict
if isinstance(d, list):
    d = d[-300:]
elif isinstance(d, dict):
    keys = list(d.keys())
    d = {k: d[k] for k in keys[-300:]}
with open('$SEEN_FILE', 'w') as f:
    json.dump(d, f)
" 2>/dev/null && fix "Pruned twitter_seen_trades.json ($SIZE bytes → trimmed to 300 entries)"
    else
        info "seen_trades.json OK (${SIZE} bytes)"
    fi
fi

# ─────────────────────────────────────────────────────────────
# FIX 4: Daily tweet counter — reset if date is stale
# ─────────────────────────────────────────────────────────────
COUNTER_FILE="$DIR/twitter_daily_count.json"
TODAY=$(date -u +%Y-%m-%d)   # use UTC to match Node.js toISOString()
if [ -f "$COUNTER_FILE" ]; then
    COUNTER_DATE=$(python3 -c "import json; d=json.load(open('$COUNTER_FILE')); print(d.get('date',''))" 2>/dev/null)
    COUNTER_COUNT=$(python3 -c "import json; d=json.load(open('$COUNTER_FILE')); print(d.get('count',0))" 2>/dev/null)
    if [ "$COUNTER_DATE" != "$TODAY" ] && [ -n "$COUNTER_DATE" ]; then
        python3 -c "
import json
with open('$COUNTER_FILE', 'w') as f:
    json.dump({'date': '$TODAY', 'count': 0}, f)
" 2>/dev/null && fix "Reset stale tweet counter (was $COUNTER_COUNT tweets on $COUNTER_DATE → reset for $TODAY)"
    else
        info "Tweet counter OK ($COUNTER_COUNT/50 on $TODAY)"
        # Warn if hitting limit (but don't alert — normal behaviour)
        if [ "${COUNTER_COUNT:-0}" -ge 48 ]; then
            info "Tweet counter near limit: $COUNTER_COUNT/50"
        fi
    fi
fi

# ─────────────────────────────────────────────────────────────
# FIX 5: Cache stale or win rate bad — force refresh
# ─────────────────────────────────────────────────────────────
HEALTH=$(curl -sf --max-time 10 'https://whaletrack.app/api/health' 2>/dev/null)
if [ -n "$HEALTH" ]; then
    CACHE_AGE=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cache_age_s',0))" 2>/dev/null)
    WHALE_COUNT=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('whales',0))" 2>/dev/null)

    info "Cache age: ${CACHE_AGE}s | Whales: $WHALE_COUNT"

    # Force refresh if cache > 15 min old or whale count suspiciously low
    if [ "${CACHE_AGE:-0}" -gt 900 ] || [ "${WHALE_COUNT:-99}" -lt 3 ]; then
        REFRESH=$(curl -sf --max-time 30 'https://whaletrack.app/api/refresh' 2>/dev/null)
        if [ -n "$REFRESH" ]; then
            NEW_WHALES=$(echo "$REFRESH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('whales',0))" 2>/dev/null)
            fix "Force-refreshed cache (was ${CACHE_AGE}s old, $WHALE_COUNT whales → now $NEW_WHALES whales)"
        else
            alert "Cache refresh endpoint unreachable — server may need restart"
        fi
    fi
else
    # /api/health not available (Vercel serverless — cache is per-request, always fresh)
    info "/api/health not available (serverless mode — cache auto-managed)"
fi

# ─────────────────────────────────────────────────────────────
# FIX 6: Win rate data quality — check + trigger refresh
# ─────────────────────────────────────────────────────────────
WHALE_DATA=$(curl -sf --max-time 20 'https://whaletrack.app/api/whales' 2>/dev/null)
if [ -n "$WHALE_DATA" ]; then
    WR_CHECK=$(echo "$WHALE_DATA" | python3 -c "
import sys, json
whales = json.load(sys.stdin)
rates = [w.get('winRate') for w in whales if w.get('winRate') not in ('—', None, 0)]
all_100 = all(r == 100 for r in rates) if len(rates) > 3 else False
print(f'all_100:{all_100}')
print(f'count:{len(rates)}')
" 2>/dev/null)
    ALL_100=$(echo "$WR_CHECK" | grep "^all_100:" | cut -d: -f2)
    WR_COUNT=$(echo "$WR_CHECK" | grep "^count:" | cut -d: -f2)

    if [ "$ALL_100" = "True" ]; then
        # Force cache refresh to try to get fresh win rates
        curl -sf --max-time 30 'https://whaletrack.app/api/refresh' > /dev/null 2>&1
        fix "Win rate all-100% detected ($WR_COUNT whales) — triggered cache refresh"
    else
        info "Win rate data looks varied ($WR_COUNT whales with rates)"
    fi
fi

# ─────────────────────────────────────────────────────────────
# FIX 7: Bot log check — detect if cron stopped firing
# ─────────────────────────────────────────────────────────────
BOT_LOG="$DIR/twitter_bot.log"
if [ -f "$BOT_LOG" ]; then
    LAST_ENTRY=$(tail -20 "$BOT_LOG" | grep "\[20" | tail -1)
    if [ -z "$LAST_ENTRY" ]; then
        alert "Twitter bot log has no recent timestamps — cron may have stopped"
    else
        BOT_AGE=$(echo "$LAST_ENTRY" | python3 -c "
import sys, re, time
from datetime import datetime, timezone
line = sys.stdin.read()
m = re.search(r'\[20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', line)
if not m:
    print(9999)
else:
    ts_str = m.group(0)[1:]
    dt = datetime.strptime(ts_str, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
    print(int(time.time() - dt.timestamp()))
" 2>/dev/null)
        if [ "${BOT_AGE:-9999}" -gt 1200 ]; then
            alert "Twitter bot silent for ${BOT_AGE}s (>20 min) — check crontab"
        else
            info "Bot alive — last entry ${BOT_AGE}s ago"
        fi
    fi
fi

# ─────────────────────────────────────────────────────────────
# FIX 8: Auto-prune auto_fix.log itself (keep last 500 lines)
# ─────────────────────────────────────────────────────────────
LOG_LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
if [ "$LOG_LINES" -gt 1000 ]; then
    tail -500 "$LOG" > /tmp/auto_fix_trim.log && mv /tmp/auto_fix_trim.log "$LOG"
    fix "Pruned auto_fix.log ($LOG_LINES lines → 500)"
fi

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
echo "" >> $LOG
if [ "$FIXED" -gt 0 ]; then
    echo "  🔧 Auto-fixed $FIXED issue(s):$FIXES" >> $LOG
fi
if [ "$UNFIXED" -gt 0 ]; then
    echo "  🚨 $UNFIXED issue(s) need attention:$ALERTS" >> $LOG
else
    echo "  ✅ All clear." >> $LOG
fi
echo "=== END ===" >> $LOG

# ─────────────────────────────────────────────────────────────
# ALERT — only fire if something COULDN'T be fixed
# ─────────────────────────────────────────────────────────────
if [ "$UNFIXED" -gt 0 ]; then
    osascript -e "display notification \"$UNFIXED issue(s) need you: $ALERTS\" with title \"🚨 WhaleTrack — Action Required\" sound name \"Submarine\"" 2>/dev/null

    echo "WhaleTrack auto-fix ran at $(date) — $UNFIXED issue(s) could NOT be auto-fixed:
$ALERTS

Auto-fixed $FIXED other issue(s):
$FIXES

Full log: $LOG" | mail -s "🚨 WhaleTrack needs you: $UNFIXED unfixable issue(s)" manpreetbrar491@gmail.com 2>/dev/null || true
fi
