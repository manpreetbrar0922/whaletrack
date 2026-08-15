#!/usr/bin/env node
// WhaleTrack Twitter Alert Bot
// Auto-tweets Polymarket whale trades >= $10K
// No npm deps — pure Node.js with built-in crypto + https

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync, spawn } = require('child_process');

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

const TWEET_MIN           = parseInt(process.env.TWEET_MIN        || '15000');  // $15K
const POLL_INTERVAL       = parseInt(process.env.POLL_INTERVAL     || '60000');  // 60s continuous
const DAILY_LIMIT         = parseInt(process.env.DAILY_LIMIT       || '50');     // max tweets/day
const SKIP_CARDS          = process.env.SKIP_CARDS === 'true';                   // set true on free API tier (no media upload)
const COOLDOWN_MS         = 25 * 60 * 1000;                                      // 25 min between tweets
const SPORTS_COOLDOWN_MS  =  3 * 60 * 1000;                                      // 3 min for sports (fast markets)
const TELEGRAM_DELAY_MS   = parseInt(process.env.TELEGRAM_DELAY_MS || '600000'); // 10 min Telegram → Twitter gap
const SEEN_FILE           = process.env.SEEN_FILE || path.join(__dirname, 'twitter_seen_trades.json');
const COUNTER_FILE        = path.join(__dirname, 'twitter_daily_count.json');
const LAST_TWEET_FILE     = path.join(__dirname, 'twitter_last_tweet.json');
const HOT_BETS_FILE       = path.join(__dirname, 'hot_bets.json');
const HOT_BETS_MAX        = 50;   // keep last 50 bets
const HOT_BETS_TTL        = 48;   // hours to keep a bet in the list
const DAILY_RECAP_FILE      = path.join(__dirname, 'daily_recap_sent.json');
const DAILY_RECAP_HOUR_UTC  = 15;  // 9am MDT = 15:00 UTC
const TRENDING_INTERVAL_MS  = 15 * 60 * 1000;  // check every 15 min
const TRENDING_FILE         = path.join(__dirname, 'trending_tweeted.json');
const TRENDING_MAX_PER_DAY  = 3;    // max 3 trending tweets per day
let   trendingLastCheck     = 0;

// ── TELEGRAM CONFIG ──────────────────────────────────────────────────
const BOT_TOKEN          = process.env.BOT_TOKEN          || '';
const PREMIUM_CHANNEL_ID = process.env.PREMIUM_CHANNEL_ID || '';
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID      || '';

