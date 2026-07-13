// Vercel serverless function — whale positions grouped by World Cup market
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const WC_TERMS = [
    'world cup', 'fifa', '2026 world cup', 'world cup 2026',
    'round of 16', 'knockout', 'group stage', 'quarterfinal',
    'semifinal', 'world cup winner', 'world cup champion',
  ];

  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
  }

  // Build whale list (leaderboard top 10 + known wallets)
  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    if (r.ok) leaderboard = await r.json();
  } catch (e) {}

  const seen = new Set();
  const whales = [];

  for (const t of leaderboard.slice(0, 10)) {
    const addr = (t.proxyWallet || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    whales.push({
      address: t.proxyWallet || addr,
      name: knownNames[addr] || t.userName || t.xUsername || addrShort(t.proxyWallet),
    });
  }

  for (const [addr, name] of Object.entries(knownNames)) {
    if (seen.has(addr.toLowerCase())) continue;
    whales.push({ address: addr, name });
  }

  // Fetch open WC positions for all whales in parallel
  const allResults = await Promise.all(whales.map(async whale => {
    try {
      const r = await fetch(
        `https://data-api.polymarket.com/positions?user=${whale.address}&limit=100&sortBy=CURRENT&sortDirection=DESC`
      );
      if (!r.ok) return [];
      const positions = await r.json();
      if (!Array.isArray(positions)) return [];

      return positions
        .filter(p => {
          const title = (p.title || p.market || p.question || '').toLowerCase();
          return WC_TERMS.some(t => title.includes(t))
            && p.redeemable === false
            && parseFloat(p.currentValue || 0) > 1;
        })
        .map(p => ({
          whaleName: whale.name,
          whaleAddr: whale.address,
          title: p.title || p.market || p.question || 'Unknown',
          outcome: p.outcome || p.side || '?',
          value: Math.round(parseFloat(p.currentValue || 0)),
          slug: p.eventSlug || p.slug || p.conditionId || null,
          conditionId: p.conditionId || null,
        }));
    } catch (e) { return []; }
  }));

  // Flatten and group by market
  const flat = allResults.flat();
  const marketMap = {};

  for (const pos of flat) {
    const key = pos.conditionId || pos.slug || pos.title;
    if (!marketMap[key]) {
      marketMap[key] = { title: pos.title, slug: pos.slug, bets: [] };
    }
    marketMap[key].bets.push({
      whale: pos.whaleName,
      outcome: pos.outcome,
      value: pos.value,
    });
  }

  const result = Object.values(marketMap)
    .map(m => {
      const yesValue = m.bets.filter(b => b.outcome === 'Yes').reduce((s, b) => s + b.value, 0);
      const noValue  = m.bets.filter(b => b.outcome === 'No').reduce((s, b) => s + b.value, 0);
      const totalValue = m.bets.reduce((s, b) => s + b.value, 0);
      return { ...m, yesValue, noValue, totalValue };
    })
    .sort((a, b) => b.totalValue - a.totalValue);

  res.status(200).json(result);
}
