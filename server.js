// WhaleTrack Backend Server
// Fetches real data from Bullpen CLI and serves it to the frontend

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const BULLPEN = '/opt/homebrew/bin/bullpen';

// Cache to avoid hammering CLI
let cache = { markets: null, whales: null, lastFetch: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function bullpen(args) {
  try {
    const out = execSync(`${BULLPEN} ${args} --output json`, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(out.toString());
  } catch (e) {
    return null;
  }
}

function getMarkets() {
  const data = bullpen('polymarket discover --sort volume --limit 50');
  if (!data) return [];

  const markets = [];
  for (const event of data.events || []) {
    for (const market of event.markets || []) {
      if (!market.active || market.closed || market.resolved) continue;
      if (!market.enable_order_book) continue;
      if ((market.liquidity || 0) < 5000) continue;

      const yes = (market.outcomes || []).find(o => o.name === 'Yes');
      if (!yes) continue;

      const price = yes.price || 0;
      if (price < 0.02 || price > 0.98) continue;

      // Calculate 24h change from candles for top 15 markets only
      let change24h = 0;
      if (markets.length < 15) {
        try {
          const candles = bullpen(`polymarket candles --outcome Yes --interval 1h ${market.slug}`);
          const c = candles?.candles || [];
          if (c.length >= 24) {
            const now = parseFloat(c[c.length - 1].close || 0);
            const ago = parseFloat(c[c.length - 24].close || 0);
            if (ago > 0) change24h = (now - ago) / ago;
          }
        } catch (e) {}
      }

      markets.push({
        slug: market.slug,
        question: market.question || event.title || market.slug,
        outcome: 'Yes',
        price,
        change24h,
        volume: market.volume || 0,
        liquidity: market.liquidity || 0,
      });
    }
  }
  return markets;
}

function getWhales() {
  // Pull top traders from leaderboard
  const lb = bullpen('polymarket data leaderboard');
  const leaderboard = lb?.leaderboard || [];

  // Known tracked wallets with names
  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  // Build whale list from top 10 leaderboard + known wallets
  const seen = new Set();
  const whales = [];

  // Add top leaderboard traders
  for (const t of leaderboard.slice(0, 8)) {
    if (seen.has(t.address)) continue;
    seen.add(t.address);
    whales.push({
      name: t.username || addrShort(t.address),
      address: t.address,
      pnl: Math.round(t.pnl || 0),
      winRate: t.win_rate ? (t.win_rate * 100).toFixed(0) : '—',
      trades: t.trades_count || '—',
      volume: t.volume || 0,
      rank: t.rank,
    });
  }

  // Add known tracked wallets not already in list
  for (const [addr, name] of Object.entries(knownNames)) {
    if (seen.has(addr.toLowerCase())) continue;
    // Try to find in leaderboard
    const lb_entry = leaderboard.find(t => t.address?.toLowerCase() === addr.toLowerCase());
    whales.push({
      name,
      address: addr,
      pnl: lb_entry ? Math.round(lb_entry.pnl || 0) : 0,
      winRate: lb_entry?.win_rate ? (lb_entry.win_rate * 100).toFixed(0) : '—',
      trades: lb_entry?.trades_count || '—',
      volume: lb_entry?.volume || 0,
      rank: lb_entry?.rank || '—',
    });
  }

  return whales;
}

function addrShort(addr) {
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
}

function refreshCache() {
  console.log('[WhaleTrack] Fetching fresh data...');
  cache.markets = getMarkets();
  cache.whales = getWhales();
  cache.lastFetch = Date.now();
  console.log(`[WhaleTrack] Done. ${cache.markets.length} markets, ${cache.whales.length} whales.`);
}

const server = http.createServer((req, res) => {
  const url = req.url;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // API: markets
  if (url === '/api/markets') {
    if (!cache.markets || Date.now() - cache.lastFetch > CACHE_TTL) {
      refreshCache();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cache.markets || []));
    return;
  }

  // API: whales
  if (url === '/api/whales') {
    if (!cache.whales || Date.now() - cache.lastFetch > CACHE_TTL) {
      refreshCache();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cache.whales || []));
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, () => {
  console.log(`🐋 WhaleTrack running at http://localhost:${PORT}`);
  console.log('Pre-loading data...');
  refreshCache();
});
