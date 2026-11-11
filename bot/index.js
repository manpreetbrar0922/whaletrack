// WhaleTrack Telegram Bot — Premium Edition
// Free: basic whale alerts | Premium: win rate + P&L context + affiliate link + speed advantage
// Zero npm dependencies, pure Node.js

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const BOT_TOKEN          = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN env var required'); process.exit(1); }

const PREMIUM_CHANNEL_ID = process.env.PREMIUM_CHANNEL_ID || ''; // Telegram channel ID for premium alerts
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID || '';     // Your personal Telegram chat ID (admin only)
const AFFILIATE_TAG      = process.env.AFFILIATE_TAG || 'manpreet-singh-brar';
const FOREGATE_URL       = 'https://go.foregate.com/HCNO2vT'; // 80% commission affiliate
const POLL_INTERVAL      = parseInt(process.env.POLL_INTERVAL   || '300000'); // 5 min
const PNL_THRESHOLD      = parseInt(process.env.PNL_THRESHOLD   || '1000');   // $1K P&L change alert
const TRADE_ALERT_MIN    = parseInt(process.env.TRADE_ALERT_MIN || '10000');  // $10K trade alert
const WIN_RATE_MIN       = parseInt(process.env.WIN_RATE_MIN    || '55');     // min win% for premium
const DATA_DIR           = process.env.DATA_DIR || path.join(__dirname, '../data');
const SUBS_FILE          = path.join(DATA_DIR, 'subscriptions.json');
const PREMIUM_SUBS_FILE  = path.join(DATA_DIR, 'premium_subs.json'); // local fallback only
const USER_PREFS_FILE    = path.join(DATA_DIR, 'user_prefs.json');
const WHALETRACK_URL     = (process.env.WHALETRACK_URL || 'https://whaletrack.app').replace(/\/$/, '');
const INTERNAL_SECRET    = process.env.INTERNAL_SECRET || '';

// ── KNOWN WHALE NAMES ───────────────────────────────────────────────────────
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

// ── PERSISTENCE ─────────────────────────────────────────────────────────────
function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}

let subs        = loadJson(SUBS_FILE, {});          // { chatId: [address, ...] }
let premiumSubs = loadJson(PREMIUM_SUBS_FILE, []);  // [chatId, ...] — local fallback
let userPrefs   = loadJson(USER_PREFS_FILE, {});    // { chatId: { minBet: 10000 } }

// ── SYNC PREMIUM SUBS FROM VERCEL KV ─────────────────────────────────────────
async function syncPremiumSubs() {
  if (!WHALETRACK_URL || !INTERNAL_SECRET) return;
  try {
    const r    = await fetchJson(`${WHALETRACK_URL}/api/premium-subs?secret=${INTERNAL_SECRET}`, 10000);
    const ids  = r?.chatIds;
    if (Array.isArray(ids) && ids.length >= 0) {
      // Merge KV list with local fallback (keeps manually added ones too)
      const merged = [...new Set([...ids, ...premiumSubs])];
      premiumSubs  = merged.map(String);
      console.log(`[WhaleTrack] Synced ${ids.length} premium subs from KV (${premiumSubs.length} total)`);
    }
  } catch (e) {
    console.warn('[WhaleTrack] Premium sync failed (using local):', e.message);
  }
}

