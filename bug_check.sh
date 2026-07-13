#!/bin/bash
# WhaleTrack bug check — runs 4x daily (8AM, 12PM, 4PM, 8PM)
# Checks EVERY user-facing thing: site, all APIs, links, bot, data quality

LOG=/Users/manpreetbrar/whaletrack/bug_check.log
BOT_LOG=/Users/manpreetbrar/whaletrack/twitter_bot.log
DAILY_COUNT=/Users/manpreetbrar/whaletrack/twitter_daily_count.json
CYCLE_FILE=/Users/manpreetbrar/whaletrack/twitter_cycle.json

echo "" >> $LOG
echo "=== BUG CHECK $(date) ===" >> $LOG

ISSUES=0

# ─────────────────────────────────────────────────────────────
# SECTION A — SITE & APIs
# ─────────────────────────────────────────────────────────────

# A1. Homepage loads (HTTP 200)
SITE_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 'https://whaletrack.app' 2>/dev/null)
if [ "$SITE_CODE" = "200" ]; then
    echo "  ✅ Homepage loads (200)" >> $LOG
else
    echo "  ❌ Homepage returned HTTP $SITE_CODE" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# A2. /api/whales — returns ≥5 whales, no raw 0x names, no dirty ' - DIGITS' names
WHALE_DATA=$(curl -sf --max-time 20 'https://whaletrack.app/api/whales' 2>/dev/null)
if [ -z "$WHALE_DATA" ]; then
    echo "  ❌ /api/whales unreachable" >> $LOG
    ISSUES=$((ISSUES+1))
else
    WHALE_AUDIT=$(echo "$WHALE_DATA" | python3 -c "
import sys, json, re
whales = json.load(sys.stdin)
count = len(whales)
bad_raw   = [w['name'] for w in whales if re.match(r'^0x[0-9a-fA-F]{40}', w.get('name',''))]
bad_dirty = [w['name'] for w in whales if re.search(r' - \d{3,}$', w.get('name',''))]
bad_ts    = [w['name'] for w in whales if re.match(r'^0x.+-\d{10,}$', w.get('name',''))]
with_topbet = sum(1 for w in whales if w.get('topBet') and w['topBet'].get('title'))
print(f'count:{count}')
print(f'bad_raw:{len(bad_raw)}')
print(f'bad_dirty:{len(bad_dirty)}')
print(f'bad_ts:{len(bad_ts)}')
print(f'with_topbet:{with_topbet}')
for b in bad_raw+bad_dirty+bad_ts: print(f'  BAD_NAME: {b}')
" 2>/dev/null)
    W_COUNT=$(echo "$WHALE_AUDIT" | grep "^count:" | cut -d: -f2)
    W_BAD=$(echo "$WHALE_AUDIT" | grep -E "^bad_raw:|^bad_dirty:|^bad_ts:" | awk -F: '{s+=$2} END{print s+0}')
    W_TOPBET=$(echo "$WHALE_AUDIT" | grep "^with_topbet:" | cut -d: -f2)
    if [ "${W_COUNT:-0}" -lt 5 ]; then
        echo "  ❌ /api/whales returned only $W_COUNT whales (expected ≥5)" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        echo "  ✅ /api/whales OK — $W_COUNT whales, $W_TOPBET with open bet" >> $LOG
    fi
    if [ "${W_BAD:-0}" -gt 0 ]; then
        echo "  ❌ Bad whale name(s) detected:" >> $LOG
        echo "$WHALE_AUDIT" | grep "BAD_NAME:" >> $LOG
        ISSUES=$((ISSUES+1))
    fi
fi

# A3. /api/activity — returns trades, has slugs, no zero-price junk
ACTIVITY_DATA=$(curl -sf --max-time 20 'https://whaletrack.app/api/activity' 2>/dev/null)
if [ -z "$ACTIVITY_DATA" ]; then
    echo "  ❌ /api/activity unreachable" >> $LOG
    ISSUES=$((ISSUES+1))
else
    ACTIVITY_AUDIT=$(echo "$ACTIVITY_DATA" | python3 -c "
import sys, json
trades = json.load(sys.stdin)
count = len(trades)
no_slug  = sum(1 for t in trades if not t.get('slug'))
no_title = sum(1 for t in trades if not t.get('title'))
zero_px  = sum(1 for t in trades if t.get('price',0) == 0)
print(f'count:{count}')
print(f'no_slug:{no_slug}')
print(f'no_title:{no_title}')
print(f'zero_px:{zero_px}')
" 2>/dev/null)
    A_COUNT=$(echo "$ACTIVITY_AUDIT" | grep "^count:" | cut -d: -f2)
    A_NOSLUG=$(echo "$ACTIVITY_AUDIT" | grep "^no_slug:" | cut -d: -f2)
    if [ "${A_COUNT:-0}" -lt 1 ]; then
        echo "  ❌ /api/activity returned 0 trades" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        echo "  ✅ /api/activity OK — $A_COUNT trades ($A_NOSLUG without slug)" >> $LOG
    fi
fi

# A4. /api/consensus — responds (0 signals is OK, but must not error)
CONSENSUS_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 15 'https://whaletrack.app/api/consensus' 2>/dev/null)
if [ "$CONSENSUS_CODE" = "200" ]; then
    CONSENSUS_COUNT=$(curl -sf --max-time 10 'https://whaletrack.app/api/consensus' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null)
    echo "  ✅ /api/consensus OK — $CONSENSUS_COUNT signal(s)" >> $LOG
else
    echo "  ❌ /api/consensus returned HTTP $CONSENSUS_CODE" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# A5. /api/battles — responds
BATTLES_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 15 'https://whaletrack.app/api/battles' 2>/dev/null)
if [ "$BATTLES_CODE" = "200" ]; then
    BATTLES_COUNT=$(curl -sf --max-time 10 'https://whaletrack.app/api/battles' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null)
    echo "  ✅ /api/battles OK — $BATTLES_COUNT battle(s)" >> $LOG