// ── WEBHOOK CUSTOMERS ────────────────────────────────────────────────
// Each customer: { name, url, minSize, markets: ['crypto'|'sports'|'all'] }
// Add new B2B customers here — or load from WEBHOOK_CUSTOMERS_FILE
const WEBHOOK_CUSTOMERS_FILE = path.join(__dirname, 'webhook_customers.json');
function loadWebhookCustomers() {
  try {
    if (fs.existsSync(WEBHOOK_CUSTOMERS_FILE)) {
      return JSON.parse(fs.readFileSync(WEBHOOK_CUSTOMERS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

const CRYPTO_TERMS = ['bitcoin','btc','ethereum','eth','solana','sol','xrp','ripple',
  'dogecoin','doge','bnb','binance','hype','hyperliquid','crypto','blockchain',
  'defi','altcoin','cardano','ada','avalanche','avax','polkadot','dot',
  'chainlink','link','uniswap','aave','sui','aptos','ton','pepe','shib'];

function isCryptoMarket(title) {
  const t = (title || '').toLowerCase();
  return CRYPTO_TERMS.some(k => t.includes(k));
}

function matchesCustomerFilter(t, customer) {
  const markets = customer.markets || ['all'];
  if (markets.includes('all')) return true;
  if (markets.includes('crypto') && isCryptoMarket(t.title)) return true;
  if (markets.includes('sports') && isSportsTrade(t.title)) return true;
  return false;
}

function postWebhook(customer, payload) {
  if (!customer.url) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const body   = JSON.stringify(payload);
      const urlObj = new URL(customer.url);
      const opts   = {
        hostname: urlObj.hostname,
        port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-WhaleTrack-Key': customer.apiKey || '',
        },
      };
      const mod = urlObj.protocol === 'https:' ? https : require('http');
      const req = mod.request(opts, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          console.log(`  🔗 Webhook → ${customer.name} [${res.statusCode}]`);
          resolve();
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.on('error', (e) => {
        console.log(`  ⚠️ Webhook → ${customer.name} failed: ${e.message}`);
        resolve();
      });
      req.write(body);
      req.end();
    } catch (e) {
      console.log(`  ⚠️ Webhook → ${customer.name} error: ${e.message}`);
      resolve();
    }
  });
}

async function fireWebhooks(trades) {
  const customers = loadWebhookCustomers();
  if (!customers.length) return;

  for (const t of trades) {
    const webhookKey = `webhook-${t.key}`;
    if (seenTrades.has(webhookKey)) continue;
    seenTrades.add(webhookKey);

    const payload = {
      event:     'whale_bet',
      whale:     t.whaleName,
      market:    t.title,
      outcome:   t.outcome,
      size_usd:  Math.round(t.usdcSize),
      price:     parseFloat(t.price.toFixed(4)),
      price_pct: Math.round(t.price * 100),
      timestamp: t.timestamp,
      slug:      t.slug || null,
      source:    'whaletrack.app',
    };

    for (const customer of customers) {
      const minSize = customer.minSize || 10000;
      if (t.usdcSize < minSize) continue;
      if (!matchesCustomerFilter(t, customer)) continue;
      postWebhook(customer, payload).catch(() => {});
    }
  }
}

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

// ── WHALE NAME FORMATTER ─────────────────────────────────────────────
function formatWhaleName(name, addr) {
  // If it's a raw address or address-with-timestamp, truncate nicely
  const rawAddr = addr || '';
  if (!name || name.startsWith('0x') || name.match(/^0x[a-fA-F0-9]+-\d+$/)) {
    const clean = rawAddr.replace(/-\d+$/, ''); // strip timestamp suffix
    return clean.length > 10
      ? clean.slice(0, 6) + '…' + clean.slice(-4)
      : 'Unknown Whale';
  }
  return name;
}

// ── BOT START TIME — only tweet trades that arrive AFTER this restart ──
const BOT_START_MS = Date.now();

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

function isSportsTrade(title) {
  const t = (title || '').toLowerCase();
  return ['ufc', 'mma', 'boxing', 'nba', 'nfl', 'nhl', 'mlb', 'tennis', 'soccer',
    'football', 'cricket', 'golf', 'wimbledon', 'f1', 'grand prix', 'formula 1',
    'super bowl', 'world cup', 'champions league', 'premier league', 'match',
    'game', 'championship', 'open', 'tournament', 'series'].some(k => t.includes(k));
}

function isPoliticsTrade(title) {
  const t = (title || '').toLowerCase();
  return ['election', 'president', 'senate', 'congress', 'republican', 'democrat',
    'trump', 'biden', 'harris', 'vance', 'fed rate', 'rate cut', 'rate hike',
    'federal reserve', 'fomc', 'supreme court', 'white house', 'nato', 'ukraine',
    'tariff', 'sanctions', 'governor', 'prime minister', 'chancellor',
    '2026 election', '2028 election'].some(k => t.includes(k));
}

function isCryptoTrade(title) {
  const t = (title || '').toLowerCase();
  if (['bitcoin', 'ethereum', 'solana', 'dogecoin', 'crypto', 'blockchain',
    'coinbase', 'binance', 'altcoin', 'halving', 'hyperliquid'].some(k => t.includes(k))) return true;
  return ['btc', 'eth', 'sol', 'xrp', 'bnb', 'doge'].some(k => new RegExp(`\\b${k}\\b`).test(t));
}

function getPageUrl(title) {
  if (isSportsTrade(title))   return 'whaletrack.app/sports';
  if (isPoliticsTrade(title)) return 'whaletrack.app/politics';
  if (isCryptoTrade(title))   return 'whaletrack.app/crypto';
  return 'whaletrack.app';
}

function canTweetNow(title = '') {
  const elapsed  = Date.now() - getLastTweetTime();
  const sports   = isSportsTrade(title);
  const cooldown = sports ? SPORTS_COOLDOWN_MS : COOLDOWN_MS;
  if (elapsed < cooldown) {
    const waitMin = Math.ceil((cooldown - elapsed) / 60000);
    console.log(`  ⏳ Cooldown active — next tweet in ~${waitMin}min${sports ? ' (sports priority)' : ''}`);
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

// ── HOT BETS FILE WRITER ─────────────────────────────────────────────
function saveHotBet(t) {
  try {
    let bets = [];
    if (fs.existsSync(HOT_BETS_FILE)) {
      bets = JSON.parse(fs.readFileSync(HOT_BETS_FILE, 'utf8'));
    }
    // Remove old bets beyond TTL
    const cutoff = Date.now() / 1000 - HOT_BETS_TTL * 3600;
    bets = bets.filter(b => b.timestamp >= cutoff);
    // Add new bet at top
    bets.unshift({
      id:        t.id || t.conditionId || `${t.whaleName}-${Date.now()}`,
      whaleName: t.whaleName,
      title:     t.title,
      outcome:   t.outcome,
      usdcSize:  t.usdcSize,
      price:     t.price,
      slug:      t.slug || t.eventSlug || '',
      timestamp: Math.floor(Date.now() / 1000),
    });
    // Keep only most recent HOT_BETS_MAX
    bets = bets.slice(0, HOT_BETS_MAX);
    fs.writeFileSync(HOT_BETS_FILE, JSON.stringify(bets, null, 2));
  } catch (e) { /* never block a tweet on file write failure */ }
}

// ── TELEGRAM SENDER ──────────────────────────────────────────────────
function sendTelegram(chatId, text) {
  if (!BOT_TOKEN || !chatId) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve()); });
    req.on('error', () => resolve()); // never block a tweet on Telegram failure
    req.write(body);
    req.end();
  });
}

function buildTelegramAlert(t, type = 'bet') {
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  const price        = Math.round((t.price || 0) * 100);
  const addrKey      = (t.proxyWallet || '').toLowerCase();
  const pnl          = whalePnl[addrKey];
  const pnlStr       = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)})` : '';
  const title        = (t.title || 'Unknown Market').slice(0, 80);

  if (type === 'exit') {
    return [
      `🚨 <b>Whale Exit — ${t.whaleName}${pnlStr}</b>`,
      ``,
      `Just SOLD their position @ ${price}¢`,
      ``,
      `📊 <i>${title}</i>`,
      ``,
      `⚠️ If you copied this bet — watch your position.`,
      `🐋 <a href="https://whaletrack.app">whaletrack.app</a>`,
    ].join('\n');
  }

  if (type === 'win') {
    return [
      `✅ <b>Whale Win — ${t.whaleName}${pnlStr}</b>`,
      ``,
      `Just collected <b>${fmtUSD(t.usdcSize)}</b>`,
      ``,
      `📊 <i>${title}</i>`,
      ``,
      `🐋 <a href="https://whaletrack.app">Copy their next bet → whaletrack.app</a>`,
    ].join('\n');
  }

  // default: bet
  return [
    `⚡ <b>Whale Alert — ${t.whaleName}${pnlStr}</b>`,
    ``,
    `${outcomeEmoji} <b>${t.outcome}</b> ${fmtUSD(t.usdcSize)} @ ${price}¢`,
    ``,
    `📊 <i>${title}</i>`,
    ``,
    `🐋 <a href="https://whaletrack.app">Copy this bet → whaletrack.app</a>`,
    `⏱ <i>Twitter alert in 10 min — you're early 🐋</i>`,
  ].join('\n');
}

async function sendTelegramAlerts(t, type = 'bet') {
  if (!BOT_TOKEN) return;
  const msg = buildTelegramAlert(t, type);
  const sends = [];
  if (PREMIUM_CHANNEL_ID) sends.push(sendTelegram(PREMIUM_CHANNEL_ID, msg));
  if (ADMIN_CHAT_ID)      sends.push(sendTelegram(ADMIN_CHAT_ID, msg));
  await Promise.allSettled(sends);
  console.log(`  📱 Telegram sent → channel${ADMIN_CHAT_ID ? ' + admin' : ''}`);
}

