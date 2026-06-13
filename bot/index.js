// WhaleTrack Telegram Bot
// Self-hostable — zero npm dependencies, pure Node.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN env var required'); process.exit(1); }

const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL  || '300000'); // 5 min
const PNL_THRESHOLD  = parseInt(process.env.PNL_THRESHOLD  || '1000');   // $1000
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

// ===== FORMATTERS =====
function fmtUSD(n) {
  n = Math.abs(parseFloat(n));
  if (n >= 1_000_000) return '$' + (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n/1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

// ===== STATE =====
let cachedWhales = [];
let prevPnl = {};

// ===== WHALE MONITOR =====
async function refreshWhales() {
  console.log('[WhaleTrack] Refreshing...');
  const whales = await fetchWhales();
  if (!whales.length) return;

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
  console.log(`[WhaleTrack] ${whales.length} whales | ${Object.keys(subs).length} subscribers`);
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
        '/watch &lt;name&gt; — get P&amp;L alerts',
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
        const pnlStr    = pnl !== 0 ? ` (${pnl > 0 ? '+' : ''}${fmtUSD(pnl)})` : '';
        const emoji     = outcome === 'Yes' ? '🟢' : outcome === 'No' ? '🔴' : '⚪';
        const title     = (p.title || p.market || 'Unknown').slice(0, 42);
        return `${emoji} <b>${outcome}</b> ${size} @ ${curPrice > 0 ? (curPrice*100).toFixed(0)+'¢' : '—'}${pnlStr}\n   <i>${title}</i>`;
      });

      await send(chatId, [
        `🐋 <b>${whale.name}</b> — Open Positions`,
        `Rank #${whale.rank} | P&amp;L: ${whale.pnl >= 0 ? '+' : ''}${fmtUSD(whale.pnl)}`,
        '',
        lines.join('\n\n'),
      ].join('\n'));
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
      await send(chatId, `✅ Watching <b>${whale.name}</b>\n\nYou'll be alerted when their P&amp;L changes by ${fmtUSD(PNL_THRESHOLD)}+`);
      break;
    }

    case 'watchall': {
      const id = String(chatId);
      subs[id] = cachedWhales.map(w => w.address.toLowerCase());
      saveSubs();
      await send(chatId, `✅ Watching all <b>${cachedWhales.length} whales</b>\n\nYou'll be alerted on any big P&amp;L move`);
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
console.log(`   Refresh interval: ${POLL_INTERVAL / 1000}s`);

refreshWhales().then(() => {
  poll();
  setInterval(refreshWhales, POLL_INTERVAL);
});