else
    echo "  ❌ /api/battles returned HTTP $BATTLES_CODE" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# A6. /api/matches — responds
MATCHES_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 15 'https://whaletrack.app/api/matches' 2>/dev/null)
if [ "$MATCHES_CODE" = "200" ]; then
    MATCHES_COUNT=$(curl -sf --max-time 10 'https://whaletrack.app/api/matches' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null)
    echo "  ✅ /api/matches OK — $MATCHES_COUNT match(es)" >> $LOG
else
    echo "  ❌ /api/matches returned HTTP $MATCHES_CODE" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# A7. /api/positions — works for a known wallet (somalianKing)
POSITIONS_DATA=$(curl -sf --max-time 20 'https://whaletrack.app/api/positions?address=0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab' 2>/dev/null)
if [ -z "$POSITIONS_DATA" ]; then
    echo "  ❌ /api/positions unreachable" >> $LOG
    ISSUES=$((ISSUES+1))
else
    POS_COUNT=$(echo "$POSITIONS_DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 'err')" 2>/dev/null)
    echo "  ✅ /api/positions OK — $POS_COUNT position(s) for somalianKing" >> $LOG
fi

# ─────────────────────────────────────────────────────────────
# SECTION B — EXTERNAL LINKS users click
# ─────────────────────────────────────────────────────────────

# B1. Affiliate link (main CTA)
AFF_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 'https://polymarket.com?via=manpreet-singh-brar' 2>/dev/null)
if [ "$AFF_CODE" = "200" ] || [ "$AFF_CODE" = "301" ] || [ "$AFF_CODE" = "307" ]; then
    echo "  ✅ Affiliate link OK ($AFF_CODE)" >> $LOG
else
    echo "  ❌ Affiliate link returned HTTP $AFF_CODE" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# B2. Substack newsletter link
SUB_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 'https://whaletrackweekly.substack.com' 2>/dev/null)
if [ "$SUB_CODE" = "200" ] || [ "$SUB_CODE" = "301" ] || [ "$SUB_CODE" = "307" ]; then
    echo "  ✅ Substack link OK ($SUB_CODE)" >> $LOG