// ── OAUTH 1.0a SIGNING ────────────────────────────────────────────────
function pct(s) { return encodeURIComponent(String(s)); }

// extraParams: additional body/query params to include in signature (for form-encoded requests)
function buildOAuthHeader(method, url, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
  };

  // Merge all signable params (OAuth + form body) before building signature
  const allParams = { ...oauthParams, ...extraParams };
  const paramStr = Object.keys(allParams).sort()
    .map(k => `${pct(k)}=${pct(allParams[k])}`)
    .join('&');

  const base    = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const sigKey  = `${pct(API_SECRET)}&${pct(ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', sigKey).update(base).digest('base64');

  return 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${pct(k)}="${pct(oauthParams[k])}"`)
    .join(', ');
}

// ── TWITTER MEDIA UPLOAD ──────────────────────────────────────────────
async function uploadMedia(imgPath) {
  const mediaData = fs.readFileSync(imgPath).toString('base64');
  const url       = 'https://upload.twitter.com/1.1/media/upload.json';
  const auth      = buildOAuthHeader('POST', url, { media_data: mediaData });
  const bodyStr   = `media_data=${pct(mediaData)}`;
  const bodyBuf   = Buffer.from(bodyStr);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'upload.twitter.com',
      path:     '/1.1/media/upload.json',
      method:   'POST',
      headers: {
        'Authorization':  auth,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (result.media_id_string) resolve(result.media_id_string);
          else reject(new Error(`Media upload ${res.statusCode}: ${d}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── CARD GENERATION LOCK (prevents concurrent Puppeteer instances crashing each other) ──
let _cardLock = false;
const _cardQueue = [];

function withCardLock(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _cardLock = true;
      fn().then(res => {
        resolve(res);
        _cardLock = false;
        if (_cardQueue.length) _cardQueue.shift()();
      }).catch(err => {
        reject(err);
        _cardLock = false;
        if (_cardQueue.length) _cardQueue.shift()();
      });
    };
    if (_cardLock) {
      _cardQueue.push(run);
    } else {
      run();
    }
  });
}

// ── GENERATE + UPLOAD CARD (never blocks a tweet on failure) ─────────
// Spawns card-generator.cjs as a child process so Puppeteer gets its own CPU/memory
function generateCardInChildProcess(tradeData) {
  return new Promise((resolve, reject) => {
    const imgPath = path.join(require('os').tmpdir(), `wt_card_${Date.now()}.png`);
    const child = spawn(process.execPath, [
      path.join(__dirname, 'card-generator.cjs'),
      '--generate',
      JSON.stringify(tradeData),
      imgPath,
    ], { timeout: 120000 });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code === 0 && fs.existsSync(imgPath)) {
        resolve(imgPath);
      } else {
        reject(new Error(stderr.trim() || `card-generator exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function getCardMediaId(tradeData) {
  if (SKIP_CARDS) return null;  // free API tier — skip media upload entirely
  try {
    const imgPath = await withCardLock(() => generateCardInChildProcess(tradeData));
    const mediaId = await uploadMedia(imgPath);
    try { fs.unlinkSync(imgPath); } catch (_) {}
    return mediaId;
  } catch (e) {
    console.log(`  ⚠️ Card skipped (tweeting text-only): ${e.message}`);
    return null;
  }
}

// ── POST TWEET ────────────────────────────────────────────────────────
function postTweet(text, mediaId = null) {
  return new Promise((resolve, reject) => {
    const url     = 'https://api.twitter.com/2/tweets';
    const payload = { text };
    if (mediaId) payload.media = { media_ids: [mediaId] };
    const body = JSON.stringify(payload);
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

// ── TWEET A BET (shared helper used in both BET and fallback paths) ──
async function tweetBet(t, label = 'Bet') {
  // ── Claim this slot immediately: mark seen + lock cooldown ──
  // This prevents concurrent poll cycles from queuing another tweet during the 10-min hold.
  const marketKey = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
  seenTrades.add(t.key);
  seenTrades.add(marketKey);
  saveSeen();
  saveLastTweetTime(); // reserves the cooldown window right now

  // 1. Save to hot bets feed + Telegram FIRST
  saveHotBet(t);
  await sendTelegramAlerts(t, 'bet');

  // 2. Wait before going public on Twitter
  if (TELEGRAM_DELAY_MS > 0) {
    console.log(`  ⏳ Holding 10min for Telegram subscribers before Twitter...`);
    await new Promise(r => setTimeout(r, TELEGRAM_DELAY_MS));
  }

  const obContext = getOrderBookContext(t.slug, t.outcome, t.price);
  const text      = buildTweet(t, obContext);

  // Generate visual card
  const mediaId = await getCardMediaId({
    title:     t.title,
    outcome:   t.outcome,
    amount:    fmtUSD(t.usdcSize),
    price:     t.price,
    whaleName: t.whaleName,
  });

  console.log(`  → ${label} Tweet${mediaId ? ' 🖼️' : ''}: ${t.whaleName} ${fmtUSD(t.usdcSize)} | ${text.length} chars`);
  const result   = await postTweet(text, mediaId);
  const tweetId  = result?.data?.id;
  const todayCount = incrementDailyCount();
  console.log(`  ✅ https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
  saveLastCycleType('bet');
  saveLastTweetTime();
}

// ── TWEET A WIN ──────────────────────────────────────────────────────
async function tweetWin(w) {
  // Claim slot immediately — mark seen + lock cooldown
  seenTrades.add(w.key);
  saveSeen();
  saveLastTweetTime();

  await sendTelegramAlerts(w, 'win');
  if (TELEGRAM_DELAY_MS > 0) await new Promise(r => setTimeout(r, TELEGRAM_DELAY_MS));
  const text = buildWinTweet(w);

  // Win card — use WHALE category (no outcome/price for wins)
  const mediaId = await getCardMediaId({
    title:     w.title,
    outcome:   'Yes',
    amount:    fmtUSD(w.usdcSize),
    price:     0.99,
    whaleName: w.whaleName,
  });

  console.log(`  → Win Tweet${mediaId ? ' 🖼️' : ''}: ${w.whaleName} ${fmtUSD(w.usdcSize)} | ${text.length} chars`);
  const result   = await postTweet(text, mediaId);
  const tweetId  = result?.data?.id;
  const todayCount = incrementDailyCount();
  console.log(`  ✅ Win: https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
  saveLastCycleType('win');
  saveLastTweetTime();
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

// ── SMART HASHTAG BUILDER ─────────────────────────────────────────────
function buildHashtags(title) {
  const t = title.toLowerCase();
  const tags = [];

  // ── UFC / MMA / Boxing ──
  const isUFC = t.includes('ufc') || t.includes(' mma') || t.includes('boxing');
  if (isUFC) {
    tags.push('#UFC', '#MMA');
    const ufcNum = title.match(/UFC\s*(\d+)/i);
    if (ufcNum) tags.push(`#UFC${ufcNum[1]}`);
    const fighters = {
      'jones':       '#JonJones',    'miocic':      '#StipeMiocic',
      'adesanya':    '#Adesanya',    'makhachev':   '#Makhachev',
      'poirier':     '#DustinPoirier','mcgregor':   '#McGregor',
      'conor':       '#McGregor',    'pereira':     '#AlexPereira',
      'topuria':     '#Topuria',     'volkanovski': '#Volkanovski',
      'usman':       '#KamaruUsman', 'aspinall':    '#TomAspinall',
      'holloway':    '#MaxHolloway', 'strickland':  '#Strickland',
      'oliveira':    '#Oliveira',    'gaethje':     '#Gaethje',
      'khabib':      '#Khabib',      'du plessis':  '#DricusDuPlessis',
      'chimaev':     '#Chimaev',     'diaz':        '#NateDiaz',
      'omalley':     '#SeanOMalley', 'shevchenko':  '#Shevchenko',
    };
    for (const [key, tag] of Object.entries(fighters)) {
      if (t.includes(key) && !tags.includes(tag)) tags.push(tag);
    }
    return tags.slice(0, 5);
  }

  // ── NBA / Basketball ──
  const isNBA = t.includes('nba') || t.includes('basketball') ||
    ['lakers','warriors','celtics','nuggets','bucks','heat','suns','sixers','76ers',
     'knicks','thunder','mavericks','mavs','grizzlies','timberwolves','spurs',
     'pelicans','hawks','clippers','cavaliers','cavs','kings','magic','pacers',
     'hornets','pistons','rockets','jazz','raptors','nets'].some(k => t.includes(k));
  if (isNBA) {
    tags.push('#NBA');
    const teams = {
      'lakers':       ['#Lakers',       '#LeBronJames'    ],
      'warriors':     ['#Warriors',     '#StephCurry'     ],
      'celtics':      ['#Celtics',      '#JaysonTatum'    ],
      'nuggets':      ['#Nuggets',      '#Jokic'          ],
      'bucks':        ['#Bucks',        '#Giannis'        ],
      'heat':         ['#Heat',         '#JimmyButler'    ],
      'suns':         ['#Suns',         '#KD'             ],
      '76ers':        ['#Sixers',       '#Embiid'         ],
      'sixers':       ['#Sixers',       '#Embiid'         ],
      'knicks':       ['#Knicks',       '#Brunson'        ],
      'thunder':      ['#Thunder',      '#SGA'            ],
      'mavericks':    ['#Mavs',         '#Luka'           ],
      'mavs':         ['#Mavs',         '#Luka'           ],
      'grizzlies':    ['#Grizzlies',    '#JaMorant'       ],
      'timberwolves': ['#Wolves',       '#AnthonyEdwards' ],
      'spurs':        ['#Spurs',        '#Wembanyama'     ],
      'pelicans':     ['#Pelicans',     '#Zion'           ],
      'hawks':        ['#Hawks',        '#TraeYoung'      ],
      'clippers':     ['#Clippers',     '#KawhiLeonard'   ],
      'cavaliers':    ['#Cavs',         '#DonovanMitchell'],
      'cavs':         ['#Cavs',         '#DonovanMitchell'],
      'kings':        ['#Kings',        '#DeAaronFox'     ],
      'magic':        ['#Magic',        '#Banchero'       ],
      'pacers':       ['#Pacers',       '#Haliburton'     ],
      'hornets':      ['#Hornets',      '#LaMelo'         ],
      'rockets':      ['#Rockets',      '#Sengun'         ],
      'raptors':      ['#Raptors',      '#ScottieBarnes'  ],
    };
    for (const [team, teamTags] of Object.entries(teams)) {
      if (t.includes(team)) { tags.push(...teamTags); break; }
    }
    // Second team for matchups
    let found = 0;
    for (const [team, teamTags] of Object.entries(teams)) {
      if (t.includes(team)) { found++; if (found === 2) { tags.push(teamTags[0]); break; } }
    }
    if (t.includes('finals'))    tags.push('#NBAFinals');
    if (t.includes('playoff'))   tags.push('#NBAPlayoffs');
    if (t.includes('mvp'))       tags.push('#MVP');
    if (t.includes('champion'))  tags.push('#NBAChampionship');
    return tags.slice(0, 5);
  }

  // ── NFL / American Football ──
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('chiefs') || t.includes('football')) {
    tags.push('#NFL');
    if (t.includes('super bowl')) tags.push('#SuperBowl');
    if (t.includes('chiefs'))     tags.push('#Chiefs', '#PatrickMahomes');
    if (t.includes('49ers'))      tags.push('#49ers');
    if (t.includes('eagles'))     tags.push('#Eagles');
    if (t.includes('ravens'))     tags.push('#Ravens', '#LamarJackson');
    return tags.slice(0, 4);
  }

  // ── Soccer / Football ──
  if (t.includes('world cup') || t.includes('champions league') || t.includes('premier league') ||
      t.includes('real madrid') || t.includes('barcelona') || t.includes('arsenal') ||
      t.includes('manchester') || t.includes('soccer')) {
    tags.push('#Soccer', '#Football');
    if (t.includes('world cup'))        tags.push('#WorldCup');
    if (t.includes('champions league')) tags.push('#UCL', '#ChampionsLeague');
    if (t.includes('premier league'))   tags.push('#PremierLeague');
    if (t.includes('real madrid'))      tags.push('#RealMadrid');
    if (t.includes('barcelona'))        tags.push('#Barcelona');
    if (t.includes('arsenal'))          tags.push('#Arsenal');
    if (t.includes('manchester city'))  tags.push('#ManCity');
    if (t.includes('manchester united'))tags.push('#MUFC');
    return tags.slice(0, 4);
  }

  // ── F1 ──
  if (t.includes(' f1') || t.includes('formula 1') || t.includes('grand prix')) {
    tags.push('#F1', '#Formula1');
    if (t.includes('verstappen')) tags.push('#Verstappen');
    if (t.includes('hamilton'))   tags.push('#Hamilton');
    if (t.includes('norris'))     tags.push('#Norris');
    return tags.slice(0, 4);
  }

  // ── Politics ──
  const isPolitics = ['president', 'election', 'trump', 'biden', 'harris', 'congress',
    'senate', 'vote', 'republican', 'democrat', 'modi', 'macron', 'putin', 'zelensky',
    'political', 'governor', 'party'].some(k => t.includes(k));
  if (isPolitics) {
    tags.push('#Politics', '#Polymarket');
    if (t.includes('trump'))       { tags.push('#Trump', '#Republican'); }
    else if (t.includes('biden'))  { tags.push('#Biden', '#Democrat'); }
    else if (t.includes('harris')) { tags.push('#KamalaHarris', '#Democrat'); }
    else if (t.includes('modi'))   { tags.push('#Modi', '#India', '#BJP'); }
    else if (t.includes('macron')) { tags.push('#Macron', '#France'); }
    else if (t.includes('putin'))  { tags.push('#Putin', '#Russia'); }
    else if (t.includes('zelensky')) { tags.push('#Zelensky', '#Ukraine'); }
    else { tags.push('#Election', '#Politics'); }
    if (t.includes('election'))    tags.push('#Election2028');
    if (t.includes('republican'))  tags.push('#Republican');
    if (t.includes('democrat'))    tags.push('#Democrat');
    return tags.slice(0, 5);
  }

  // ── Crypto ──
  const isCrypto = ['bitcoin','btc','ethereum','eth','solana','sol','crypto','xrp',
    'doge','bnb','matic','avax','blockchain','defi','nft'].some(k => t.includes(k));
  if (isCrypto) {
    tags.push('#Crypto');
    if (t.includes('bitcoin')  || t.includes('btc'))     tags.push('#Bitcoin', '#BTC');
    if (t.includes('ethereum') || t.includes('eth'))     tags.push('#Ethereum', '#ETH');
    if (t.includes('solana')   || t.includes('sol'))     tags.push('#Solana', '#SOL');
    if (t.includes('xrp'))                               tags.push('#XRP');
    if (t.includes('doge'))                              tags.push('#Dogecoin', '#DOGE');
    if (t.includes('bnb'))                               tags.push('#BNB');
    if (t.includes('defi'))                              tags.push('#DeFi');
    if (t.includes('nft'))                               tags.push('#NFT');
    if (t.includes('all-time high') || t.includes('ath'))tags.push('#ATH');
    return tags.slice(0, 5);
  }

  return []; // default — no extra tags for generic markets
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

    if (priceMoved >= 1) {
      // Price moved — show the market impact hook
      return `💧 ${depthStr} left @ ${bestCents}¢ (whale got ${fillCents}¢ — moved +${priceMoved}¢)`;
    } else if (priceMoved < 0) {
      // Price dipped since whale filled — good entry for followers
      return `💧 ${depthStr} available @ ${bestCents}¢ (whale got ${fillCents}¢ — price dipped ${Math.abs(priceMoved)}¢ 👀)`;
    } else {
      return `💧 ${depthStr} still available @ ${bestCents}¢`;
    }
  } catch (e) {
    return null; // never block a tweet for this
  }
}

// Count Twitter weighted chars: URLs = 23, everything else = JS .length
function twitterLen(text) {
  const urlRe = /https?:\/\/[^\s]+|(?:^|\s)([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z]{2,})+\/\S*)/g;
  let len = text.length;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const url = m[0].trimStart();
    len -= url.length;
    len += 23; // Twitter t.co length
  }
  return len;
}

function buildTweet(t, obContext) {
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  const price = (t.price * 100).toFixed(0);

  // Twitter counts any URL as 23 chars — keep title short to guarantee fit
  const maxTitle = 42;
  const rawTitle = t.title || 'Unknown Market';
  // Clean up raw slug-style titles like "Will France win on 2026-07-09?"
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title = cleanTitle.length > maxTitle
    ? cleanTitle.slice(0, maxTitle - 1) + '…'
    : cleanTitle;

  // Smart hashtags — cap at 2 extra to save space
  const extraTags  = buildHashtags(rawTitle).slice(0, 2);
  const baseTag    = t.usdcSize >= 50000 ? '@Polymarket #Polymarket' : '#Polymarket';
  const allTags    = [baseTag, ...extraTags].join(' ');
  const refLink    = `https://whaletrack.app/go`;

  // Show whale's total profit if available
  const addrKey = (t.proxyWallet || '').toLowerCase();
  const pnl = whalePnl[addrKey];
  const pnlStr = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)})` : '';

  const lines = [
    `🐋 Whale Alert!`,
    ``,
    `${t.whaleName}${pnlStr} just bet ${fmtUSD(t.usdcSize)} on ${outcomeEmoji} ${t.outcome} @ ${price}¢`,
    ``,
    `📊 ${title}`,
  ];

  // Add order book context if short enough
  if (obContext) {
    const shortOb = obContext.length > 42 ? obContext.slice(0, 41) + '…' : obContext;
    lines.push(``);
    lines.push(shortOb);
  }

  // Referral link + CTA — always fits because both URLs count as 23 chars each
  lines.push(``);
  lines.push(`Copy this bet → ${refLink}`);
  lines.push(`⚡ whaletrack.app/premium | ${allTags}`);

  const text = lines.join('\n');
  // Safety check — log a warning if somehow still over limit
  const wLen = twitterLen(text);
  if (wLen > 275) console.warn(`  ⚠️ Tweet may be over limit: ~${wLen} chars`);

  return text;
}

// ── EXIT TWEET (whale sold/exited a position) ─────────────────────────
function buildExitTweet(t) {
  const rawTitle   = t.title || 'Unknown Market';
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title      = cleanTitle.length > 42 ? cleanTitle.slice(0, 41) + '…' : cleanTitle;
  const extraTags  = buildHashtags(rawTitle).slice(0, 2);
  const allTags    = ['#Polymarket', ...extraTags].join(' ');
  const addrKey    = (t.proxyWallet || '').toLowerCase();
  const pnl        = whalePnl[addrKey];
  const pnlStr     = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)})` : '';
  const price      = Math.round((t.price || 0) * 100);
  const refLink    = `https://whaletrack.app/go`;
  return [
    `🚨 Whale Exit Alert!`,
    ``,
    `${t.whaleName}${pnlStr} just SOLD @ ${price}¢`,
    ``,
    `📊 ${title}`,
    ``,
    `⚠️ Watch your position if you copied this!`,
    ``,
    `Track next bet → ${refLink}`,
    `⚡ whaletrack.app/premium | ${allTags}`,
  ].join('\n');
}

// ── WIN TWEET ─────────────────────────────────────────────────────────
function buildWinTweet(t) {
  const rawTitle = t.title || 'Unknown Market';
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title = cleanTitle.length > 42 ? cleanTitle.slice(0, 41) + '…' : cleanTitle;
  const addrKey = (t.proxyWallet || '').toLowerCase();
  const pnl = whalePnl[addrKey];
  const pnlStr = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)} total)` : '';
  const extraTags = buildHashtags(rawTitle).slice(0, 2);
  const allTags   = ['#Polymarket', ...extraTags].join(' ');
  const refLink   = `https://whaletrack.app/go`;
  return [
    `✅ Whale Win!`,
    ``,
    `${t.whaleName}${pnlStr} just collected ${fmtUSD(t.usdcSize)}`,
    `📊 ${title}`,
    ``,
    `Copy their next bet → ${refLink}`,
    `⚡ whaletrack.app/premium | ${allTags}`,
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
    const bigWins   = [];
    const bigExits  = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const addr = addresses[i];
      for (const t of results[i].value) {
        // Detect exits (SELL >= $10K — only after bot start)
        if (t.side === 'SELL' && parseFloat(t.usdcSize || 0) >= 10000) {
          const tsMs   = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
          if (tsMs >= BOT_START_MS) {
            const exitKey = `exit-${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
            if (!seenTrades.has(exitKey)) {
              bigExits.push({
                key:        exitKey,
                whaleName:  KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || formatWhaleName(t.name, t.proxyWallet || addr),
                usdcSize:   parseFloat(t.usdcSize || 0),
                price:      parseFloat(t.price    || 0),
                title:      t.title || 'Unknown Market',
                proxyWallet: t.proxyWallet || addr,
                timestamp:  t.timestamp || 0,
              });
            }
          }
        }
        // Detect wins (REDEEM = collected winnings — only after bot start)
        if (t.type === 'REDEEM' && parseFloat(t.usdcSize || 0) >= 100000) {
          const tsMs = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
          if (tsMs >= BOT_START_MS) {
            const winKey = `win-${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
            if (!seenTrades.has(winKey)) {
              bigWins.push({
                key: winKey,
                whaleName: KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || formatWhaleName(t.name, t.proxyWallet || addr),
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
        // Skip trades that existed before this bot session started
        const tsMs = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
        if (tsMs < BOT_START_MS) continue;
        const key = `${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
        // Deduplicate by whale + market (ignore multiple trades same whale same market)
        const marketKey = `market-${(t.proxyWallet || addr).toLowerCase()}-${t.slug || t.title || ''}`;
        if (seenTrades.has(key) || seenTrades.has(marketKey)) continue;
        bigTrades.push({
          key,
          whaleName: KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || formatWhaleName(t.name, t.proxyWallet || addr),
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

    // ── WEBHOOKS: fire immediately, no cooldown, before Twitter/Telegram ──
    await fireWebhooks(bigTrades);

    // Deduplicate within this cycle by market key (same whale, same market)
    const seenThisCycle = new Set();
    const deduped = bigTrades.filter(t => {
      const mk = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
      if (seenThisCycle.has(mk)) return false;
      seenThisCycle.add(mk);
      return true;
    });
    const toTweet = deduped.slice(0, 3); // max 3 per cycle to avoid rate limits

    // Cycle: bet → exit → win → bet → exit → win ...
    const lastCycle = getLastCycleType();
    const cycleMap  = { bet: 'exit', exit: 'win', win: 'bet' };
    const thisCycle = cycleMap[lastCycle] || 'bet';

    // Pick the top candidate title to check cooldown against (sports = shorter wait)
    const topTitle = toTweet[0]?.title || bigExits[0]?.title || bigWins[0]?.title || '';

    if (!canTweetToday()) {
      console.log(`  ⚠️ Daily limit (${DAILY_LIMIT}) reached — skipping until tomorrow.`);
    } else if (!canTweetNow(topTitle)) {
      // cooldown message already logged inside canTweetNow()
    } else if (thisCycle === 'exit') {
      // EXIT cycle — tweet a whale sell/exit
      bigExits.sort((a, b) => b.usdcSize - a.usdcSize);
      const ex = bigExits[0];
      if (ex) {
        try {
          // Claim slot immediately — mark seen + lock cooldown
          seenTrades.add(ex.key);
          saveSeen();
          saveLastTweetTime();
          await sendTelegramAlerts(ex, 'exit');
          if (TELEGRAM_DELAY_MS > 0) await new Promise(r => setTimeout(r, TELEGRAM_DELAY_MS));
          const text    = buildExitTweet(ex);
          const mediaId = await getCardMediaId({ title: ex.title, outcome: 'No', amount: fmtUSD(ex.usdcSize), price: ex.price, whaleName: ex.whaleName });
          console.log(`  → Exit Tweet${mediaId ? ' 🖼️' : ''}: ${ex.whaleName} exited ${fmtUSD(ex.usdcSize)} | ${text.length} chars`);
          const result = await postTweet(text, mediaId);
          const tweetId = result?.data?.id;
          const todayCount = incrementDailyCount();
          console.log(`  ✅ Exit: https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
          saveLastCycleType('exit');
          saveLastTweetTime();
        } catch (e) { console.error(`  ❌ Exit tweet failed: ${e.message}`); }
      } else {
        console.log(`  No new exits — falling back to bet tweet.`);
        const t = toTweet[0];
        if (t) {
          try { await tweetBet(t, 'Bet (fallback)'); }
          catch (e) { console.error(`  ❌ Failed: ${e.message}`); }
        } else {
          console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found either.`);
        }
      }
    } else if (thisCycle === 'win') {
      // WIN cycle — tweet 1 win (with card)
      bigWins.sort((a, b) => b.timestamp - a.timestamp);
      const w = bigWins[0];
      if (w) {
        try { await tweetWin(w); }
        catch (e) { console.error(`  ❌ Win tweet failed: ${e.message}`); }
      } else {
        console.log(`  No new $100K+ wins — falling back to bet tweet.`);
        const t = toTweet[0];
        if (t) {
          try { await tweetBet(t, 'Bet (fallback)'); }
          catch (e) { console.error(`  ❌ Failed: ${e.message}`); }
        } else {
          console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found either.`);
        }
      }
    } else {
      // BET cycle — tweet 1 bet (with card)
      const t = toTweet[0];
      if (t) {
        try { await tweetBet(t); }
        catch (e) { console.error(`  ❌ Failed: ${e.message}`); }
      } else {
        console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found.`);
      }
    }
  } catch (e) {
    console.error(`[Error] ${e.message}`);
  }
}

// ── FED ANNOUNCEMENT AUTO-TWEET ──────────────────────────────────────
// Monitors the Polymarket Fed rate market and auto-tweets when it resolves
const FED_MARKET_SLUG  = 'fed-decision-in-july-181';
const FED_ANNOUNCE_UTC = 18; // 2 PM ET = 18:00 UTC
const FED_FIRED_FILE   = path.join(__dirname, 'fed_tweet_fired.json');

function isFedTweetFired() {
  try { return fs.existsSync(FED_FIRED_FILE); } catch { return false; }
}
function markFedTweetFired() {
  try { fs.writeFileSync(FED_FIRED_FILE, JSON.stringify({ fired: true, at: new Date().toISOString() })); } catch {}
}

async function checkFedAnnouncement() {
  if (isFedTweetFired()) return;

  // Only start checking at 2 PM ET (18:00 UTC) on July 29 or later
  const now = new Date();
  const pastAnnouncement = now.getUTCFullYear() > 2026
    || now.getUTCMonth() > 6  // past July (month is 0-indexed)
    || now.getUTCDate() > 29
    || (now.getUTCDate() === 29 && now.getUTCHours() >= FED_ANNOUNCE_UTC);
  if (!pastAnnouncement) return;

  try {
    const data = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${FED_MARKET_SLUG}`);
    if (!data || !data.length) return;

    const event   = data[0];
    const markets = event.markets || [];

    // Accept formally resolved OR price-settled (one outcome at 0, other at 1)
    const settled = markets.find(m => {
      if (m.resolved === true) return true;
      try {
        const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
        return prices.some(p => p >= 0.99) && prices.some(p => p <= 0.01);
      } catch (e) { return false; }
    });
    if (!settled) return;

    // Determine outcome — find the winner (price = 1.0)
    const outcomes      = JSON.parse(settled.outcomes      || '[]');
    const outcomePrices = JSON.parse(settled.outcomePrices || '[]');
    const winnerIdx     = outcomePrices.findIndex(p => parseFloat(p) >= 0.99);
    const winner        = winnerIdx >= 0 ? outcomes[winnerIdx] : null;

    const hiked = winner && /hike|raise|25|50/i.test(winner);

    let tweet;
    if (hiked) {
      tweet = [
        `🚨 Fed just HIKED rates!`,
        ``,
        `Polymarket had this at just ~25% — whales who bet the hike just made a killing 🐋`,
        ``,
        `Catch the next whale move before it happens 👇`,
        ``,
        `⚡ Get alerts 10min early → whaletrack.app/premium`,
        `📋 Track live → whaletrack.app/politics | #Fed #FOMC #Polymarket`,
      ].join('\n');
    } else {
      tweet = [
        `✅ Fed held rates as expected`,
        ``,
        `Polymarket whales were positioned on the hold all along — smart money wins again 🐋`,
        ``,
        `Catch the next whale move before it happens 👇`,
        ``,
        `⚡ Get alerts 10min early → whaletrack.app/premium`,
        `📋 Track live → whaletrack.app/politics | #Fed #FOMC #Polymarket`,
      ].join('\n');
    }

    await postTweet(tweet);
    markFedTweetFired();
    console.log(`✅ Fed announcement tweet posted! Outcome: ${winner || 'unknown'}`);
  } catch (e) {
    console.error(`[Fed Monitor] ${e.message}`);
  }
}

// ── DAILY RECAP TWEET (9am MDT = 15:00 UTC) ──────────────────────────
function isDailyRecapSentToday() {
  try {
    if (!fs.existsSync(DAILY_RECAP_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(DAILY_RECAP_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return data.date === today;
  } catch { return false; }
}

function markDailyRecapSent() {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(DAILY_RECAP_FILE, JSON.stringify({ date: today, at: new Date().toISOString() }));
}

async function checkDailyRecap() {
  const now = new Date();
  if (now.getUTCHours() < DAILY_RECAP_HOUR_UTC) return;   // too early
  if (isDailyRecapSentToday()) return;                     // already sent today

  // Load hot bets from last 24h
  let bets = [];
  try {
    if (fs.existsSync(HOT_BETS_FILE)) {
      bets = JSON.parse(fs.readFileSync(HOT_BETS_FILE, 'utf8'));
    }
  } catch { return; }

  const cutoff = Date.now() / 1000 - 24 * 3600;
  const top3 = bets
    .filter(b => b.timestamp >= cutoff && b.usdcSize >= 5000)
    .sort((a, b) => b.usdcSize - a.usdcSize)
    .slice(0, 3);

  if (!top3.length) {
    console.log('[DailyRecap] No bets ≥$5K in last 24h — skipping recap');
    markDailyRecapSent();
    return;
  }

  const lines = top3.map((b, i) => {
    const emoji = ['🥇','🥈','🥉'][i];
    const outcome = b.outcome === 'Yes' ? '✅' : b.outcome === 'No' ? '❌' : b.outcome;
    const price = b.price ? Math.round(b.price * 100) : null;
    const priceStr = price ? ` @ ${price}¢` : '';
    const title = b.title.length > 40 ? b.title.slice(0, 40) + '…' : b.title;
    return `${emoji} ${fmtUSD(b.usdcSize)} ${outcome} "${title}"${priceStr}`;
  });

  const text = [
    `🐋 Biggest whale bets in last 24h:`,
    ``,
    ...lines,
    ``,
    `Track smart money → whaletrack.app`,
    `#Polymarket #PredictionMarkets`,
  ].join('\n');

  console.log(`[DailyRecap] Posting recap (${top3.length} bets):\n${text}`);
  try {
    const result = await postTweet(text);
    const tweetId = result?.data?.id;
    markDailyRecapSent();
    incrementDailyCount();
    console.log(`[DailyRecap] ✅ https://twitter.com/i/web/status/${tweetId}`);
  } catch (e) {
    console.error(`[DailyRecap] Failed: ${e.message}`);
  }
}

// ── TRENDING WHALE ALERT (Polymarket-first) ───────────────────────────
function loadTrendingData() {
  try {
    if (!fs.existsSync(TRENDING_FILE)) return { slugs: [], count: 0, date: '' };
    return JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf8'));
  } catch { return { slugs: [], count: 0, date: '' }; }
}
function saveTrendingData(data) {
  try { fs.writeFileSync(TRENDING_FILE, JSON.stringify(data)); } catch {}
}

function getTrendingHashtags(title) {
  const t = title.toLowerCase();
  const tags = ['#Polymarket'];
  if (/bitcoin|btc/.test(t))   tags.push('#Bitcoin');
  if (/ethereum|eth/.test(t))  tags.push('#Ethereum');
  if (/solana|sol\b/.test(t))  tags.push('#Solana');
  if (/crypto/.test(t))        tags.push('#Crypto');
  if (/mlb|baseball|astros|padres|dodgers|yankees|cubs|mets|red sox|braves/.test(t)) tags.push('#MLB');
  if (/nba|basketball/.test(t)) tags.push('#NBA');
  if (/nfl|football/.test(t))  tags.push('#NFL');
  if (/tennis|atp|wta|open/.test(t)) tags.push('#Tennis');
  if (/ufc|mma/.test(t))       tags.push('#UFC');
  if (/election|president|trump|senate/.test(t)) tags.push('#Polymarket');
  return [...new Set(tags)].slice(0, 3).join(' ');
}

async function checkTrendingWhaleAlert() {
  const now = Date.now();
  if (now - trendingLastCheck < TRENDING_INTERVAL_MS) return;
  trendingLastCheck = now;

  const today = new Date().toISOString().slice(0, 10);
  const data = loadTrendingData();
  if (data.date !== today) { data.slugs = []; data.count = 0; data.date = today; }
  if (data.count >= TRENDING_MAX_PER_DAY) return;

  // Load hot bets (last 24h, ≥$10K)
  let hotBets = [];
  try {
    if (fs.existsSync(HOT_BETS_FILE)) {
      const cutoff = Date.now() / 1000 - 24 * 3600;
      hotBets = JSON.parse(fs.readFileSync(HOT_BETS_FILE, 'utf8'))
        .filter(b => b.timestamp >= cutoff && b.usdcSize >= 10000 && b.slug);
    }
  } catch {}
  if (!hotBets.length) return;

  // Fetch top trending markets from Polymarket by 24h volume
  console.log('[Trending] Checking Polymarket trending markets...');
  let trending = [];
  try {
    const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=30&order=volume24hr&ascending=false');
    if (r.ok) trending = await r.json();
  } catch {}
  if (!trending.length) return;

  // Build set of trending slugs
  const trendingSlugs = new Set();
  for (const ev of trending) {
    if (ev.slug) trendingSlugs.add(ev.slug);
    for (const m of (ev.markets || [])) {
      if (m.slug) trendingSlugs.add(m.slug);
      if (m.eventSlug) trendingSlugs.add(m.eventSlug);
    }
  }

  // Find a hot bet whose market is trending and not already tweeted
  for (const bet of hotBets.sort((a, b) => b.usdcSize - a.usdcSize)) {
    if (data.slugs.includes(bet.slug)) continue;          // already tweeted this one
    if (!trendingSlugs.has(bet.slug)) continue;           // not trending right now

    const outcome   = bet.outcome === 'Yes' ? '✅ YES' : bet.outcome === 'No' ? '❌ NO' : bet.outcome;
    const price     = bet.price ? ` @ ${Math.round(bet.price * 100)}¢` : '';
    const title     = bet.title.length > 45 ? bet.title.slice(0, 45) + '…' : bet.title;
    const hashtags  = getTrendingHashtags(bet.title);
    const refLink   = `https://whaletrack.app/go`;

    const text = [
      `🐋 Whales are loading up on this Polymarket market 👀`,
      ``,
      `"${title}"`,
      ``,
      `${bet.whaleName}: ${fmtUSD(bet.usdcSize)} ${outcome}${price}`,
      ``,
      `Copy this bet → ${refLink}`,
      `📱 t.me/WhaleTrackPolybot | ⚡ whaletrack.app/premium`,
      hashtags,
    ].join('\n');

    // Check char count using twitterLen (URLs = 23 chars on Twitter)
    if (twitterLen(text) > 275) continue;

    console.log(`[Trending] Posting tweet for "${bet.title}" (${fmtUSD(bet.usdcSize)})`);
    try {
      const result  = await postTweet(text);
      const tweetId = result?.data?.id;
      data.slugs.push(bet.slug);
      data.count++;
      saveTrendingData(data);
      incrementDailyCount();
      console.log(`[Trending] ✅ https://twitter.com/i/web/status/${tweetId} [${data.count}/${TRENDING_MAX_PER_DAY} today]`);
    } catch(e) {
      console.error(`[Trending] Failed: ${e.message}`);
    }
    break; // one per check cycle
  }
}

// ── START (continuous daemon — polls every 60s) ───────────────────────
loadSeen();
checkAndTweet();
checkDailyRecap();
setInterval(async () => {
  await checkAndTweet();
  await checkFedAnnouncement();
  await checkDailyRecap();
  await checkTrendingWhaleAlert();
}, POLL_INTERVAL);
// Also run Fed check immediately on startup in case already past 2 PM ET
checkFedAnnouncement();