// Write a chat ID to Vercel KV via our endpoint
async function kvAddPremium(chatId, action = 'add') {
  if (!WHALETRACK_URL || !INTERNAL_SECRET) return false;
  try {
    const body = JSON.stringify({ chatId: String(chatId), action, secret: INTERNAL_SECRET });
    await new Promise((resolve, reject) => {
      const url  = new URL(`${WHALETRACK_URL}/api/add-premium`);
      const data = Buffer.from(body);
      const req  = https.request({
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-internal-secret': INTERNAL_SECRET },
      }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    return true;
  } catch (e) {
    console.warn('[WhaleTrack] KV write failed:', e.message);
    return false;
  }
}

// ── HTTP HELPERS ─────────────────────────────────────────────────────────────
function fetchJson(url, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WhaleTrack-Bot/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function telegramPost(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function send(chatId, text, extra = {}) {
  return telegramPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

// ── FORMATTERS ───────────────────────────────────────────────────────────────
function fmtUSD(n) {
  n = Math.abs(parseFloat(n));
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function addrShort(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }

// ── DEAD SLUG FILTER ─────────────────────────────────────────────────────────
const DEAD_SLUGS_FILE = path.join(__dirname, '../dead_slugs.json');
let deadSlugs = new Set();
function loadDeadSlugs() {
  try {
    const list = JSON.parse(fs.readFileSync(DEAD_SLUGS_FILE, 'utf8'));
    deadSlugs = new Set(Array.isArray(list) ? list : []);
  } catch { deadSlugs = new Set(); }
}
loadDeadSlugs();
setInterval(loadDeadSlugs, 10 * 60 * 1000); // reload every 10 min

// Quick live check: returns false if the slug 404s on Polymarket's gamma API
const slugCheckCache = new Map(); // cache results for 30 min
async function isSlugLive(slug) {
  if (!slug) return false;
  if (deadSlugs.has(slug)) return false;
  if (slugCheckCache.has(slug)) return slugCheckCache.get(slug);
  try {
    const data = await fetchJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
    const markets = Array.isArray(data) ? data : (data?.markets || []);
    const live = markets.length > 0 && markets[0].active !== false;
    slugCheckCache.set(slug, live);
    if (!live) deadSlugs.add(slug); // cache locally too
    setTimeout(() => slugCheckCache.delete(slug), 30 * 60 * 1000);
    return live;
  } catch { return true; } // on error assume live (don't break alert)
}

function polymarketLink(slug) {
  const base = slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com';
  return `${base}?via=${AFFILIATE_TAG}`;
}

// Safe link: returns null if slug is dead (caller shows no link or fallback)
async function safePolymarketLink(slug) {
  if (!slug) return null;
  const live = await isSlugLive(slug);
  return live ? polymarketLink(slug) : null;
}

// ── POLYMARKET API ───────────────────────────────────────────────────────────
async function fetchWhaleStats(address) {
  // Fetch individual user stats for whales not in the top-200 leaderboard
  try {
    const data = await fetchJson(`https://data-api.polymarket.com/v2/leaderboard?user=${address}`);
    const d = data?.data || data;
    if (!d || !d.user_id) return null;
    // Use volume rank if PnL rank is too high to be meaningful (>500)
    const rankPnl = d.rank_pnl || null;
    const rankVol = d.rank_volume || null;
    const rank = (rankPnl && rankPnl <= 500) ? rankPnl : (rankVol && rankVol <= 500 ? rankVol : null);
    return {
      pnl:    Math.round(parseFloat(d.pnl || 0)),
      volume: parseFloat(d.volume || 0),
      rank,
    };
  } catch { return null; }
}

async function fetchWhales() {
  try {
    // API uses user_id (not proxyWallet), user_name (not userName), volume (not vol)
    const data = await fetchJson('https://data-api.polymarket.com/v2/leaderboard?limit=200');
    const lb   = Array.isArray(data) ? data : (data?.data || []);
    const seen = new Set();
    const whales = [];

    // Build a lookup map: user_id (wallet address) → leaderboard entry
    const lbMap = new Map();
    lb.forEach(t => {
      if (t.user_id) lbMap.set(t.user_id.toLowerCase(), t);
    });

    // First: top 15 from leaderboard (dynamic whales)
    for (const t of lb.slice(0, 15)) {
      const addr = (t.user_id || '').toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      whales.push({
        name:    KNOWN_NAMES[addr] || t.user_name || t.x_username || addrShort(t.user_id),
        address: t.user_id || '',
        pnl:     Math.round(parseFloat(t.pnl || 0)),
        volume:  parseFloat(t.volume || 0),
        rank:    t.rank || '—',
      });
    }

    // Then: all KNOWN_NAMES — look up in lbMap first, fall back to individual fetch
    const knownEntries = Object.entries(KNOWN_NAMES).filter(([addr]) => !seen.has(addr.toLowerCase()));
    const knownStats = await Promise.all(
      knownEntries.map(async ([addr]) => {
        const e = lbMap.get(addr.toLowerCase());
        if (e) return { pnl: Math.round(parseFloat(e.pnl || 0)), volume: parseFloat(e.volume || 0), rank: e.rank || null };
        // Not in top 200 — fetch individually
        return await fetchWhaleStats(addr);
      })
    );

    for (let i = 0; i < knownEntries.length; i++) {
      const [addr, name] = knownEntries[i];
      seen.add(addr.toLowerCase());
      const s = knownStats[i];
      whales.push({
        name,
        address: addr,
        pnl:     s?.pnl ?? null,
        volume:  s?.volume || 0,
        rank:    s?.rank || null,
      });
    }

    return whales;
  } catch (e) { return []; }
}

async function fetchPositions(address) {
  try {
    const data = await fetchJson(
      `https://data-api.polymarket.com/v2/positions?user=${address}&limit=15&sortBy=current_value&sortDirection=DESC`
    );
    return Array.isArray(data) ? data : (data?.data || []);
  } catch (e) { return []; }
}

async function fetchActivity(address, limit = 8) {
  try {
    const data = await fetchJson(
      `https://data-api.polymarket.com/v2/activity?user=${address}&limit=${limit}`
    );
    const raw = Array.isArray(data) ? data : (data?.data || []);
    // Normalize v2 field names to match what the rest of the bot expects
    return raw.map(t => ({
      ...t,
      proxyWallet: t.proxy_wallet || t.proxyWallet || '',
      usdcSize:    parseFloat(t.usdc_size || t.usdcSize || 0),
      price:       parseFloat(t.price || 0),
      side:        t.side || t.type || 'BUY',
    }));
  } catch (e) { return []; }
}

// ── WIN RATE CALCULATOR ──────────────────────────────────────────────────────
// Looks at recent SELL trades — sold at >0.85 = win, sold at <0.15 = loss
const winRateCache = {}; // address → { rate, trades, cachedAt }

async function fetchWinRate(address) {
  const now = Date.now();
  const cached = winRateCache[address];
  if (cached && now - cached.cachedAt < 30 * 60 * 1000) return cached; // 30 min cache

  try {
    const activity = await fetchActivity(address, 50);

    let wins = 0, losses = 0;
    for (const t of activity) {
      const price = parseFloat(t.price || 0);
      // REDEEM = market resolved in their favour → always a win
      if (t.side === 'REDEEM') {
        wins++;
      // SELL at high price (>85¢) = exited a winner
      } else if (t.side === 'SELL' && price >= 0.85) {
        wins++;
      // SELL at very low price (<15¢) = cut a loser
      } else if (t.side === 'SELL' && price > 0 && price <= 0.15) {
        losses++;
      }
    }
    const total = wins + losses;
    const rate  = total > 0 ? Math.round((wins / total) * 100) : null;

    const result = { rate, wins, losses, total, cachedAt: now };
    winRateCache[address] = result;
    return result;
  } catch (e) {
    return { rate: null, wins: 0, losses: 0, total: 0, cachedAt: now };
  }
}

async function fetchAllActivity() {
  const addresses = cachedWhales.map(w => w.address).filter(Boolean);
  if (!addresses.length) return [];

  const results = await Promise.allSettled(addresses.map(addr => fetchActivity(addr, 5)));
  const all = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      const addr = (t.proxyWallet || '').toLowerCase();
      all.push({
        whale:    KNOWN_NAMES[addr] || t.name || t.pseudonym || addrShort(t.proxyWallet),
        address:  t.proxyWallet || '',
        side:     t.side || 'BUY',
        outcome:  t.outcome || '—',
        usdcSize: Math.round(parseFloat(t.usdcSize || 0)),
        price:    parseFloat(t.price || 0),
        title:    t.title || 'Unknown Market',
        slug:     t.slug || '',
        timestamp: t.timestamp || 0,
      });
    }
  }
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all;
}

// ── STATE ────────────────────────────────────────────────────────────────────
let cachedWhales = [];
let prevPnl      = {};
let seenTrades   = new Set();

// ── OPPOSING WHALE DETECTOR ──────────────────────────────────────────────────
// Scans already-fetched activity to find OTHER whales on the opposite side
// of the same market. No extra API calls — uses data we already have.
function findOpposingWhales(activity, currentTrade) {
  if (!currentTrade.slug) return [];
  const oppOutcome = currentTrade.outcome === 'Yes' ? 'No' : 'Yes';
  // Find any other whale who BUY-traded the opposite outcome on the same market
  const seen = new Map();
  for (const a of activity) {
    if (
      a.slug === currentTrade.slug &&
      a.outcome === oppOutcome &&
      a.side === 'BUY' &&
      a.address.toLowerCase() !== currentTrade.address.toLowerCase()
    ) {
      const addr = a.address.toLowerCase();
      const existing = seen.get(addr);
      if (!existing || a.usdcSize > existing.usdcSize) seen.set(addr, a);
    }
  }
  return [...seen.values()].sort((a, b) => b.usdcSize - a.usdcSize);
}

// ── OPPOSITE SIDE / HEDGE / PIVOT DETECTOR ───────────────────────────────────
// Fetches the whale's current positions on the traded market and classifies:
//   hedge  — they hold BOTH outcomes (locked in either way)
//   pivot  — they held the opposite side and just flipped
//   adding — they already hold this outcome and are doubling down
//   null   — fresh bet (no prior position on this market)
async function getMarketSideInfo(address, slug, boughtOutcome) {
  if (!slug) return null;
  try {
    const positions  = await fetchPositions(address);
    const mktPos     = positions.filter(p => p.slug === slug);
    const oppOutcome = boughtOutcome === 'Yes' ? 'No' : 'Yes';
    const ownsBought = mktPos.some(p => p.outcome === boughtOutcome);
    const ownsOpp    = mktPos.some(p => p.outcome === oppOutcome);
    const oppPos     = mktPos.find(p => p.outcome === oppOutcome);
    const oppSize    = oppPos ? Math.round(parseFloat(oppPos.currentValue || oppPos.size || 0)) : 0;

    if (ownsBought && ownsOpp) return { type: 'hedge',  oppOutcome, oppSize };
    if (ownsOpp && !ownsBought) return { type: 'pivot', oppOutcome, oppSize };
    if (ownsBought && !ownsOpp) return { type: 'adding', oppOutcome: null, oppSize: 0 };
    return null; // fresh bet or positions not yet updated
  } catch (e) {
    return null;
  }
}

// ── ALERT BUILDERS ───────────────────────────────────────────────────────────
function buildFreeAlert(t) {
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  return [
    `🐋 <b>Whale Alert!</b>`,
    ``,
    `<b>${t.whale}</b> just bought`,
    `${outcomeEmoji} <b>${t.outcome}</b> ${fmtUSD(t.usdcSize)} @ ${(t.price * 100).toFixed(0)}¢`,
    ``,
    `📊 <i>${t.title}</i>`,
    ``,
    `🔓 Get win rate + instant alerts → upgrade to Premium`,
    `🌐 whaletrack.app`,
  ].join('\n');
}

function buildPremiumAlert(t, whale, wr, sideInfo = null, opposingWhales = [], liveLink = null) {
  const outcomeDisplay = t.outcome && t.outcome !== '—' ? t.outcome : 'Position';
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  const oppEmoji     = t.outcome === 'Yes' ? '🔴' : '🟢'; // opposite colour
  // Guard against null/NaN rank (API sometimes returns null as string or number)
  const rankValid    = whale.rank && whale.rank !== 'null' && whale.rank !== '—' && !isNaN(Number(whale.rank));
  const rankStr      = rankValid ? `#${whale.rank} on Polymarket` : 'unranked';
  // Guard against NaN P&L (parseFloat failure on missing API field)
  const safePnl      = (whale.pnl !== null && whale.pnl !== undefined && !isNaN(whale.pnl)) ? whale.pnl : null;
  const pnlSign      = (safePnl || 0) >= 0 ? '+' : '';
  const pnlStr       = safePnl !== null ? `${pnlSign}${fmtUSD(safePnl)}` : 'n/a';
  const link         = liveLink || polymarketLink(t.slug);

  const wrLine = wr.rate !== null && wr.total >= 3
    ? `• Win rate: <b>${wr.rate}%</b> (${wr.total} resolved trades)`
    : `• Win rate: <b>tracking</b> (not enough resolved trades yet)`;

  // ── Side context line (hedge / pivot / adding) ──
  let sideLine = '';
  if (sideInfo) {
    if (sideInfo.type === 'hedge') {
      const oppSizeStr = sideInfo.oppSize > 0 ? ` ${fmtUSD(sideInfo.oppSize)}` : '';
      sideLine = `\n🔄 <b>Also holds ${oppEmoji} ${sideInfo.oppOutcome}${oppSizeStr} on this market — HEDGE</b>\n`;
    } else if (sideInfo.type === 'pivot') {
      const oppSizeStr = sideInfo.oppSize > 0 ? ` (had ${fmtUSD(sideInfo.oppSize)})` : '';
      sideLine = `\n🔄 <b>Flipped from ${oppEmoji} ${sideInfo.oppOutcome}${oppSizeStr} → now ${outcomeEmoji} ${outcomeDisplay} — PIVOT</b>\n`;
    } else if (sideInfo.type === 'adding') {
      sideLine = `\n➕ <b>Adding to existing ${outcomeEmoji} ${outcomeDisplay} position — doubling down</b>\n`;
    }
  }

  // ── Opposing whales line ──
  let opposingLine = '';
  if (opposingWhales.length > 0) {
    const top = opposingWhales.slice(0, 3);
    const lines = top.map(o => `  ${oppEmoji} <b>${o.whale}</b> ${fmtUSD(o.usdcSize)}`);
    opposingLine = `\n⚔️ <b>Other whale${top.length > 1 ? 's' : ''} on the ${oppEmoji} ${opposingWhales[0].outcome} side:</b>\n${lines.join('\n')}\n`;
  }

  return [
    `⚡ <b>PREMIUM Whale Alert</b>`,
    ``,
    `<b>${t.whale}</b> just bet ${fmtUSD(t.usdcSize)}`,
    `${outcomeEmoji} <b>${outcomeDisplay}</b> @ ${(t.price * 100).toFixed(0)}¢`,
    ``,
    `📊 <i>${t.title}</i>`,
    sideLine,
    opposingLine,
    `🐋 <b>This whale's track record:</b>`,
    `• Rank: <b>${rankStr}</b>`,
    `• Total P&amp;L: <b>${pnlStr}</b>`,
    wrLine,
    ``,
    liveLink
      ? `🎯 <a href="${liveLink}">Copy this bet on Polymarket →</a>`
      : `🎯 <a href="https://polymarket.com?via=${AFFILIATE_TAG}">View on Polymarket →</a>`,
    `🔥 <a href="${FOREGATE_URL}">Also on ForeGate — zero trading fees →</a>`,
    ``,
  ].filter(line => line !== '').join('\n');
}

// ── WIN ALERT (whale redeemed / collected winnings after market resolved) ────
function buildWinAlert(t, whale, wr, liveLink = null) {
  const rankValid = whale.rank && whale.rank !== 'null' && whale.rank !== '—' && !isNaN(Number(whale.rank));
  const rankStr   = rankValid ? `#${whale.rank} on Polymarket` : 'unranked';
  const safePnl   = (whale.pnl !== null && whale.pnl !== undefined && !isNaN(whale.pnl)) ? whale.pnl : null;
  const pnlSign   = (safePnl || 0) >= 0 ? '+' : '';
  const pnlStr    = safePnl !== null ? `${pnlSign}${fmtUSD(safePnl)}` : 'n/a';
  const link      = liveLink || polymarketLink(t.slug);
  const wrLine    = wr.rate !== null && wr.total >= 3
    ? `• Win rate: <b>${wr.rate}%</b> (${wr.total} resolved trades)`
    : `• Win rate: <b>tracking</b> (not enough resolved trades yet)`;

  return [
    `🏆 <b>PREMIUM Win Alert</b>`,
    ``,
    `<b>${t.whale}</b> just collected <b>${fmtUSD(t.usdcSize)}</b>`,
    `✅ Market resolved — they called it right`,
    ``,
    `📊 <i>${t.title}</i>`,
    ``,
    `🐋 <b>This whale's track record:</b>`,
    `• Rank: <b>${rankStr}</b>`,
    `• Total P&amp;L: <b>${pnlStr}</b>`,
    wrLine,
    ``,
    `🎯 <a href="${link}">See the market →</a>`,
    `🔥 <a href="${FOREGATE_URL}">Also trade on ForeGate — zero fees →</a>`,
    ``,
  ].join('\n');
}


// ── EXIT / LOSS ALERT (whale manually sold position before resolution) ────────
// isLoss = sold at very low price (< 15¢) → they're cutting a losing position
function buildExitAlert(t, whale, wr, isLoss = false, liveLink = null) {
  const outcomeEmoji   = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  const outcomeDisplay = t.outcome && t.outcome !== '—' ? t.outcome : 'Position';
  const rankValid = whale.rank && whale.rank !== 'null' && whale.rank !== '—' && !isNaN(Number(whale.rank));
  const rankStr   = rankValid ? `#${whale.rank} on Polymarket` : 'unranked';
  const safePnl   = (whale.pnl !== null && whale.pnl !== undefined && !isNaN(whale.pnl)) ? whale.pnl : null;
  const pnlSign   = (safePnl || 0) >= 0 ? '+' : '';
  const pnlStr    = safePnl !== null ? `${pnlSign}${fmtUSD(safePnl)}` : 'n/a';
  const link      = liveLink || polymarketLink(t.slug);
  const wrLine    = wr.rate !== null && wr.total >= 3
    ? `• Win rate: <b>${wr.rate}%</b> (${wr.total} resolved trades)`
    : `• Win rate: <b>tracking</b> (not enough resolved trades yet)`;
  const priceStr  = t.price > 0 ? ` @ ${(t.price * 100).toFixed(0)}¢` : '';
  const header    = isLoss ? `📉 <b>PREMIUM Loss Alert</b>` : `🚪 <b>PREMIUM Exit Alert</b>`;
  const actionLine = isLoss
    ? `${outcomeEmoji} Cut losing <b>${outcomeDisplay}</b>${priceStr} — took the L`
    : `${outcomeEmoji} Sold <b>${outcomeDisplay}</b>${priceStr}`;

  return [
    header,
    ``,
    `<b>${t.whale}</b> just exited <b>${fmtUSD(t.usdcSize)}</b>`,
    actionLine,
    ``,
    `📊 <i>${t.title}</i>`,
    ``,
    `🐋 <b>This whale's track record:</b>`,
    `• Rank: <b>${rankStr}</b>`,
    `• Total P&amp;L: <b>${pnlStr}</b>`,
    wrLine,
    ``,
    `🎯 <a href="${link}">See the market →</a>`,
    `🔥 <a href="${FOREGATE_URL}">Also trade on ForeGate — zero fees →</a>`,
    ``,
  ].join('\n');
}


// ── WHALE MONITOR ────────────────────────────────────────────────────────────
async function refreshWhales() {
  console.log('[WhaleTrack] Refreshing...');
  const whales = await fetchWhales();
  if (!whales.length) return;

  // P&L change alerts → all subscribers
  for (const whale of whales) {
    const prev = prevPnl[whale.address];
    if (prev !== undefined) {
      const diff = whale.pnl - prev;
      if (Math.abs(diff) >= PNL_THRESHOLD) {
        const emoji = diff > 0 ? '📈' : '📉';
        const sign  = diff > 0 ? '+' : '-';
        const msg   = [
          `${emoji} <b>${whale.name}</b> just moved ${sign}${fmtUSD(Math.abs(diff))}`,
          `Total P&amp;L: <b>${whale.pnl >= 0 ? '+' : ''}${fmtUSD(whale.pnl)}</b>`,
          `Rank: #${whale.rank}`,
          ``,
          `See their bets: /positions`,
        ].join('\n');

        for (const [chatId, addrs] of Object.entries(subs)) {
          if (addrs.includes(whale.address.toLowerCase())) {
            send(chatId, msg).catch(() => {});
          }
        }
      }
    }
    prevPnl[whale.address] = whale.pnl;
  }

  cachedWhales = whales;
  await checkTradeAlerts();  // re-enabled — whale_alert_twitter.cjs daemon is dead
  console.log(`[WhaleTrack] ${whales.length} whales | ${Object.keys(subs).length} free subs | ${premiumSubs.length} premium`);
}

async function checkTradeAlerts() {
  try {
    const activity    = await fetchAllActivity();
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;

    // ── BUY alerts ────────────────────────────────────────────────────────────
    const bigTrades = activity.filter(t =>
      t.usdcSize >= TRADE_ALERT_MIN &&
      t.side === 'BUY' &&
      t.price > 0.02 && t.price < 0.98 &&   // skip resolved markets (price = 0 or 1)
      t.timestamp > twoHoursAgo &&
      !seenTrades.has(`buy-${t.address}-${t.timestamp}`)
    );

    for (const t of bigTrades.slice(0, 5)) {
      const key = `buy-${t.address}-${t.timestamp}`;
      seenTrades.add(key);

      const whale = cachedWhales.find(w => w.address.toLowerCase() === t.address.toLowerCase());
      if (!whale) continue;

      if (PREMIUM_CHANNEL_ID || premiumSubs.length) {
        const [wr, sideInfo, liveLink] = await Promise.all([
          fetchWinRate(t.address),
          getMarketSideInfo(t.address, t.slug, t.outcome),
          safePolymarketLink(t.slug),
        ]);
        const opposingWhales = findOpposingWhales(activity, t);
        const premiumMsg = buildPremiumAlert(t, whale, wr, sideInfo, opposingWhales, liveLink);
        if (PREMIUM_CHANNEL_ID) send(PREMIUM_CHANNEL_ID, premiumMsg, { disable_web_page_preview: false }).catch(() => {});
        for (const chatId of premiumSubs) send(chatId, premiumMsg, { disable_web_page_preview: false }).catch(() => {});
      }

      const freeMsg = buildFreeAlert(t);
      for (const [chatId, addrs] of Object.entries(subs)) {
        if (addrs.includes(t.address.toLowerCase()) || addrs.length === cachedWhales.length) {
          send(chatId, freeMsg).catch(() => {});
        }
      }
    }

    // ── WIN alerts (REDEEM = whale collected winnings after market resolved) ──
    const bigWins = activity.filter(t =>
      t.side === 'REDEEM' &&
      t.usdcSize >= TRADE_ALERT_MIN &&
      t.timestamp > twoHoursAgo &&
      !seenTrades.has(`win-${t.address}-${t.timestamp}`)
    );

    for (const t of bigWins.slice(0, 3)) {
      const key = `win-${t.address}-${t.timestamp}`;
      seenTrades.add(key);

      const whale = cachedWhales.find(w => w.address.toLowerCase() === t.address.toLowerCase());
      if (!whale) continue;

      const [wr, liveLink] = await Promise.all([fetchWinRate(t.address), safePolymarketLink(t.slug)]);
      const winMsg = buildWinAlert(t, whale, wr, liveLink);
      if (PREMIUM_CHANNEL_ID) send(PREMIUM_CHANNEL_ID, winMsg).catch(() => {});
      for (const chatId of premiumSubs) send(chatId, winMsg).catch(() => {});
    }

    // ── EXIT / LOSS alerts (SELL = whale exited position before resolution) ────
    // isLoss = sold at < 15¢ — whale is cutting a losing position
    const bigExits = activity.filter(t =>
      t.side === 'SELL' &&
      t.usdcSize >= TRADE_ALERT_MIN &&
      t.timestamp > twoHoursAgo &&
      !seenTrades.has(`exit-${t.address}-${t.timestamp}`)
    );

    for (const t of bigExits.slice(0, 3)) {
      const key    = `exit-${t.address}-${t.timestamp}`;
      const isLoss = t.price > 0 && t.price < 0.15; // sold at < 15¢ = cutting a loser
      seenTrades.add(key);

      const whale = cachedWhales.find(w => w.address.toLowerCase() === t.address.toLowerCase());
      if (!whale) continue;

      const [wr, liveLink] = await Promise.all([fetchWinRate(t.address), safePolymarketLink(t.slug)]);
      const exitMsg = buildExitAlert(t, whale, wr, isLoss, liveLink);
      if (PREMIUM_CHANNEL_ID) send(PREMIUM_CHANNEL_ID, exitMsg).catch(() => {});
      for (const chatId of premiumSubs) send(chatId, exitMsg).catch(() => {});
    }

    if (seenTrades.size > 500) seenTrades = new Set([...seenTrades].slice(-200));
  } catch (e) {
    console.error('Trade alert check error:', e.message);
  }
}

// ── RATE LIMITER ─────────────────────────────────────────────────────────────
const rateLimitMap = {}; // { chatId: [timestamps] }
const RATE_LIMIT   = 5;  // max commands
const RATE_WINDOW  = 30 * 1000; // per 30 seconds

function isRateLimited(chatId) {
  const now  = Date.now();
  const id   = String(chatId);
  const hits  = (rateLimitMap[id] || []).filter(t => now - t < RATE_WINDOW);
  hits.push(now);
  rateLimitMap[id] = hits;
  return hits.length > RATE_LIMIT;
}

// ── COMMAND HANDLERS ─────────────────────────────────────────────────────────
function findWhale(q) {
  q = q.toLowerCase().trim();
  return cachedWhales.find(w =>
    w.name.toLowerCase().includes(q) ||
    w.address.toLowerCase() === q ||
    w.address.toLowerCase().startsWith(q)
  );
}

async function handleCommand(chatId, text) {
  const parts     = text.trim().split(/\s+/);
  const cmd       = parts[0].replace(/^\//, '').split('@')[0].toLowerCase();
  const args      = parts.slice(1).join(' ').trim();
  const id        = String(chatId);
  const isAdmin   = ADMIN_CHAT_ID && id === String(ADMIN_CHAT_ID);
  const isPremium = premiumSubs.includes(id) || isAdmin;

  // ── /start is open to everyone — shows their chat ID for Stripe checkout ──
  if (cmd === 'start') {
    if (isPremium) {
      // Already premium — show welcome back
      await send(chatId, [
        `✅ <b>You already have Premium access!</b>`,
        ``,
        `Type /help to see all commands 🐋`,
      ].join('\n'));
    } else {
      await send(chatId, [
        `🐋 <b>WhaleTrack Bot</b>`,
        ``,
        `To get Premium access:`,
        ``,
        `1️⃣ Copy your WhaleTrack ID:`,
        `<code>${chatId}</code>`,
        ``,
        `2️⃣ Visit <a href="https://whaletrack.app/premium">whaletrack.app/premium</a>`,
        ``,
        `3️⃣ Subscribe and paste your ID in the <b>"WhaleTrack ID"</b> field`,
        ``,
        `4️⃣ You'll get instant bot access when payment completes 🎉`,
        ``,
        `Questions? DM <b>@manpreetbrar09</b> on Twitter`,
      ].join('\n'));
      // Notify admin
      if (ADMIN_CHAT_ID && !isAdmin) {
        await send(ADMIN_CHAT_ID, [
          `👋 <b>New bot contact!</b>`,
          ``,
          `Chat ID: <code>${chatId}</code>`,
          ``,
          `If Stripe didn't auto-grant: /addpremium ${chatId}`,
        ].join('\n')).catch(() => {});
      }
    }
    return;
  }

  // ── Allowlist: only premium subs + admin can use the bot ──
  if (!isPremium) {
    await send(chatId, [
      `🔒 <b>Private Bot</b>`,
      ``,
      `This bot is for WhaleTrack Premium subscribers only.`,
      ``,
      `To subscribe: <a href="https://whaletrack.app/premium">whaletrack.app/premium</a>`,
      `Or DM <b>@manpreetbrar09</b> on Twitter`,
    ].join('\n'));
    return;
  }

  // ── Rate limit (skip for admin) ──
  if (!isAdmin && isRateLimited(chatId)) {
    await send(chatId, `⏳ Slow down! Max ${RATE_LIMIT} commands per 30 seconds.`);
    return;
  }

  switch (cmd) {

    case 'help':
      await send(chatId, [
        `🐋 <b>WhaleTrack Bot</b>`,
        `Track smart money on Polymarket in real time.`,
        ``,
        `<b>Free Commands:</b>`,
        `/whales — tracked whales + total P&amp;L`,
        `/positions &lt;name&gt; — their open bets`,
        `/activity — latest whale trades`,
        `/top — top markets by volume`,
        `/watch &lt;name&gt; — alert when they trade`,
        `/watchall — watch every whale`,
        `/unwatch — stop all alerts`,
        `/mysubs — your subscriptions`,
        ``,
        `<b>⚡ Premium ($9/month):</b>`,
        `• Win rate + track record on every alert`,
        `• 10+ min faster than Twitter`,
        `• Only high-confidence whale alerts (${WIN_RATE_MIN}%+ win rate)`,
        `/setminbet — filter alerts by minimum bet size`,
        `/myprefs — view your current settings`,
        ``,
        `/premium — upgrade info`,
        ``,
        `🌐 https://whaletrack.app`,
      ].join('\n'));
      break;

    case 'premium':
      await send(chatId, [
        `⚡ <b>WhaleTrack Premium — $9/month</b>`,
        ``,
        `<b>What you get:</b>`,
        `✅ Win rate on every whale alert`,
        `✅ Total P&amp;L + leaderboard rank`,
        `✅ 10+ min faster than free Twitter alerts`,
        `✅ Direct copy-bet link (1 tap to copy on Polymarket)`,
        `✅ Only alerts from whales with ${WIN_RATE_MIN}%+ win rate`,
        ``,
        `<b>Free tier:</b>`,
        `❌ No win rate data`,
        `❌ Delayed vs Twitter`,
        `❌ No copy-bet link`,
        ``,
        `📩 To subscribe, DM @manpreetbrar09 on Twitter`,
        `or email: manpreetbrar491@gmail.com`,
        ``,
        `🌐 whaletrack.app`,
      ].join('\n'));
      break;

    case 'whales': {
      if (!cachedWhales.length) { await send(chatId, '⏳ Loading... try again in a moment'); break; }
      const lines = cachedWhales.map((w, i) => {
        const pnlStr  = (w.pnl !== null && w.pnl !== undefined && !isNaN(w.pnl))
          ? `${w.pnl >= 0 ? '+' : ''}${fmtUSD(w.pnl)}`
          : 'P&L: n/a';
        const rankStr = (w.rank && w.rank !== 'null') ? `Rank #${w.rank}` : 'unranked';
        return `${i + 1}. <b>${w.name}</b> — ${pnlStr} (${rankStr})`;
      });
      await send(chatId, [
        `🐋 <b>Tracked Whales</b>`,
        ``,
        lines.join('\n'),
        ``,
        `Use /positions &lt;name&gt; to see their bets`,
        isPremium ? `\n⚡ You have Premium — win rates shown on all alerts` : `\nUpgrade for win rates: /premium`,
      ].join('\n'));
      break;
    }

    case 'winrate': {
      if (!args) { await send(chatId, 'Usage: /winrate &lt;whale name&gt;'); break; }
      if (!isPremium) {
        await send(chatId, `🔒 Win rate data is a <b>Premium</b> feature.\n\nUpgrade for $9/month → /premium`);
        break;
      }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }
      await send(chatId, `⏳ Calculating win rate for ${whale.name}...`);
      const wr = await fetchWinRate(whale.address);
      const pnlSign = whale.pnl >= 0 ? '+' : '';
      await send(chatId, [
        `🐋 <b>${whale.name}</b> — Track Record`,
        ``,
        `🏆 Rank: <b>#${whale.rank}</b> on Polymarket`,
        `💰 Total P&amp;L: <b>${pnlSign}${fmtUSD(whale.pnl)}</b>`,
        wr.rate !== null && wr.total >= 3
          ? `🎯 Win rate: <b>${wr.rate}%</b> (${wr.wins}W / ${wr.losses}L from ${wr.total} resolved trades)`
          : `🎯 Win rate: Not enough resolved trades yet`,
        ``,
        `🌐 whaletrack.app`,
      ].join('\n'));
      break;
    }

    case 'positions': {
      if (!args) { await send(chatId, 'Usage: /positions &lt;whale name&gt;\nExample: /positions somalianKing'); break; }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }

      await send(chatId, `⏳ Loading ${whale.name}'s positions...`);
      const positions = await fetchPositions(whale.address);

      if (!positions.length) { await send(chatId, `🐋 <b>${whale.name}</b>\n\nNo open positions found.`); break; }

      const lines = positions.slice(0, 10).map(p => {
        const outcome  = p.outcome || '—';
        const size     = fmtUSD(p.currentValue || p.size || 0);
        const curPrice = parseFloat(p.currentPrice || 0);
        const pnl      = parseFloat(p.unrealizedPnl || 0);
        const pnlStr   = pnl !== 0 ? ` ${pnl > 0 ? '📈 +' : '📉 '}${fmtUSD(pnl)}` : '';
        const emoji    = outcome === 'Yes' ? '🟢' : outcome === 'No' ? '🔴' : '⚪';
        const title    = (p.title || p.market || 'Unknown').slice(0, 45);
        const copyLink = p.slug ? `\n   <a href="${polymarketLink(p.slug)}">Copy bet →</a>` : '';
        return `${emoji} <b>${outcome}</b> ${size} @ ${curPrice > 0 ? (curPrice * 100).toFixed(0) + '¢' : '—'}${pnlStr}\n   <i>${title}</i>${isPremium ? copyLink : ''}`;
      });

      const pnlSign = (whale.pnl || 0) >= 0 ? '+' : '';
      const rankStr = whale.rank ? `Rank #${whale.rank}` : 'unranked';
      const pnlStr  = whale.pnl !== null && whale.pnl !== undefined ? `P&amp;L: ${pnlSign}${fmtUSD(whale.pnl)}` : 'P&amp;L: n/a';
      await send(chatId, [
        `🐋 <b>${whale.name}</b> — Open Positions`,
        `${rankStr} | ${pnlStr}`,
        ``,
        lines.join('\n\n'),
        ``,
        isPremium ? '' : `🔒 Upgrade for copy-bet links: /premium`,
        `🌐 whaletrack.app`,
      ].join('\n'));
      break;
    }

    case 'activity': {
      if (args) {
        const whale = findWhale(args);
        if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }
        await send(chatId, `⏳ Loading ${whale.name}'s recent trades...`);
        const trades = await fetchActivity(whale.address, 10);
        if (!trades.length) { await send(chatId, `No recent trades found for <b>${whale.name}</b>`); break; }

        const lines = trades.slice(0, 8).map(t => {
          const emoji = t.side === 'BUY' ? '🟢' : '🔴';
          return `${emoji} ${t.side} <b>${t.outcome}</b> ${fmtUSD(t.usdcSize)} @ ${(t.price * 100).toFixed(0)}¢ · ${timeAgo(t.timestamp)}\n   <i>${(t.title || '').slice(0, 45)}</i>`;
        });
        await send(chatId, `⚡ <b>${whale.name}</b> — Recent Trades\n\n${lines.join('\n\n')}`);
      } else {
        await send(chatId, '⏳ Loading latest whale activity...');
        const all = await fetchAllActivity();
        // Only show trades ≥$1K in the activity feed
        const notable = all.filter(t => t.usdcSize >= 1000);
        if (!notable.length) { await send(chatId, 'No notable activity found (min $1K).'); break; }

        const lines = notable.slice(0, 10).map(t => {
          const emoji = t.side === 'BUY' ? '🟢' : '🔴';
          return `${emoji} <b>${t.whale}</b> ${t.side} <b>${t.outcome}</b> ${fmtUSD(t.usdcSize)} · ${timeAgo(t.timestamp)}\n   <i>${(t.title || '').slice(0, 45)}</i>`;
        });
        await send(chatId, `⚡ <b>Live Whale Activity</b> (≥$1K)\n\n${lines.join('\n\n')}\n\n🌐 whaletrack.app`);
      }
      break;
    }

    case 'top': {
      await send(chatId, '⏳ Loading top markets...');
      try {
        const data = await fetchJson(
          'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=20&order=volume&ascending=false'
        );
        const markets = [];
        for (const event of (Array.isArray(data) ? data : [])) {
          for (const market of (event.markets || [])) {
            if (!market.active || market.closed) continue;
            let prices, outcomes;
            try { prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices || []); } catch (e) { continue; }
            try { outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes || []); } catch (e) { continue; }
            const yesIdx = outcomes.findIndex(o => o === 'Yes');
            if (yesIdx === -1) continue;
            if (parseFloat(market.liquidity || 0) < 5000) continue;
            markets.push({
              question: market.question || event.title || '',
              price:    parseFloat(prices[yesIdx] || 0),
              volume:   parseFloat(market.volume || 0),
              slug:     event.slug || '',
            });
          }
        }
        markets.sort((a, b) => b.volume - a.volume);
        const top = markets.slice(0, 8);
        if (!top.length) { await send(chatId, 'No market data available right now.'); break; }

        const lines = top.map((m, i) => {
          const price = (m.price * 100).toFixed(0);
          const vol   = m.volume >= 1_000_000 ? '$' + (m.volume / 1_000_000).toFixed(1) + 'M' : '$' + (m.volume / 1_000).toFixed(0) + 'K';
          const link  = isPremium && m.slug ? ` — <a href="${polymarketLink(m.slug)}">bet →</a>` : '';
          return `${i + 1}. <b>${(m.question || '').slice(0, 45)}</b>\n   Yes: ${price}¢ | Vol: ${vol}${link}`;
        });
        await send(chatId, `🔥 <b>Top Markets by Volume</b>\n\n${lines.join('\n\n')}\n\n🌐 whaletrack.app`, { disable_web_page_preview: true });
      } catch (e) {
        await send(chatId, '❌ Failed to load markets. Try again.');
      }
      break;
    }

    case 'watch': {
      if (!args) { await send(chatId, 'Usage: /watch &lt;whale name&gt;\nExample: /watch somalianKing'); break; }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }
      const id   = String(chatId);
      const addr = whale.address.toLowerCase();
      if (!subs[id]) subs[id] = [];
      if (!subs[id].includes(addr)) { subs[id].push(addr); saveJson(SUBS_FILE, subs); }
      await send(chatId, [
        `✅ Watching <b>${whale.name}</b>`,
        ``,
        `You'll be alerted when they make a trade over ${fmtUSD(TRADE_ALERT_MIN)}`,
        isPremium ? `⚡ You're Premium — alerts include win rate + copy-bet link` : `\nUpgrade for win rate + copy-bet links: /premium`,
      ].join('\n'));
      break;
    }

    case 'watchall': {
      const id = String(chatId);
      subs[id] = cachedWhales.map(w => w.address.toLowerCase());
      saveJson(SUBS_FILE, subs);
      await send(chatId, `✅ Watching all <b>${cachedWhales.length} whales</b>\n\nYou'll be alerted on big P&amp;L moves and large trades`);
      break;
    }

    case 'unwatch': {
      const id = String(chatId);
      if (!args) { subs[id] = []; saveJson(SUBS_FILE, subs); await send(chatId, '✅ Unsubscribed from all whale alerts'); break; }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>`); break; }
      if (subs[id]) { subs[id] = subs[id].filter(a => a !== whale.address.toLowerCase()); saveJson(SUBS_FILE, subs); }
      await send(chatId, `✅ Stopped watching <b>${whale.name}</b>`);
      break;
    }

    case 'mysubs': {
      const id    = String(chatId);
      const addrs = subs[id] || [];
      if (!addrs.length) { await send(chatId, '📭 No active subscriptions\n\nUse /watch &lt;name&gt; to subscribe'); break; }
      const names = addrs.map(a => {
        const w = cachedWhales.find(w => w.address.toLowerCase() === a);
        return w ? `• <b>${w.name}</b>` : `• <code>${a.slice(0, 10)}…</code>`;
      });
      await send(chatId, `📬 <b>Your Subscriptions (${addrs.length})</b>\n\n${names.join('\n')}\n\nUse /unwatch &lt;name&gt; to remove`);
      break;
    }

    case 'setminbet': {
      if (!isPremium) {
        await send(chatId, `🔒 This is a <b>Premium</b> feature.\n\nUpgrade for $9/month → /premium`);
        break;
      }
      const amount = parseInt(args.replace(/[^0-9]/g, ''));
      if (!args || isNaN(amount) || amount < 1000) {
        await send(chatId, [
          `⚙️ <b>Set Minimum Bet Filter</b>`,
          ``,
          `Usage: /setminbet &lt;amount&gt;`,
          `Example: /setminbet 25000`,
          ``,
          `You'll only receive alerts when a whale bets at or above your threshold.`,
          `Minimum: $1,000`,
          ``,
          `Current setting: <b>${fmtUSD(userPrefs[String(chatId)]?.minBet || TRADE_ALERT_MIN)}</b>`,
        ].join('\n'));
        break;
      }
      const id = String(chatId);
      if (!userPrefs[id]) userPrefs[id] = {};
      userPrefs[id].minBet = amount;
      saveJson(USER_PREFS_FILE, userPrefs);
      await send(chatId, [
        `✅ <b>Filter updated!</b>`,
        ``,
        `You'll now only receive alerts for whale bets ≥ <b>${fmtUSD(amount)}</b>`,
        ``,
        `Change it anytime with /setminbet &lt;amount&gt;`,
        `Reset to default with /setminbet 10000`,
      ].join('\n'));
      break;
    }

    case 'myprefs': {
      if (!isPremium) {
        await send(chatId, `🔒 This is a <b>Premium</b> feature.\n\nUpgrade for $9/month → /premium`);
        break;
      }
      const id   = String(chatId);
      const prefs = userPrefs[id] || {};
      await send(chatId, [
        `⚙️ <b>Your Preferences</b>`,
        ``,
        `🔔 Min bet filter: <b>${fmtUSD(prefs.minBet || TRADE_ALERT_MIN)}</b>`,
        ``,
        `Change with /setminbet &lt;amount&gt;`,
      ].join('\n'));
      break;
    }

    // ── ADMIN ONLY ─────────────────────────────────────────────────────────
    case 'msg': {
      if (!isAdmin) { await send(chatId, '❌ Unauthorized'); break; }
      const spaceIdx  = args.indexOf(' ');
      if (spaceIdx === -1) { await send(chatId, 'Usage: /msg &lt;chatId&gt; &lt;message&gt;'); break; }
      const targetId  = args.slice(0, spaceIdx).trim();
      const message   = args.slice(spaceIdx + 1).trim();
      if (!targetId || !message) { await send(chatId, 'Usage: /msg &lt;chatId&gt; &lt;message&gt;'); break; }
      try {
        await send(targetId, message);
        await send(chatId, `✅ Message sent to ${targetId}`);
      } catch (e) {
        await send(chatId, `❌ Failed to send: ${e.message}`);
      }
      break;
    }
    case 'addpremium': {
      if (!isAdmin) { await send(chatId, '❌ Unauthorized'); break; }
      if (!args) { await send(chatId, 'Usage: /addpremium &lt;chatId&gt;'); break; }
      const targetId = String(args.trim());
      // Add to local list
      if (!premiumSubs.includes(targetId)) {
        premiumSubs.push(targetId);
        saveJson(PREMIUM_SUBS_FILE, premiumSubs);
      }
      // Add to KV (async, best effort)
      kvAddPremium(targetId, 'add').catch(() => {});
      await send(chatId, `✅ Added ${targetId} to Premium`);
      await send(targetId, [
        `🎉 <b>You're now a WhaleTrack Premium member!</b>`,
        ``,
        `You'll now receive:`,
        `⚡ Instant whale alerts (before Twitter)`,
        `🎯 Win rate + track record on every alert`,
        `🔗 Direct copy-bet links`,
        ``,
        `Type /help to see all commands`,
        `Enjoy! 🐋`,
      ].join('\n')).catch(() => {});
      break;
    }

    case 'removepremium': {
      if (!isAdmin) { await send(chatId, '❌ Unauthorized'); break; }
      if (!args) { await send(chatId, 'Usage: /removepremium &lt;chatId&gt;'); break; }
      const targetId = String(args.trim());
      const idx = premiumSubs.indexOf(targetId);
      if (idx !== -1) { premiumSubs.splice(idx, 1); saveJson(PREMIUM_SUBS_FILE, premiumSubs); }
      // Remove from KV too
      kvAddPremium(targetId, 'remove').catch(() => {});
      await send(chatId, `✅ Removed ${targetId} from Premium`);
      break;
    }

    case 'stats': {
      if (!isAdmin) { await send(chatId, '❌ Unauthorized'); break; }
      await send(chatId, [
        `📊 <b>WhaleTrack Bot Stats</b>`,
        ``,
        `🐋 Whales tracked: ${cachedWhales.length}`,
        `👥 Free subscribers: ${Object.keys(subs).length}`,
        `⚡ Premium subscribers: ${premiumSubs.length}`,
        `🔔 Trades seen: ${seenTrades.size}`,
        ``,
        `💰 Monthly revenue: $${premiumSubs.length * 9}`,
      ].join('\n'));
      break;
    }

    default:
      break;
  }
}

