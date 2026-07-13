#!/bin/bash
# WhaleTrack bug check — runs 4x daily (8AM, 12PM, 4PM, 8PM)
# Checks Twitter bot + website API for issues

LOG=/Users/manpreetbrar/whaletrack/bug_check.log
BOT_LOG=/Users/manpreetbrar/whaletrack/twitter_bot.log
DAILY_COUNT=/Users/manpreetbrar/whaletrack/twitter_daily_count.json
CYCLE_FILE=/Users/manpreetbrar/whaletrack/twitter_cycle.json

echo "" >> $LOG
echo "=== BUG CHECK $(date) ===" >> $LOG

ISSUES=0

# 1. Check bot is alive — last log entry within 15 minutes
if [ -f "$BOT_LOG" ]; then
    LAST_LINE=$(grep "\[20" "$BOT_LOG" | tail -1)
    if [ -z "$LAST_LINE" ]; then
        echo "  ❌ Bot log empty or no timestamp found" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        # Extract timestamp from line like [2026-07-10T13:20:00.778Z]
        TS_STR=$(echo "$LAST_LINE" | grep -oE '\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+Z\]' | tr -d '[]')
        if [ -n "$TS_STR" ]; then
            LAST_TS=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${TS_STR%.*}" "+%s" 2>/dev/null)
            NOW_TS=$(date +%s)
            DIFF=$((NOW_TS - LAST_TS))
            if [ "$DIFF" -gt 900 ]; then
                echo "  ❌ Bot appears stalled — last entry was ${DIFF}s ago" >> $LOG
                ISSUES=$((ISSUES+1))
            else
                echo "  ✅ Bot alive — last entry ${DIFF}s ago" >> $LOG
            fi
        else
            echo "  ⚠️  Could not parse last log timestamp" >> $LOG
        fi
    fi
else
    echo "  ❌ Bot log file missing: $BOT_LOG" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# 2. Check daily tweet count
if [ -f "$DAILY_COUNT" ]; then
    COUNT=$(python3 -c "import json; d=json.load(open('$DAILY_COUNT')); print(d.get('count',0))")
    DATE=$(python3 -c "import json; d=json.load(open('$DAILY_COUNT')); print(d.get('date',''))")
    echo "  ℹ️  Daily tweets: $COUNT/50 (date: $DATE)" >> $LOG
    if [ "$COUNT" -ge 50 ]; then
        echo "  ⚠️  Daily limit reached — no more tweets today" >> $LOG
    fi
else
    echo "  ❌ Daily count file missing" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# 3. Check cycle file
if [ -f "$CYCLE_FILE" ]; then
    LAST_CYCLE=$(python3 -c "import json; d=json.load(open('$CYCLE_FILE')); print(d.get('last','?'))")
    echo "  ℹ️  Last tweet type: $LAST_CYCLE" >> $LOG
else
    echo "  ⚠️  Cycle file missing — will be created on next tweet" >> $LOG
fi

# 4. Check recent bot errors in last 2 hours
RECENT_ERRORS=$(tail -200 "$BOT_LOG" 2>/dev/null | grep -c "❌\|ERROR\|error\|uncaughtException\|FATAL")
if [ "$RECENT_ERRORS" -gt 0 ]; then
    echo "  ❌ Found $RECENT_ERRORS error(s) in recent bot log:" >> $LOG
    tail -200 "$BOT_LOG" | grep -E "❌|ERROR|error|uncaughtException|FATAL" | tail -5 >> $LOG
    ISSUES=$((ISSUES+1))
else
    echo "  ✅ No errors in recent bot log" >> $LOG
fi

# 5. Check Polymarket API (site data source)
API_RESULT=$(curl -sf --max-time 10 'https://data-api.polymarket.com/v1/leaderboard?limit=5' 2>/dev/null)
if [ -z "$API_RESULT" ]; then
    echo "  ❌ Polymarket leaderboard API unreachable" >> $LOG
    ISSUES=$((ISSUES+1))
else
    COUNT_API=$(echo "$API_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 'ok')" 2>/dev/null)
    echo "  ✅ Polymarket API OK (returned $COUNT_API entries)" >> $LOG
fi

# 6. Check whaletrack.app API for bad names (0x... raw keys)
SITE_API=$(curl -sf --max-time 15 'https://whaletrack.app/api/whales' 2>/dev/null)
if [ -z "$SITE_API" ]; then
    echo "  ❌ whaletrack.app/api/whales unreachable" >> $LOG
    ISSUES=$((ISSUES+1))
