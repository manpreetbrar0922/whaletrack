#!/usr/bin/env node
// WhaleTrack Twitter Alert Bot
// Auto-tweets Polymarket whale trades >= $10K
// No npm deps — pure Node.js with built-in crypto + https

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const BULLPEN = '/opt/homebrew/bin/bullpen';

// ── CONFIG ───────────────────────────────────────────────────────────
const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ Missing Twitter credentials.');
  console.error('   Set: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET');
  process.exit(1);
}

const TWEET_MIN      = parseInt(process.env.TWEET_MIN     || '15000');   // $15K
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL || '300000');  // 5 min
const DAILY_LIMIT    = parseInt(process.env.DAILY_LIMIT   || '50');      // max tweets/day (pay-per-use)
const COOLDOWN_MS    = 25 * 60 * 1000;                                   // 25 min between tweets
const SEEN_FILE      = process.env.SEEN_FILE || path.join(__dirname, 'twitter_seen_trades.json');
const COUNTER_FILE   = path.join(__dirname, 'twitter_daily_count.json');
const LAST_TWEET_FILE = path.join(__dirname, 'twitter_last_tweet.json');

// ── KNOWN WHALE NAMES ────────────────────────────────────────────────
const KNOWN_NAMES = {
  '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
  '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
  '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  '0x09b428f7c2b469786286214aa5c90dd9015f7320': 'DEEDDIT',
  '0x7c1ee865a785de4c00ee90ed86a38489fb8bbab3': 'CandleHammerDrums',
  '0x640de3430e9a05e1b1fe04b42d651da1abe99a4c': 'coldsway',
  '0x224a89dbe0db0d6124b335edabd15b3f877da3d5': 'wr0ngw4yb3tt0r',
  '0xe9a6ed2e4d4ee8ce47cd47cac834746dc4cf627b': 'Oneger',
  '0x83720820a8aa6c3f20ad71850e7a1a17d16c5223': 'Jsram',
  '0xc31d0a0d63d760d72a1236d16beaa6a71c854ebe': 'FootballFan98',
  '0xe72bb501df5306c75c89383d48a1e81073fbb0a0': 'norrisfan',
  '0xc6a63ad5a788a576d4acc9911c50fef9fde49458': 'filthybetz',
  '0x5e9458202b5817a72cf81105ec8a30e6f3705ba1': 'pleaseplease123',
  '0xa7b7505abe2fdcc497c00074534f7fbd7e07962e': 'gud.hl',
  '0xb809a4b78b5eadc71d84be43eda0491eedf72004': 'R88N',
  '0x56acab44cfca2e88bb9b3406890aea7bfa0cd77e': 'dv-pm',
  '0x412fe1a101554f0b382181c3af932e4b2d8030fa': 'GrizzliesSuck',
  '0xb61b2079b95f6b7476fd3203e0274ffb93308a06': 'hot2trot',
  '0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf': 'Sparkling8899',
  '0x50f0a0fc7364d3c10fc4578b9b1d955368335355': 'bettguy',
};

// ── PERSISTENCE ──────────────────────────────────────────────────────
let seenTrades = new Set();

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      seenTrades = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
  } catch (e) { seenTrades = new Set(); }
}

function saveSeen() {
  try {
    const arr = [...seenTrades].slice(-500);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
    seenTrades = new Set(arr);
  } catch (e) {}
}

// ── DAILY TWEET COUNTER ───────────────────────────────────────────────
function getDailyCount() {
  try {
    if (!fs.existsSync(COUNTER_FILE)) return { date: '', count: 0 };
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch (e) { return { date: '', count: 0 }; }
}

function incrementDailyCount() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = getDailyCount();
  const count = data.date === today ? data.count + 1 : 1;
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify({ date: today, count })); } catch (e) {}
  return count;
}

function canTweetToday() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = getDailyCount();
  if (data.date !== today) return true; // new day, reset
  return data.count < DAILY_LIMIT;
}

// ── COOLDOWN (25 min between tweets) ─────────────────────────────────
function getLastTweetTime() {
  try {
    if (!fs.existsSync(LAST_TWEET_FILE)) return 0;
    const d = JSON.parse(fs.readFileSync(LAST_TWEET_FILE, 'utf8'));
    return d.ts || 0;
  } catch (e) { return 0; }
}

function saveLastTweetTime() {
  try { fs.writeFileSync(LAST_TWEET_FILE, JSON.stringify({ ts: Date.now() })); } catch (e) {}
}