// ── AUTO-GRANT: handle new member joining premium channel ─────────────────────
async function handleNewChannelMember(update) {
  const member  = update.chat_member;
  if (!member) return;

  const chatId  = String(member.chat.id);
  const userId  = String(member.new_chat_member.user.id);
  const oldStatus = member.old_chat_member?.status;  // 'left', 'kicked', 'restricted'
  const newStatus = member.new_chat_member?.status;  // 'member', 'administrator'

  // Only fire when someone freshly joins (not leaves/bans)
  const justJoined = ['member', 'administrator'].includes(newStatus) &&
                     ['left', 'kicked', 'restricted'].includes(oldStatus);
  if (!justJoined) return;

  // Only act on joins to the premium channel
  if (chatId !== String(PREMIUM_CHANNEL_ID)) return;

  // Skip bots
  if (member.new_chat_member.user.is_bot) return;

  console.log(`[WhaleTrack] New premium member joined: ${userId} (${member.new_chat_member.user.first_name})`);

  // Grant bot access
  await kvAddPremium(userId);
  if (!premiumSubs.includes(userId)) premiumSubs.push(userId);

  // Welcome DM
  try {
    await send(userId, [
      `🎉 <b>Welcome to WhaleTrack Premium!</b>`,
      ``,
      `You're now fully set up — bot alerts will fire directly to this chat 🐋`,
      ``,
      `⚡ /whales — tracked whales + P&amp;L`,
      `🎯 /winrate &lt;name&gt; — win rate + track record`,
      `📊 /positions &lt;name&gt; — open bets right now`,
      `🔔 /setminbet 25000 — filter alerts by size`,
      ``,
      `Questions? DM @manpreetbrar09 on Twitter`,
    ].join('\n'));
    console.log(`[WhaleTrack] Welcome DM sent to ${userId}`);
  } catch (e) {
    console.warn(`[WhaleTrack] Could not DM ${userId}:`, e.message);
  }

  // Notify admin
  const user = member.new_chat_member.user;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  await send(ADMIN_CHAT_ID, `✅ <b>Auto-granted premium!</b>\n\n👤 ${name}\n🆔 ${userId}\n\n🤖 Bot access granted + welcome DM sent`)
    .then(() => console.log(`[WhaleTrack] Admin notified of new member: ${name}`))
    .catch(e => console.warn(`[WhaleTrack] Admin notification FAILED for ${name}: ${e.message}`));
}

