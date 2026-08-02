// Vercel serverless function — whale positions grouped by sports market
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const SPORTS_KEYWORDS = [
    'nfl', 'nba', 'mlb', 'nhl', 'mls', 'ufc', 'mma', 'fifa',
    'super bowl', 'world cup', 'champions league', 'premier league',
    'championship', 'playoffs', 'world series', 'stanley cup',
    'nba finals', 'nfl draft', 'march madness', 'ncaa',
    'football', 'basketball', 'baseball', 'soccer', 'tennis',
    'golf', 'boxing', 'formula 1', 'f1', 'olympics', 'wimbledon',
    'us open', 'masters', 'pga', 'lebron', 'mahomes', 'messi',
    'ronaldo', 'warriors', 'lakers', 'yankees', 'dodgers',
    'patriots', 'chiefs', 'eagles', 'heat', 'celtics', 'bulls',
    'win the', 'advance to', 'make the playoffs', 'win the series',
    'open championship', 'tour de france', 'copa america',
    'euros', 'euro 2026', 'world cup 2026', 'nba champion',
  ];

  function isSports(title) {
    const t = (title || '').toLowerCase();
    return SPORTS_KEYWORDS.some(k => t.includes(k));
  }

  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
  }

  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    if (r.ok) leaderboard = await r.json();
  } catch (e) {}

  const seen = new Set();
  const whales = [];

  for (const t of leaderboard.slice(0, 15)) {
    const addr = (t.proxyWallet || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    whales.push({
      address: t.proxyWallet || addr,
      name: knownNames[addr] || t.userName || t.xUsername || addrShort(t.proxyWallet),
    });
  }

  for (const [addr, name] of Object.entries(knownNames)) {
    if (!seen.has(addr)) { seen.add(addr); whales.push({ address: addr, name }); }
  }

  // Fetch positions for each whale
  const marketMap = {};
  await Promise.all(whales.map(async whale => {
    try {
      const r = await fetch(`https://data-api.polymarket.com/positions?user=${whale.address}&sizeThreshold=10&limit=50`);
      if (!r.ok) return;
      const positions = await r.json();
      for (const p of (Array.isArray(positions) ? positions : [])) {
        const title = p.title || p.market || '';
        if (!isSports(title)) continue;
        const slug = p.conditionId || p.marketSlug || p.slug || '';
        const key  = slug || title;
        if (!key) continue;

        if (!marketMap[key]) {
          marketMap[key] = { title, slug, bets: [], yesValue: 0, noValue: 0, totalValue: 0 };
        }
        // Skip resolved/redeemable positions — market has already settled
        if (p.redeemable === true) continue;
        const value   = parseFloat(p.currentValue || p.value || 0);
        if (value <= 0) continue;
        const outcome = (p.outcome || '').toLowerCase() === 'yes' ? 'Yes' : 'No';
        marketMap[key].bets.push({ whale: whale.name, outcome, value });
        if (outcome === 'Yes') marketMap[key].yesValue += value;
        else                   marketMap[key].noValue  += value;
        marketMap[key].totalValue += value;
      }
    } catch(e) {}
  }));

  const markets = Object.values(marketMap)
    .filter(m => m.totalValue >= 100)
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 20);

  res.status(200).json(markets);
}
