// Vercel serverless function — fetches Polymarket leaderboard server-side (no CORS issues)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // Known tracked wallets (may not be in top 50 leaderboard)
  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
  }

  // Fetch win rate and trade count from positions
  async function fetchWalletStats(address) {
    try {
      const r = await fetch(
        `https://data-api.polymarket.com/positions?user=${address}&limit=50&sortBy=INITIAL&sortDirection=DESC`
      );
      if (!r.ok) return { winRate: '—', trades: '—' };
      const positions = await r.json();
      if (!Array.isArray(positions) || !positions.length) return { winRate: '—', trades: positions.length || '—' };

      // Only count closed positions (currentValue = 0) with nonzero investment
      const closed = positions.filter(p => p.currentValue === 0 && parseFloat(p.totalBought || 0) > 0);
      if (!closed.length) return { winRate: '—', trades: positions.length };

      // Use cashPnl for win determination (covers negative risk markets too)
      const wins = closed.filter(p => parseFloat(p.cashPnl || p.realizedPnl || 0) > 0).length;
      // Only show win rate if we have enough closed positions
      const winRateNum = closed.length >= 3 ? Math.round((wins / closed.length) * 100) : 0;
      const winRate = winRateNum > 0 ? winRateNum : '—';

      return { winRate, trades: positions.length };
    } catch (e) {
      return { winRate: '—', trades: '—' };
    }
  }

  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    if (r.ok) {
      leaderboard = await r.json();
    }
  } catch (e) {}

  const seen = new Set();
  const whaleBase = [];

  // Top leaderboard traders
  for (const t of leaderboard.slice(0, 10)) {
    const addr = (t.proxyWallet || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const displayName = knownNames[addr]
      || t.userName
      || t.xUsername
      || addrShort(t.proxyWallet);
    whaleBase.push({
      name:    displayName,
      address: t.proxyWallet || '',
      pnl:     Math.round(parseFloat(t.pnl || 0)),
      volume:  parseFloat(t.vol || 0),
      rank:    t.rank || '—',
    });
  }

  // Add known wallets not already in leaderboard top
  for (const [addr, name] of Object.entries(knownNames)) {
    if (seen.has(addr.toLowerCase())) continue;
    const e = leaderboard.find(t =>
      (t.proxyWallet || '').toLowerCase() === addr.toLowerCase()
    );
    whaleBase.push({
      name,
      address: addr,
      pnl:     e ? Math.round(parseFloat(e.pnl || 0)) : 0,
      volume:  parseFloat(e?.vol || 0),
      rank:    e?.rank || '—',
    });
  }

  // Fetch win rate + trade count for all whales in parallel
  const stats = await Promise.all(whaleBase.map(w => fetchWalletStats(w.address)));

  const whales = whaleBase.map((w, i) => ({
    ...w,
    winRate: stats[i].winRate,
    trades:  stats[i].trades,
  }));

  res.status(200).json(whales);
}
