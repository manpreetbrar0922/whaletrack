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
const POLL_INTERVAL      = parseInt(process.env.POLL_INTERVAL   || '300000'); // 5 min
const PNL_THRESHOLD      = parseInt(process.env.PNL_THRESHOLD   || '1000');   // $1K P&L change alert
const TRADE_ALERT_MIN    = parseInt(process.env.TRADE_ALERT_MIN || '10000');  // $10K trade alert
const WIN_RATE_MIN       = parseInt(process.env.WIN_RATE_MIN    || '55');     // min win% for premium
const DATA_DIR           = process.env.DATA_DIR || path.join(__dirname, '../data');
const SUBS_FILE          = path.join(DATA_DIR, 'subscriptions.json');
const PREMIUM_SUBS_FILE  = path.join(DATA_DIR, 'premium_subs.json');

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

let subs        = loadJson(SUBS_FILE, {});        // { chatId: [address, ...] }
let premiumSubs = loadJson(PREMIUM_SUBS_FILE, []); // [chatId, ...] — manually managed

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

function polymarketLink(slug) {
  const base = slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com';
  return `${base}?via=${AFFILIATE_TAG}`;
}

// ── POLYMARKET API ───────────────────────────────────────────────────────────
async function fetchWhales() {
  try {
    const data = await fetchJson('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    const lb   = Array.isArray(data) ? data : [];
    const seen = new Set();
    const whales = [];

    for (const t of lb.slice(0, 10)) {
      const addr = (t.proxyWallet || '').toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      whales.push({
        name:    KNOWN_NAMES[addr] || t.userName || t.xUsername || addrShort(t.proxyWallet),
        address: t.proxyWallet || '',
        pnl:     Math.round(parseFloat(t.pnl || 0)),
        volume:  parseFloat(t.vol || 0),
        rank:    t.rank || '—',
      });
    }
    for (const [addr, name] of Object.entries(KNOWN_NAMES)) {
      if (seen.has(addr.toLowerCase())) continue;
      const e = lb.find(t => (t.proxyWallet || '').toLowerCase() === addr.toLowerCase());
      // Try fetching individual stats if not on leaderboard
      whales.push({ name, address: addr, pnl: e ? Math.round(parseFloat(e.pnl || 0)) : null, volume: parseFloat(e?.vol || 0), rank: e?.rank || null });
    }
    return whales;
  } catch (e) { return []; }
}

async function fetchPositions(address) {
  try {
    const data = await fetchJson(
      `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=.01&limit=15&sortBy=CURRENT&sortDirection=DESC`
    );
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

async function fetchActivity(address, limit = 8) {
  try {
    const data = await fetchJson(
      `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`
    );
    return Array.isArray(data) ? data : [];
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
    const sells = activity.filter(t => t.side === 'SELL' && parseFloat(t.price || 0) > 0);

    let wins = 0, losses = 0;
    for (const t of sells) {
      const price = parseFloat(t.price || 0);
      if (price >= 0.85)      wins++;
      else if (price <= 0.15) losses++;
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

function buildPremiumAlert(t, whale, wr) {
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  // Guard against null/NaN rank (API sometimes returns null as string or number)
  const rankValid    = whale.rank && whale.rank !== 'null' && whale.rank !== '—' && !isNaN(Number(whale.rank));
  const rankStr      = rankValid ? `#${whale.rank} on Polymarket` : 'unranked';
  // Guard against NaN P&L (parseFloat failure on missing API field)
  const safePnl      = (whale.pnl !== null && whale.pnl !== undefined && !isNaN(whale.pnl)) ? whale.pnl : null;
  const pnlSign      = (safePnl || 0) >= 0 ? '+' : '';
  const pnlStr       = safePnl !== null ? `${pnlSign}${fmtUSD(safePnl)}` : 'n/a';
  const link         = polymarketLink(t.slug);

  const wrLine = wr.rate !== null && wr.total >= 3
    ? `• Win rate: <b>${wr.rate}%</b> (${wr.total} resolved trades)`
    : `• Win rate: calculating…`;

  return [
    `⚡ <b>PREMIUM Whale Alert</b>`,
    ``,
    `<b>${t.whale}</b> just bet ${fmtUSD(t.usdcSize)}`,
    `${outcomeEmoji} <b>${t.outcome}</b> @ ${(t.price * 100).toFixed(0)}¢`,
    ``,
    `📊 <i>${t.title}</i>`,
    ``,
    `🐋 <b>This whale's track record:</b>`,
    `• Rank: <b>${rankStr}</b>`,
    `• Total P&amp;L: <b>${pnlStr}</b>`,
    wrLine,
    ``,
    `🎯 <a href="${link}">Copy this bet on Polymarket →</a>`,
    ``,
    `⏱ You're seeing this 10+ min before Twitter`,
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
  await checkTradeAlerts();
  console.log(`[WhaleTrack] ${whales.length} whales | ${Object.keys(subs).length} free subs | ${premiumSubs.length} premium`);
}

async function checkTradeAlerts() {
  try {
    const activity  = await fetchAllActivity();
    const bigTrades = activity.filter(t =>
      t.usdcSize >= TRADE_ALERT_MIN &&
      t.side === 'BUY' &&
      t.price > 0.02 && t.price < 0.98 &&   // skip resolved markets (price = 0 or 1)
      !seenTrades.has(`${t.address}-${t.timestamp}`)
    );

    for (const t of bigTrades.slice(0, 5)) {
      const key = `${t.address}-${t.timestamp}`;
      seenTrades.add(key);

      const whale = cachedWhales.find(w => w.address.toLowerCase() === t.address.toLowerCase());
      if (!whale) continue;

      // ── PREMIUM alert first (faster + richer) ──
      if (PREMIUM_CHANNEL_ID || premiumSubs.length) {
        const wr          = await fetchWinRate(t.address);
        const premiumMsg  = buildPremiumAlert(t, whale, wr);

        // Send to premium channel
        if (PREMIUM_CHANNEL_ID) {
          send(PREMIUM_CHANNEL_ID, premiumMsg, { disable_web_page_preview: false }).catch(() => {});
        }
        // Send to individual premium subscribers
        for (const chatId of premiumSubs) {
          send(chatId, premiumMsg, { disable_web_page_preview: false }).catch(() => {});
        }
      }

      // ── FREE alert (10 min delay baked in since premium fired first) ──
      const freeMsg = buildFreeAlert(t);
      for (const [chatId, addrs] of Object.entries(subs)) {
        if (addrs.includes(t.address.toLowerCase()) || addrs.length === cachedWhales.length) {
          send(chatId, freeMsg).catch(() => {});
        }
      }
    }

    if (seenTrades.size > 500) seenTrades = new Set([...seenTrades].slice(-200));
  } catch (e) {
    console.error('Trade alert check error:', e.message);
  }
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
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].replace(/^\//, '').split('@')[0].toLowerCase();
  const args  = parts.slice(1).join(' ').trim();
  const isPremium = premiumSubs.includes(String(chatId));

  switch (cmd) {

    case 'start':
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
        `• Affiliate copy-bet link in every alert`,
        `• Only high-confidence whale alerts (${WIN_RATE_MIN}%+ win rate)`,
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
        const sign = w.pnl >= 0 ? '+' : '';
        return `${i + 1}. <b>${w.name}</b> — ${sign}${fmtUSD(w.pnl)} (Rank #${w.rank})`;
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

    // ── ADMIN ONLY ─────────────────────────────────────────────────────────
    case 'addpremium': {
      // Add a user to premium (admin use only — locked to ADMIN_CHAT_ID)
      if (ADMIN_CHAT_ID && String(chatId) !== String(ADMIN_CHAT_ID)) {
        await send(chatId, '❌ Unauthorized');
        break;
      }
      if (!args) { await send(chatId, 'Usage: /addpremium &lt;chatId&gt;'); break; }
      const targetId = String(args.trim());
      if (!premiumSubs.includes(targetId)) {
        premiumSubs.push(targetId);
        saveJson(PREMIUM_SUBS_FILE, premiumSubs);
      }
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
      if (!args) { await send(chatId, 'Usage: /removepremium &lt;chatId&gt;'); break; }
      const targetId = String(args.trim());
      const idx = premiumSubs.indexOf(targetId);
      if (idx !== -1) { premiumSubs.splice(idx, 1); saveJson(PREMIUM_SUBS_FILE, premiumSubs); }
      await send(chatId, `✅ Removed ${targetId} from Premium`);
      break;
    }

    case 'stats': {
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

// ── LONG POLLING ──────────────────────────────────────────────────────────────
let offset = 0;

async function poll() {
  while (true) {
    try {
      const data = await fetchJson(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=%5B%22message%22%5D`,
        35000
      );
      for (const u of (data.result || [])) {
        offset = u.update_id + 1;
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

refreshWhales().then(() => {
  poll();
  setInterval(refreshWhales, POLL_INTERVAL);
});
