// Vercel serverless function — fetches Polymarket leaderboard server-side (no CORS issues)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
  }

  let leaderboard = [];
  const urls = [
    'https://data-api.polymarket.com/leaderboard?window=1m&limit=10',
    'https://data-api.polymarket.com/leaderboard?window=monthly&limit=10',
    'https://data-api.polymarket.com/leaderboard',
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        leaderboard = Array.isArray(data) ? data : (data.leaderboard || []);
        if (leaderboard.length > 0) break;
      }
    } catch (e) {}
  }

  const seen = new Set();
  const whales = [];

  // Top leaderboard traders
  for (const t of leaderboard.slice(0, 8)) {
    const addr = (t.proxyWallet || t.address || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const displayAddr = t.proxyWallet || t.address || '';
    whales.push({
      name:    knownNames[addr] || t.name || t.username || addrShort(displayAddr),
      address: displayAddr,
      pnl:     Math.round(parseFloat(t.pnl || t.profitAndLoss || 0)),
      winRate: t.percentPositive != null
               ? (parseFloat(t.percentPositive) * 100).toFixed(0) : '—',
      trades:  t.tradesCount || '—',
      volume:  parseFloat(t.volume || 0),
      rank:    t.rank || '—',
    });
  }

  // Add known wallets not already included
  for (const [addr, name] of Object.entries(knownNames)) {
    if (seen.has(addr.toLowerCase())) continue;
    const e = leaderboard.find(t =>
      (t.proxyWallet || t.address || '').toLowerCase() === addr.toLowerCase()
    );
    whales.push({
      name,
      address: addr,
      pnl:     e ? Math.round(parseFloat(e.pnl || e.profitAndLoss || 0)) : 0,
      winRate: e?.percentPositive != null
               ? (parseFloat(e.percentPositive) * 100).toFixed(0) : '—',
      trades:  e?.tradesCount || '—',
      volume:  parseFloat(e?.volume || 0),
      rank:    e?.rank || '—',
    });
  }

  res.status(200).json(whales);
}