// ── LONG POLLING ──────────────────────────────────────────────────────────────
let offset = 0;

async function poll() {
  while (true) {
    try {
      const data = await fetchJson(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=%5B%22message%22%2C%22chat_member%22%5D`,
        35000
      );
      for (const u of (data.result || [])) {
        offset = u.update_id + 1;

        // Handle new premium channel member → auto-grant
        if (u.chat_member) {
          handleNewChannelMember(u).catch(e => console.error('Member handler error:', e.message));
        }

        // Handle bot commands
        const msg = u.message;
        if (msg?.text?.startsWith('/')) {
          handleCommand(msg.chat.id, msg.text).catch(e => console.error('Handler error:', e.message));
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('🐋 WhaleTrack Bot v2 (Premium Edition) starting...');
console.log(`   Trade alert min:    ${fmtUSD(TRADE_ALERT_MIN)}`);
console.log(`   P&L alert min:      ${fmtUSD(PNL_THRESHOLD)}`);
console.log(`   Win rate minimum:   ${WIN_RATE_MIN}%`);
console.log(`   Premium channel:    ${PREMIUM_CHANNEL_ID || 'not set'}`);
console.log(`   Premium subs:       ${premiumSubs.length}`);
console.log(`   Refresh interval:   ${POLL_INTERVAL / 1000}s`);

// Sync premium subs from Vercel KV on start + every 5 min
syncPremiumSubs().then(() => {
  setInterval(syncPremiumSubs, 5 * 60 * 1000);
});

refreshWhales().then(() => {
  poll();
  setInterval(refreshWhales, POLL_INTERVAL);
});
