// WhaleTrack Telegram Bot
// Self-hostable — zero npm dependencies, pure Node.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN env var required'); process.exit(1); }

const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL  || '300000'); // 5 min
const PNL_THRESHOLD  = parseInt(process.env.PNL_THRESHOLD  || '1000');   // $1000
const TRADE_ALERT_MIN = parseInt(process.env.TRADE_ALERT_MIN || '5000'); // $5000 trade alert
const DATA_DIR       = process.env.DATA_DIR || '/data';
const SUBS_FILE      = path.join(DATA_DIR, 'subscriptions.json');

const KNOWN_NAMES = {
  '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
  '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
  '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
};

// ===== PERSISTENCE =====
function loadSubs() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SUBS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (e) { return {}; }
}
function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); } catch (e) {}
}

let subs = loadSubs(); // { chatId: [address, ...] }

// ===== HTTP HELPERS =====
function fetchJson(url, timeoutMs = 35000) {
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

function send(chatId, text) {
  return telegramPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

// ===== POLYMARKET API =====
function addrShort(a) { return a ? a.slice(0,6) + '…' + a.slice(-4) : ''; }

async function fetchWhales() {
  try {
    const data = await fetchJson('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    const lb = Array.isArray(data) ? data : [];
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
      whales.push({ name, address: addr, pnl: e ? Math.round(parseFloat(e.pnl || 0)) : 0, volume: parseFloat(e?.vol || 0), rank: e?.rank || '—' });
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

async function fetchAllActivity() {
  const addresses = cachedWhales.map(w => w.address).filter(Boolean);
  if (!addresses.length) return [];

  const results = await Promise.allSettled(
    addresses.map(addr => fetchActivity(addr, 5))
  );

  const all = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      const addr = (t.proxyWallet || '').toLowerCase();
      all.push({
        whale:     KNOWN_NAMES[addr] || t.name || t.pseudonym || addrShort(t.proxyWallet),
        address:   t.proxyWallet || '',
        side:      t.side || 'BUY',
        outcome:   t.outcome || '—',
        usdcSize:  Math.round(parseFloat(t.usdcSize || 0)),
        price:     parseFloat(t.price || 0),
        title:     t.title || 'Unknown Market',
        slug:      t.slug || '',
        timestamp: t.timestamp || 0,
      });
    }
  }
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all;
}

// ===== FORMATTERS =====
function fmtUSD(n) {
  n = Math.abs(parseFloat(n));
  if (n >= 1_000_000) return '$' + (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n/1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// ===== STATE =====
let cachedWhales = [];
let prevPnl = {};
let seenTrades = new Set(); // track alerted trades

// ===== WHALE MONITOR =====
async function refreshWhales() {
  console.log('[WhaleTrack] Refreshing...');
  const whales = await fetchWhales();
  if (!whales.length) return;

  // P&L alerts
  for (const whale of whales) {
    const prev = prevPnl[whale.address];
    if (prev !== undefined) {
      const diff = whale.pnl - prev;
      if (Math.abs(diff) >= PNL_THRESHOLD) {
        const emoji = diff > 0 ? '📈' : '📉';
        const sign  = diff > 0 ? '+' : '-';
        const msg = [
          `${emoji} <b>${whale.name}</b> just moved ${sign}${fmtUSD(Math.abs(diff))}`,
          `Total P&amp;L: <b>${whale.pnl >= 0 ? '+' : ''}${fmtUSD(whale.pnl)}</b>`,
          `Rank: #${whale.rank}`,
          '',
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

  // Trade alerts — check recent activity for big trades
  await checkTradeAlerts();

  console.log(`[WhaleTrack] ${whales.length} whales | ${Object.keys(subs).length} subscribers`);
}

async function checkTradeAlerts() {
  try {
    const activity = await fetchAllActivity();
    const bigTrades = activity.filter(t =>
      t.usdcSize >= TRADE_ALERT_MIN &&
      t.side === 'BUY' &&
      !seenTrades.has(`${t.address}-${t.timestamp}`)
    );

    for (const t of bigTrades.slice(0, 5)) {
      const key = `${t.address}-${t.timestamp}`;
      seenTrades.add(key);

      const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
      const msg = [
        `🐋 <b>Big Trade Alert!</b>`,
        ``,
        `<b>${t.whale}</b> just bought`,
        `${outcomeEmoji} <b>${t.outcome}</b> ${fmtUSD(t.usdcSize)} @ ${(t.price * 100).toFixed(0)}¢`,
        ``,
        `📊 <i>${t.title}</i>`,
        ``,
        `🌐 whaletrack.app`,
      ].join('\n');

      for (const [chatId, addrs] of Object.entries(subs)) {
        if (addrs.includes(t.address.toLowerCase()) || addrs.length === cachedWhales.length) {
          send(chatId, msg).catch(() => {});
        }
      }
    }

    // Keep seen set from growing forever
    if (seenTrades.size > 500) {
      seenTrades = new Set([...seenTrades].slice(-200));
    }
  } catch (e) {
    console.error('Trade alert check error:', e.message);
  }
}

// ===== COMMAND HANDLERS =====
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

  switch (cmd) {

    case 'start':
    case 'help':
      await send(chatId, [
        '🐋 <b>WhaleTrack Bot</b>',
        'Track smart money on Polymarket in real time.',
        '',
        '<b>Commands:</b>',
        '/whales — list all tracked whales + P&amp;L',
        '/positions &lt;name&gt; — see their open bets',
        '/activity — latest whale trades',
        '/activity &lt;name&gt; — trades for one whale',
        '/top — top moving markets right now',
        '/watch &lt;name&gt; — get P&amp;L + trade alerts',
        '/watchall — watch every whale',
        '/unwatch &lt;name&gt; — stop alerts for one whale',
        '/unwatch — stop all alerts',
        '/mysubs — your active subscriptions',
        '',
        'Example: <code>/positions GoalLineGhost</code>',
        '',
        '🌐 Web: https://whaletrack.app',
      ].join('\n'));
      break;

    case 'whales': {
      if (!cachedWhales.length) { await send(chatId, '⏳ Loading... try again in a moment'); break; }
      const lines = cachedWhales.map((w, i) => {
        const sign = w.pnl >= 0 ? '+' : '';
        return `${i+1}. <b>${w.name}</b> — ${sign}${fmtUSD(w.pnl)} (Rank #${w.rank})`;
      });
      await send(chatId, `🐋 <b>Tracked Whales</b>\n\n${lines.join('\n')}\n\nUse /positions &lt;name&gt; to see their bets`);
      break;
    }

    case 'positions': {
      if (!args) { await send(chatId, 'Usage: /positions &lt;whale name&gt;\nExample: /positions GoalLineGhost'); break; }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }

      await send(chatId, `⏳ Loading ${whale.name}'s positions...`);
      const positions = await fetchPositions(whale.address);

      if (!positions.length) {
        await send(chatId, `🐋 <b>${whale.name}</b>\n\nNo open positions found.`);
        break;
      }

      const lines = positions.slice(0, 10).map(p => {
        const outcome   = p.outcome || '—';
        const size      = fmtUSD(p.currentValue || p.size || 0);
        const curPrice  = parseFloat(p.currentPrice || 0);
        const pnl       = parseFloat(p.unrealizedPnl || 0);
        const pnlEmoji  = pnl > 0 ? '📈' : pnl < 0 ? '📉' : '';
        const pnlStr    = pnl !== 0 ? ` ${pnlEmoji} ${pnl > 0 ? '+' : ''}${fmtUSD(pnl)}` : '';
        const emoji     = outcome === 'Yes' ? '🟢' : outcome === 'No' ? '🔴' : '⚪';
        const title     = (p.title || p.market || 'Unknown').slice(0, 45);
        return `${emoji} <b>${outcome}</b> ${size} @ ${curPrice > 0 ? (curPrice*100).toFixed(0)+'¢' : '—'}${pnlStr}\n   <i>${title}</i>`;
      });

      await send(chatId, [
        `🐋 <b>${whale.name}</b> — Open Positions`,
        `Rank #${whale.rank} | P&amp;L: ${whale.pnl >= 0 ? '+' : ''}${fmtUSD(whale.pnl)}`,
        '',
        lines.join('\n\n'),
        '',
        '🌐 whaletrack.app',
      ].join('\n'));
      break;
    }

    case 'activity': {
      if (args) {
        // Activity for specific whale
        const whale = findWhale(args);
        if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }
        await send(chatId, `⏳ Loading ${whale.name}'s recent trades...`);
        const trades = await fetchActivity(whale.address, 10);
        if (!trades.length) { await send(chatId, `No recent trades found for <b>${whale.name}</b>`); break; }

        const lines = trades.slice(0, 8).map(t => {
          const emoji = t.side === 'BUY' ? '🟢' : '🔴';
          const outcomeEmoji = t.outcome === 'Yes' ? '✅' : t.outcome === 'No' ? '❌' : '⚪';
          return `${emoji} ${t.side} ${outcomeEmoji} <b>${t.outcome}</b> ${fmtUSD(t.usdcSize)} @ ${(t.price*100).toFixed(0)}¢ · ${timeAgo(t.timestamp)}\n   <i>${(t.title||'').slice(0,45)}</i>`;
        });
        await send(chatId, `⚡ <b>${whale.name}</b> — Recent Trades\n\n${lines.join('\n\n')}`);
      } else {
        // All whale activity
        await send(chatId, '⏳ Loading latest whale activity...');
        const all = await fetchAllActivity();
        if (!all.length) { await send(chatId, 'No recent activity found.'); break; }

        const lines = all.slice(0, 10).map(t => {
          const emoji = t.side === 'BUY' ? '🟢' : '🔴';
          const outcomeEmoji = t.outcome === 'Yes' ? '✅' : t.outcome === 'No' ? '❌' : '⚪';
          return `${emoji} <b>${t.whale}</b> ${t.side} ${outcomeEmoji} ${t.outcome} ${fmtUSD(t.usdcSize)} · ${timeAgo(t.timestamp)}\n   <i>${(t.title||'').slice(0,45)}</i>`;
        });
        await send(chatId, `⚡ <b>Live Whale Activity</b>\n\n${lines.join('\n\n')}\n\n🌐 whaletrack.app`);
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
            let prices;
            try { prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices || []); } catch(e) { continue; }
            let outcomes;
            try { outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes || []); } catch(e) { continue; }
            const yesIdx = outcomes.findIndex(o => o === 'Yes');
            if (yesIdx === -1) continue;
            const price = parseFloat(prices[yesIdx] || 0);
            const volume = parseFloat(market.volume || 0);
            const liquidity = parseFloat(market.liquidity || 0);
            if (liquidity < 5000) continue;
            markets.push({ question: market.question || event.title || '', price, volume });
          }
        }
        markets.sort((a, b) => b.volume - a.volume);
        const top = markets.slice(0, 8);
        if (!top.length) { await send(chatId, 'No market data available right now.'); break; }

        const lines = top.map((m, i) => {
          const price = (m.price * 100).toFixed(0);
          const vol = m.volume >= 1000000 ? '$' + (m.volume/1000000).toFixed(1) + 'M' : '$' + (m.volume/1000).toFixed(0) + 'K';
          return `${i+1}. <b>${(m.question||'').slice(0,45)}</b>\n   Yes: ${price}¢ | Vol: ${vol}`;
        });
        await send(chatId, `🔥 <b>Top Markets by Volume</b>\n\n${lines.join('\n\n')}\n\n🌐 whaletrack.app`);
      } catch(e) {
        await send(chatId, '❌ Failed to load markets. Try again.');
      }
      break;
    }

    case 'watch': {
      if (!args) { await send(chatId, 'Usage: /watch &lt;whale name&gt;\nExample: /watch GoalLineGhost'); break; }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>\n\nUse /whales to see all names`); break; }
      const id   = String(chatId);
      const addr = whale.address.toLowerCase();
      if (!subs[id]) subs[id] = [];
      if (!subs[id].includes(addr)) { subs[id].push(addr); saveSubs(); }
      await send(chatId, `✅ Watching <b>${whale.name}</b>\n\nYou'll be alerted when:\n• P&amp;L changes by ${fmtUSD(PNL_THRESHOLD)}+\n• They make a trade over ${fmtUSD(TRADE_ALERT_MIN)}`);
      break;
    }

    case 'watchall': {
      const id = String(chatId);
      subs[id] = cachedWhales.map(w => w.address.toLowerCase());
      saveSubs();
      await send(chatId, `✅ Watching all <b>${cachedWhales.length} whales</b>\n\nYou'll be alerted on big P&amp;L moves and large trades`);
      break;
    }

    case 'unwatch': {
      const id = String(chatId);
      if (!args) {
        subs[id] = [];
        saveSubs();
        await send(chatId, '✅ Unsubscribed from all whale alerts');
        break;
      }
      const whale = findWhale(args);
      if (!whale) { await send(chatId, `❌ Whale not found: <code>${args}</code>`); break; }
      if (subs[id]) { subs[id] = subs[id].filter(a => a !== whale.address.toLowerCase()); saveSubs(); }
      await send(chatId, `✅ Stopped watching <b>${whale.name}</b>`);
      break;
    }

    case 'mysubs': {
      const id   = String(chatId);
      const addrs = subs[id] || [];
      if (!addrs.length) { await send(chatId, '📭 No active subscriptions\n\nUse /watch &lt;name&gt; to subscribe'); break; }
      const names = addrs.map(a => {
        const w = cachedWhales.find(w => w.address.toLowerCase() === a);
        return w ? `• <b>${w.name}</b>` : `• <code>${a.slice(0,10)}…</code>`;
      });
      await send(chatId, `📬 <b>Your Subscriptions (${addrs.length})</b>\n\n${names.join('\n')}\n\nUse /unwatch &lt;name&gt; to remove`);
      break;
    }

    default:
      // Ignore unknown commands silently
  }
}

// ===== LONG POLLING =====
let offset = 0;

async function poll() {
  while (true) {
    try {
      const data = await fetchJson(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=%5B%22message%22%5D`,
        35000
      );
      const updates = data.result || [];
      for (const u of updates) {
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

// ===== START =====
console.log('🐋 WhaleTrack Bot starting...');
console.log(`   PnL alert threshold: ${fmtUSD(PNL_THRESHOLD)}`);
console.log(`   Trade alert min: ${fmtUSD(TRADE_ALERT_MIN)}`);
console.log(`   Refresh interval: ${POLL_INTERVAL / 1000}s`);

refreshWhales().then(() => {
  poll();
  setInterval(refreshWhales, POLL_INTERVAL);
});