else
    BAD_NAMES=$(echo "$SITE_API" | python3 -c "
import sys, json, re
try:
    whales = json.load(sys.stdin)
    # Bad = full 42-char 0x address OR address with timestamp suffix (e.g. 0xABC...-1722957908185)
    # Good = short form like '0x2c33…0563' (has ellipsis, not a full address)
    bad = []
    for w in whales:
        name = w.get('name', '')
        if re.match(r'^0x[0-9a-fA-F]{40}', name):  # full address
            bad.append(name)
        elif re.match(r'^0x.+-\d{10,}$', name):  # address with timestamp
            bad.append(name)
    print(len(bad))
    for b in bad: print('  BAD:', b)
except Exception as e:
    print('parse_error:', e)
" 2>/dev/null)
    FIRST=$(echo "$BAD_NAMES" | head -1)
    if [ "$FIRST" = "0" ]; then
        echo "  ✅ Site whale names look clean" >> $LOG
    elif echo "$FIRST" | grep -q "^[1-9]"; then
        echo "  ❌ Bad whale names detected on site:" >> $LOG
        echo "$BAD_NAMES" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        echo "  ⚠️  Site API check: $BAD_NAMES" >> $LOG
    fi
fi

# 7. Check seen_trades.json size (bloat guard)
SEEN_FILE=/Users/manpreetbrar/whaletrack/seen_trades.json
if [ -f "$SEEN_FILE" ]; then
    SIZE=$(wc -c < "$SEEN_FILE")
    COUNT_SEEN=$(python3 -c "import json; d=json.load(open('$SEEN_FILE')); print(len(d))" 2>/dev/null)
    echo "  ℹ️  seen_trades.json: $COUNT_SEEN entries (${SIZE} bytes)" >> $LOG
    if [ "$SIZE" -gt 500000 ]; then
        echo "  ⚠️  seen_trades.json is large (${SIZE} bytes) — may need pruning" >> $LOG
    fi
fi

# 8. Check whale topBet slugs resolve to active Polymarket markets
# Fetches /api/whales, extracts topBet slugs, verifies each via Polymarket gamma API
WHALE_DATA=$(curl -sf --max-time 20 'https://whaletrack.app/api/whales' 2>/dev/null)
if [ -z "$WHALE_DATA" ]; then
    echo "  ⚠️  Could not fetch whale data for slug check (API may still be deploying)" >> $LOG
else
    SLUG_CHECK=$(echo "$WHALE_DATA" | python3 -c "
import sys, json, urllib.request, urllib.error

whales = json.load(sys.stdin)
dead = []
checked = 0

for w in whales:
    tb = w.get('topBet') or {}
    slug = tb.get('slug', '')
    if not slug or len(slug) < 5:
        continue
    # Skip raw conditionIds (0x hex) — they don't map to event URLs
    if slug.startswith('0x'):
        continue
    checked += 1
    try:
        # Check actual Polymarket event page (not gamma API) — market slugs give 404, event slugs work
        url = f'https://polymarket.com/event/{slug}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 WhaleTrack-BugCheck'})
        with urllib.request.urlopen(req, timeout=10) as r:
            code = r.status
            if code not in (200, 301, 302, 307, 308):
                dead.append(f'{w[\"name\"]} → {slug} (HTTP {code})')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            dead.append(f'{w[\"name\"]} → {slug} (404 dead link)')
        else:
            dead.append(f'{w[\"name\"]} → {slug} (HTTP {e.code})')
    except Exception as e:
        dead.append(f'{w[\"name\"]} → {slug} (err: {e})')

print(f'checked:{checked}')
print(f'dead:{len(dead)}')
for d in dead:
    print(f'  DEAD: {d}')
" 2>/dev/null)

    DEAD_COUNT=$(echo "$SLUG_CHECK" | grep "^dead:" | cut -d: -f2)
    CHECKED_COUNT=$(echo "$SLUG_CHECK" | grep "^checked:" | cut -d: -f2)
    if [ "${DEAD_COUNT:-0}" -gt 0 ]; then
        echo "  ❌ $DEAD_COUNT dead market link(s) in whale topBets (checked $CHECKED_COUNT):" >> $LOG
        echo "$SLUG_CHECK" | grep "DEAD:" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        echo "  ✅ All whale topBet links active ($CHECKED_COUNT checked)" >> $LOG
    fi
fi

# Summary
echo "" >> $LOG
if [ "$ISSUES" -eq 0 ]; then
    echo "  ✅ All checks passed." >> $LOG
else
    echo "  ⚠️  $ISSUES issue(s) found — review above." >> $LOG
fi
echo "=== END ===" >> $LOG