function canTweetNow() {
  const elapsed = Date.now() - getLastTweetTime();
  if (elapsed < COOLDOWN_MS) {
    const waitMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
    console.log(`  ⏳ Cooldown active — next tweet in ~${waitMin}min`);
    return false;
  }
  return true;
}

// ── HTTP HELPER ──────────────────────────────────────────────────────
function fetchJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WhaleTrack-Bot/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── OAUTH 1.0a SIGNING ────────────────────────────────────────────────
function pct(s) { return encodeURIComponent(String(s)); }

function buildOAuthHeader(method, url) {
  const oauthParams = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
  };

  // Signature: method + url + sorted oauth params
  // Note: JSON body is NOT included (only form params would be)
  const paramStr = Object.keys(oauthParams).sort()
    .map(k => `${pct(k)}=${pct(oauthParams[k])}`)
    .join('&');

  const base    = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const sigKey  = `${pct(API_SECRET)}&${pct(ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', sigKey).update(base).digest('base64');

  return 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${pct(k)}="${pct(oauthParams[k])}"`)
    .join(', ');
}

// ── POST TWEET ────────────────────────────────────────────────────────
function postTweet(text) {
  return new Promise((resolve, reject) => {
    const url  = 'https://api.twitter.com/2/tweets';
    const body = JSON.stringify({ text });
    const auth = buildOAuthHeader('POST', url);

    const req = https.request({
      hostname: 'api.twitter.com',
      path:     '/2/tweets',
      method:   'POST',
      headers: {
        'Authorization':  auth,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (res.statusCode === 201) resolve(result);
          else reject(new Error(`Twitter ${res.statusCode}: ${d}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── POLYMARKET FETCH ──────────────────────────────────────────────────
function addrShort(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '?'; }

function fmtUSD(n) {
  n = Math.abs(parseFloat(n));
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

// Cache whale PnL from leaderboard
const whalePnl = {};

async function fetchWhaleAddresses() {
  try {
    const data = await fetchJson('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    const addrs = (Array.isArray(data) ? data : [])
      .slice(0, 15)
      .map(t => {
        const addr = (t.proxyWallet || '').toLowerCase();
        if (addr && t.pnl) whalePnl[addr] = t.pnl;
        return addr;
      })
      .filter(Boolean);
    for (const addr of Object.keys(KNOWN_NAMES)) {
      if (!addrs.includes(addr.toLowerCase())) addrs.push(addr.toLowerCase());
    }
    return [...new Set(addrs)];
  } catch (e) {
    return Object.keys(KNOWN_NAMES);
  }
}

async function fetchActivity(address, limit = 5) {
  try {
    const data = await fetchJson(
      `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`
    );
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

// ── TWEET FORMAT ──────────────────────────────────────────────────────
// ── ORDER BOOK CONTEXT ────────────────────────────────────────────────
// Fetches live ask depth so followers know if they can still copy the bet
function getOrderBookContext(slug, outcome, whaleFillPrice) {
  if (!slug || slug.startsWith('0x')) return null;
  try {
    const raw = execSync(`${BULLPEN} polymarket orderbook ${slug} --output json`, {
      timeout: 12000, maxBuffer: 2 * 1024 * 1024
    });
    const data = JSON.parse(raw.toString());

    // For Yes bets we look at asks; for No bets we look at bids
    const side = outcome === 'No' ? (data.bids || []) : (data.asks || []);
    if (!side.length) return null;

    const bestPrice = side[0].price;
    // Sum liquidity within 3¢ of best price (what a follower could actually buy)
    const depth = side
      .filter(l => Math.abs(l.price - bestPrice) <= 0.03)
      .reduce((sum, l) => sum + l.size, 0);
    if (depth < 100) return null; // not enough to be useful

    const bestCents  = Math.round(bestPrice * 100);
    const fillCents  = Math.round(whaleFillPrice * 100);
    const depthStr   = depth >= 1000 ? `$${Math.round(depth / 1000)}K` : `$${Math.round(depth)}`;
    const priceMoved = bestCents - fillCents; // positive = price went up since whale filled

    if (priceMoved > 2) {
      // Price moved against followers — warn them
      return `💧 ${depthStr} left @ ${bestCents}¢ (whale got ${fillCents}¢ — moved +${priceMoved}¢)`;
    } else {
      return `💧 ${depthStr} still available @ ${bestCents}¢`;
    }
  } catch (e) {
    return null; // never block a tweet for this
  }
}

function buildTweet(t, obContext) {
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  const price = (t.price * 100).toFixed(0);

  // Twitter counts any URL as 23 chars — keep title short to fit
  const maxTitle = 60;
  const rawTitle = t.title || 'Unknown Market';
  // Clean up raw slug-style titles like "Will France win on 2026-07-09?"
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title = cleanTitle.length > maxTitle
    ? cleanTitle.slice(0, maxTitle - 1) + '…'
    : cleanTitle;

  // Tag @Polymarket on big trades only ($50K+) to avoid looking spammy
  const tags = t.usdcSize >= 50000
    ? `📋 Copy this bet → whaletrack.app | @Polymarket #Polymarket #PredictionMarkets`
    : `📋 Copy this bet → whaletrack.app | #Polymarket #PredictionMarkets`;

  // Show whale's total profit if available
  const addrKey = (t.proxyWallet || '').toLowerCase();
  const pnl = whalePnl[addrKey];
  const pnlStr = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)} on Polymarket)` : '';

  const lines = [
    `🐋 Whale Alert!`,
    ``,
    `${t.whaleName}${pnlStr} just bet ${fmtUSD(t.usdcSize)} on ${outcomeEmoji} ${t.outcome} @ ${price}¢`,
    ``,
    `📊 ${title}`,
  ];

  if (obContext) {
    lines.push(``);
    lines.push(obContext);
  }

  lines.push(``);
  lines.push(`Would you copy this bet? 👇`);
  lines.push(``);
  lines.push(tags);

  return lines.join('\n');
}

// ── WIN TWEET ─────────────────────────────────────────────────────────
function buildWinTweet(t) {
  const rawTitle = t.title || 'Unknown Market';
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title = cleanTitle.length > 60 ? cleanTitle.slice(0, 59) + '…' : cleanTitle;
  const addrKey = (t.proxyWallet || '').toLowerCase();
  const pnl = whalePnl[addrKey];
  const pnlStr = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)} total)` : '';
  return [
    `✅ Whale Win!`,
    ``,
    `${t.whaleName}${pnlStr} just collected ${fmtUSD(t.usdcSize)} on ${title}`,
    ``,
    `Think they'll bet big again? 👇`,
    ``,
    `📋 Copy their next bet → whaletrack.app | #Polymarket #PredictionMarkets`,
  ].join('\n');
}

// ── CYCLE TRACKER (alternate bet vs win tweets) ───────────────────────
const CYCLE_FILE = path.join(__dirname, 'twitter_cycle.json');
function getLastCycleType() {
  try {
    if (fs.existsSync(CYCLE_FILE)) return JSON.parse(fs.readFileSync(CYCLE_FILE, 'utf8')).last || 'win';
  } catch (e) {}
  return 'win'; // default so first cycle tweets a bet
}
function saveLastCycleType(type) {
  try { fs.writeFileSync(CYCLE_FILE, JSON.stringify({ last: type })); } catch (e) {}
}

// ── MAIN CHECK ────────────────────────────────────────────────────────
let cachedAddresses = [];

async function checkAndTweet() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Checking whale activity...`);

  try {
    const addrs = await fetchWhaleAddresses();
    if (addrs.length) cachedAddresses = addrs;
    const addresses = cachedAddresses.length ? cachedAddresses : Object.keys(KNOWN_NAMES);

    const results = await Promise.allSettled(addresses.map(a => fetchActivity(a, 10)));

    const bigTrades = [];
    const bigWins = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const addr = addresses[i];
      for (const t of results[i].value) {
        // Detect wins (REDEEM = collected winnings)
        if (t.type === 'REDEEM' && parseFloat(t.usdcSize || 0) >= 100000) {
          const tsMs = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
          if (Date.now() - tsMs <= 86400000) {
            const winKey = `win-${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
            if (!seenTrades.has(winKey)) {
              bigWins.push({
                key: winKey,
                whaleName: KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || t.name || 'Unknown Whale',
                usdcSize: parseFloat(t.usdcSize || 0),
                title: t.title || 'Unknown Market',
                proxyWallet: t.proxyWallet || addr,
                timestamp: t.timestamp || 0,
              });
            }
          }
        }
        if (t.side !== 'BUY') continue;
        if (parseFloat(t.usdcSize || 0) < TWEET_MIN) continue;
        // Skip resolved markets (price = 0 or 1)
        const tradePrice = parseFloat(t.price || 0);
        if (tradePrice <= 0.02 || tradePrice >= 0.98) continue;
        // Skip trades older than 2 hours — prevents stale alerts on restart
        const tsMs = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
        if (Date.now() - tsMs > 7200000) continue;
        const key = `${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
        // Deduplicate by whale + market (ignore multiple trades same whale same market)
        const marketKey = `market-${(t.proxyWallet || addr).toLowerCase()}-${t.slug || t.title || ''}`;
        if (seenTrades.has(key) || seenTrades.has(marketKey)) continue;
        bigTrades.push({
          key,
          whaleName: KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || (t.name && !t.name.startsWith('0x') ? t.name : null) || t.pseudonym || (t.proxyWallet ? 'Whale ' + t.proxyWallet.slice(0,6) : 'Unknown Whale'),
          outcome:   t.outcome  || '—',
          usdcSize:  parseFloat(t.usdcSize || 0),
          price:     parseFloat(t.price    || 0),
          title:     t.title    || 'Unknown Market',
          slug:      t.slug     || '',
          timestamp: t.timestamp || 0,
        });
      }
    }

    bigTrades.sort((a, b) => b.timestamp - a.timestamp);
    // Deduplicate within this cycle by market key (same whale, same market)
    const seenThisCycle = new Set();
    const deduped = bigTrades.filter(t => {
      const mk = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
      if (seenThisCycle.has(mk)) return false;
      seenThisCycle.add(mk);
      return true;
    });
    const toTweet = deduped.slice(0, 3); // max 3 per cycle to avoid rate limits

    // Alternate bet and win tweets each cycle
    const lastCycle = getLastCycleType();
    const doWinThisCycle = lastCycle === 'bet';

    if (!canTweetToday()) {
      console.log(`  ⚠️ Daily limit (${DAILY_LIMIT}) reached — skipping until tomorrow.`);
    } else if (!canTweetNow()) {
      // cooldown message already logged inside canTweetNow()
    } else if (doWinThisCycle) {
      // WIN cycle — tweet 1 win
      bigWins.sort((a, b) => b.timestamp - a.timestamp);
      const w = bigWins[0];
      if (w) {
        const text = buildWinTweet(w);
        console.log(`  → Win Tweet: ${w.whaleName} ${fmtUSD(w.usdcSize)} | ${text.length} chars`);
        try {
          const result = await postTweet(text);
          const tweetId = result?.data?.id;
          const todayCount = incrementDailyCount();
          console.log(`  ✅ Win: https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
          seenTrades.add(w.key);
          saveSeen();
          saveLastCycleType('win');
          saveLastTweetTime();
        } catch (e) {
          console.error(`  ❌ Win tweet failed: ${e.message}`);
        }
      } else {
        console.log(`  No new $100K+ wins — falling back to bet tweet.`);
        // Fall back to bet if no wins available
        const t = toTweet[0];
        if (t) {
          const obContext = getOrderBookContext(t.slug, t.outcome, t.price);
          const text = buildTweet(t, obContext);
          console.log(`  → Bet Tweet: ${t.whaleName} ${fmtUSD(t.usdcSize)} | ${text.length} chars`);
          try {
            const result = await postTweet(text);
            const tweetId = result?.data?.id;
            const todayCount = incrementDailyCount();
            console.log(`  ✅ https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
            seenTrades.add(t.key);
            const marketKey = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
            seenTrades.add(marketKey);
            saveSeen();
            saveLastCycleType('bet');
            saveLastTweetTime();
          } catch (e) {
            console.error(`  ❌ Failed: ${e.message}`);
          }
        } else {
          console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found either.`);
        }
      }
    } else {
      // BET cycle — tweet 1 bet
      const t = toTweet[0];
      if (t) {
        const obContext = getOrderBookContext(t.slug, t.outcome, t.price);
        const text = buildTweet(t, obContext);
        console.log(`  → Bet Tweet: ${t.whaleName} ${fmtUSD(t.usdcSize)} | ${text.length} chars`);
        try {
          const result = await postTweet(text);
          const tweetId = result?.data?.id;
          const todayCount = incrementDailyCount();
          console.log(`  ✅ https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
          seenTrades.add(t.key);
          const marketKey = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
          seenTrades.add(marketKey);
          saveSeen();
          saveLastCycleType('bet');
          saveLastTweetTime();
        } catch (e) {
          console.error(`  ❌ Failed: ${e.message}`);
        }
      } else {
        console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found.`);
      }
    }
  } catch (e) {
    console.error(`[Error] ${e.message}`);
  }
}

// ── START (one-shot, runs via cron every 5 min) ───────────────────────
loadSeen();
checkAndTweet();