else
    echo "  ❌ Substack returned HTTP $SUB_CODE" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# B3. Whale topBet Copy Bet links — hit actual polymarket.com/event/SLUG
if [ -n "$WHALE_DATA" ]; then
    SLUG_CHECK=$(echo "$WHALE_DATA" | python3 -c "
import sys, json, urllib.request, urllib.error
whales = json.load(sys.stdin)
dead = []
checked = 0
for w in whales:
    tb = w.get('topBet') or {}
    slug = tb.get('slug', '')
    if not slug or len(slug) < 5 or slug.startswith('0x'):
        continue
    checked += 1
    try:
        url = f'https://polymarket.com/event/{slug}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 WhaleTrack-BugCheck'})
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status not in (200, 301, 302, 307, 308):
                dead.append(f'{w[\"name\"]} -> {slug} (HTTP {r.status})')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            dead.append(f'{w[\"name\"]} -> {slug} (404 DEAD)')
        else:
            dead.append(f'{w[\"name\"]} -> {slug} (HTTP {e.code})')
    except Exception as e:
        dead.append(f'{w[\"name\"]} -> {slug} (err)')
print(f'checked:{checked}')
print(f'dead:{len(dead)}')
for d in dead: print(f'  DEAD: {d}')
" 2>/dev/null)
    DEAD_COUNT=$(echo "$SLUG_CHECK" | grep "^dead:" | cut -d: -f2)
    CHECKED_COUNT=$(echo "$SLUG_CHECK" | grep "^checked:" | cut -d: -f2)
    if [ "${DEAD_COUNT:-0}" -gt 0 ]; then
        echo "  ❌ $DEAD_COUNT dead topBet link(s) (checked $CHECKED_COUNT):" >> $LOG
        echo "$SLUG_CHECK" | grep "DEAD:" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        echo "  ✅ All topBet Copy Bet links live ($CHECKED_COUNT checked)" >> $LOG
    fi
fi

# B4. Activity feed Copy Bet links — sample first 5 slugs from /api/activity
if [ -n "$ACTIVITY_DATA" ]; then
    ACT_SLUG_CHECK=$(echo "$ACTIVITY_DATA" | python3 -c "
import sys, json, urllib.request, urllib.error
trades = json.load(sys.stdin)
dead = []
checked = 0
for t in trades[:5]:
    slug = t.get('slug','')
    if not slug or slug.startswith('0x') or len(slug) < 5:
        continue
    checked += 1
    try:
        url = f'https://polymarket.com/event/{slug}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 WhaleTrack-BugCheck'})
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status not in (200, 301, 302, 307, 308):
                dead.append(f'{t.get(\"whale\",\"?\")} -> {slug} (HTTP {r.status})')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            dead.append(f'{t.get(\"whale\",\"?\")} -> {slug} (404 DEAD)')
        else:
            dead.append(f'{t.get(\"whale\",\"?\")} -> {slug} (HTTP {e.code})')
    except Exception:
        pass
print(f'checked:{checked}')
print(f'dead:{len(dead)}')
for d in dead: print(f'  DEAD: {d}')
" 2>/dev/null)
    ACT_DEAD=$(echo "$ACT_SLUG_CHECK" | grep "^dead:" | cut -d: -f2)
    ACT_CHECKED=$(echo "$ACT_SLUG_CHECK" | grep "^checked:" | cut -d: -f2)
    if [ "${ACT_DEAD:-0}" -gt 0 ]; then
        echo "  ❌ $ACT_DEAD dead activity feed link(s) (checked $ACT_CHECKED):" >> $LOG
        echo "$ACT_SLUG_CHECK" | grep "DEAD:" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        echo "  ✅ Activity feed links live ($ACT_CHECKED checked)" >> $LOG
    fi
fi

# ─────────────────────────────────────────────────────────────
# SECTION C — DATA QUALITY checks
# ─────────────────────────────────────────────────────────────

# C1. Upstream Polymarket API (data source)
PM_API=$(curl -sf --max-time 10 'https://data-api.polymarket.com/v1/leaderboard?limit=5' 2>/dev/null)
if [ -z "$PM_API" ]; then
    echo "  ❌ Polymarket leaderboard API unreachable" >> $LOG
    ISSUES=$((ISSUES+1))
