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
    '0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf': 'Sparkling8899',
    '0xa01c0a5e4f8c1114e95c68ee97694bc95e51766c': 'AbrahamE',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
  }

  // Fetch win rate, trade count, and top open position
  async function fetchWalletStats(address) {
    try {
      const r = await fetch(
        `https://data-api.polymarket.com/positions?user=${address}&limit=100&sortBy=CURRENT&sortDirection=DESC`
      );
      if (!r.ok) return { winRate: '—', trades: '—', topBet: null };
      const positions = await r.json();
      if (!Array.isArray(positions) || !positions.length) return { winRate: '—', trades: '—', topBet: null };

      // Won = redeemable (market resolved in their favour, shares worth $1)
      // Lost = currentValue=0 AND not redeemable (market resolved against them)
      const withInvestment = positions.filter(p => parseFloat(p.totalBought || 0) > 0);
      const won  = withInvestment.filter(p => p.redeemable === true).length;
      const lost = withInvestment.filter(p => p.currentValue === 0 && p.redeemable === false).length;
      const total = won + lost;

      const winRate = total >= 3 ? Math.round((won / total) * 100) : '—';

      // Top open bet = biggest currentValue position that's still active
      // Price filter (0.03–0.97) excludes resolved markets: lost positions sit at ~0¢,
      // won/redeemable sit at ~100¢ — only truly open markets land in this range
      const open = positions.filter(p => {
        if (p.redeemable !== false) return false;
        if (parseFloat(p.currentValue || 0) <= 1) return false;
        const px = parseFloat(p.price || p.curPrice || p.currentPrice || 0);
        return px > 0.03 && px < 0.97;
      });
      let topBet = null;
      if (open.length) {
        const top = open[0]; // already sorted by CURRENT DESC
        topBet = {
          title:   top.title || top.market || top.question || null,
          outcome: top.outcome || top.side || null,
          value:   Math.round(parseFloat(top.currentValue || 0)),
          // eventSlug works on polymarket.com/event/ — market-level slug gives 404
          slug:    top.eventSlug || top.slug || top.conditionId || null,
          price:   parseFloat(top.price || top.curPrice || top.currentPrice || 0),
        };
      }

      return { winRate, trades: withInvestment.length, topBet };
    } catch (e) {
      return { winRate: '—', trades: '—', topBet: null };
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
    const rawName = t.userName || t.xUsername || '';
    // Strip Polymarket's appended rank suffix e.g. "thif - 33063" → "thif"
    const stripped = rawName.replace(/ - \d{3,}$/, '').trim();
    const cleanName = (stripped && !stripped.startsWith('0x')) ? stripped : null;
    const displayName = knownNames[addr]
      || cleanName
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
      pnl:     e ? Math.round(parseFloat(e.pnl || 0)) : null,  // null = not on leaderboard, show — not $0
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
    topBet:  stats[i].topBet,
  }));

  res.status(200).json(whales);
}
