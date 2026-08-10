// Vercel serverless function — whale positions grouped by Champions League market
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const CL_TERMS = [
    'champions league', 'ucl', 'cl winner', 'cl 2026', 'cl 2027',
    'champions league winner', 'champions league 2026', 'champions league 2027',
    'real madrid', 'manchester city', 'psg', 'paris saint', 'bayern munich',
    'arsenal champions', 'liverpool champions', 'barcelona champions',
    'inter milan champions', 'dortmund champions',
    'cl final', 'champions final', 'european cup',
  ];

  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
    '0x5268527977f700f9bf9b6d5cd843859e4e70135d': 'HomeRunHazard',
    '0x5dab5ed9691fab220535891d9c7f5c28eed322e1': 'Weaseloftheweek',
    '0x4bff30af91642dc7d2b19a8664378fe55c45fc26': 'Sassy-Bucket',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
  }

  // Build whale list (leaderboard top 20)
  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=50');
    if (r.ok) leaderboard = await r.json();
  } catch (e) {}

  const seen = new Set();
  const whales = [];

  for (const t of leaderboard.slice(0, 30)) {
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

  // Fetch open CL positions for all whales in parallel
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
          return CL_TERMS.some(t => title.includes(t))
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
      const yesValue   = m.bets.filter(b => b.outcome === 'Yes').reduce((s, b) => s + b.value, 0);
      const noValue    = m.bets.filter(b => b.outcome === 'No').reduce((s, b) => s + b.value, 0);
      const totalValue = m.bets.reduce((s, b) => s + b.value, 0);
      return { ...m, yesValue, noValue, totalValue };
    })
    .sort((a, b) => b.totalValue - a.totalValue);

  res.status(200).json(result);
}