else
    PM_COUNT=$(echo "$PM_API" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 'ok')" 2>/dev/null)
    echo "  ✅ Polymarket upstream API OK ($PM_COUNT entries)" >> $LOG
fi

# C2. Win rates sanity — flag if every single whale shows 100% (suspicious)
if [ -n "$WHALE_DATA" ]; then
    WR_CHECK=$(echo "$WHALE_DATA" | python3 -c "
import sys, json
whales = json.load(sys.stdin)
rates = [w['winRate'] for w in whales if w.get('winRate') not in ('—', None)]
all_100 = all(r == 100 for r in rates) if rates else False
print(f'rates:{len(rates)}')
print(f'all_100:{all_100}')
" 2>/dev/null)
    WR_ALL100=$(echo "$WR_CHECK" | grep "^all_100:" | cut -d: -f2)
    WR_RATES=$(echo "$WR_CHECK" | grep "^rates:" | cut -d: -f2)
    if [ "$WR_ALL100" = "True" ] && [ "${WR_RATES:-0}" -gt 3 ]; then
        echo "  ⚠️  All $WR_RATES whales showing 100% win rate — may indicate stale/bad data" >> $LOG
    else
        echo "  ✅ Win rate data looks varied ($WR_RATES whales with rates)" >> $LOG
    fi
fi

# C3. seen_trades.json bloat guard
SEEN_FILE=/Users/manpreetbrar/whaletrack/seen_trades.json
if [ -f "$SEEN_FILE" ]; then
    SIZE=$(wc -c < "$SEEN_FILE")
    COUNT_SEEN=$(python3 -c "import json; d=json.load(open('$SEEN_FILE')); print(len(d))" 2>/dev/null)
    echo "  ℹ️  seen_trades.json: $COUNT_SEEN entries (${SIZE} bytes)" >> $LOG
    if [ "$SIZE" -gt 500000 ]; then
        echo "  ⚠️  seen_trades.json large (${SIZE} bytes) — may need pruning" >> $LOG
    fi
fi

# ─────────────────────────────────────────────────────────────
# SECTION D — TWITTER BOT
# ─────────────────────────────────────────────────────────────

# D1. Bot alive — last log entry within 15 min
# Uses Python to parse UTC timestamp correctly (macOS date -j treats UTC as local → wrong diff)
if [ -f "$BOT_LOG" ]; then
    LAST_LINE=$(grep "\[20" "$BOT_LOG" | tail -1)
    if [ -z "$LAST_LINE" ]; then
        echo "  ❌ Bot log empty or no timestamp" >> $LOG
        ISSUES=$((ISSUES+1))
    else
        BOT_CHECK=$(echo "$LAST_LINE" | python3 -c "
import sys, re, time
from datetime import datetime, timezone
line = sys.stdin.read()
m = re.search(r'\[20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', line)
if not m:
    print('no_ts')
else:
    ts_str = m.group(0)[1:]  # strip leading [
    dt = datetime.strptime(ts_str, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
    diff = int(time.time() - dt.timestamp())
    print(f'diff:{diff}')
" 2>/dev/null)
        if [ "$BOT_CHECK" = "no_ts" ]; then
            echo "  ⚠️  Could not parse bot log timestamp" >> $LOG
        else
            DIFF=$(echo "$BOT_CHECK" | grep "^diff:" | cut -d: -f2)
            if [ "${DIFF:-9999}" -gt 900 ]; then
                echo "  ❌ Bot stalled — last entry ${DIFF}s ago" >> $LOG
                ISSUES=$((ISSUES+1))
            else
                echo "  ✅ Bot alive — last entry ${DIFF}s ago" >> $LOG
            fi
        fi
    fi
else
    echo "  ❌ Bot log missing: $BOT_LOG" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# D2. Daily tweet count
if [ -f "$DAILY_COUNT" ]; then
    COUNT=$(python3 -c "import json; d=json.load(open('$DAILY_COUNT')); print(d.get('count',0))")
    DATE=$(python3 -c "import json; d=json.load(open('$DAILY_COUNT')); print(d.get('date',''))")
    echo "  ℹ️  Daily tweets: $COUNT/50 (date: $DATE)" >> $LOG
    if [ "$COUNT" -ge 50 ]; then
        echo "  ⚠️  Daily tweet limit reached — no more tweets today" >> $LOG
    fi
else
    echo "  ❌ Daily count file missing" >> $LOG
    ISSUES=$((ISSUES+1))
fi

# D3. Last tweet type (cycle)
if [ -f "$CYCLE_FILE" ]; then
    LAST_CYCLE=$(python3 -c "import json; d=json.load(open('$CYCLE_FILE')); print(d.get('last','?'))")
    echo "  ℹ️  Last tweet type: $LAST_CYCLE" >> $LOG
else
    echo "  ⚠️  Cycle file missing — will be created on next tweet" >> $LOG
fi

# D4. Recent bot errors
RECENT_ERRORS=$(tail -200 "$BOT_LOG" 2>/dev/null | grep -c "❌\|ERROR\|uncaughtException\|FATAL")
if [ "$RECENT_ERRORS" -gt 0 ]; then
    echo "  ❌ $RECENT_ERRORS error(s) in recent bot log:" >> $LOG
    tail -200 "$BOT_LOG" | grep -E "❌|ERROR|uncaughtException|FATAL" | tail -5 >> $LOG
    ISSUES=$((ISSUES+1))
else
    echo "  ✅ No errors in recent bot log" >> $LOG
fi

# D5. Cooldown file — last tweet time should be recent (not stuck at 0 for days)
LAST_TWEET_FILE=/Users/manpreetbrar/whaletrack/twitter_last_tweet.json
if [ -f "$LAST_TWEET_FILE" ]; then
    LAST_TWEET_AGE=$(python3 -c "
import json, time
d = json.load(open('$LAST_TWEET_FILE'))
ts = d.get('ts', 0)
if ts == 0:
    print('never')
else:
    age_h = (time.time()*1000 - ts) / 3600000
    print(f'{age_h:.1f}h ago')
" 2>/dev/null)
    echo "  ℹ️  Last tweet: $LAST_TWEET_AGE" >> $LOG
fi

# ─────────────────────────────────────────────────────────────
# SUMMARY + NOTIFY
# ─────────────────────────────────────────────────────────────

echo "" >> $LOG
TOTAL_CHECKS=18
if [ "$ISSUES" -eq 0 ]; then
    echo "  ✅ All $TOTAL_CHECKS checks passed." >> $LOG
else
    echo "  ⚠️  $ISSUES issue(s) found — review above." >> $LOG
fi
echo "=== END ===" >> $LOG

HOUR=$(date +%H)

if [ "$ISSUES" -gt 0 ]; then
    # Desktop alert with sound
    osascript -e "display notification \"⚠️  $ISSUES issue(s) found — check bug_check.log\" with title \"🚨 WhaleTrack Bug Alert\" sound name \"Submarine\"" 2>/dev/null

    # Email issue list
    ISSUE_LINES=$(grep -E "❌|⚠️" "$LOG" | tail -20)
    echo "WhaleTrack bug check at $(date):

$ISSUE_LINES

Full log: $LOG" | mail -s "🚨 WhaleTrack: $ISSUES issue(s) found" manpreetbrar491@gmail.com 2>/dev/null || true

    # Write issues file for quick manual check
    {
        echo "=== ISSUES FOUND $(date) ==="
        grep -E "❌|⚠️" "$LOG" | tail -20
    } > /Users/manpreetbrar/whaletrack/latest_issues.txt

else
    # 8AM daily "all clear" notification only
    if [ "$HOUR" = "08" ]; then
        osascript -e "display notification \"✅ All $TOTAL_CHECKS checks passed\" with title \"WhaleTrack Bug Check\"" 2>/dev/null
    fi
    rm -f /Users/manpreetbrar/whaletrack/latest_issues.txt
fi
