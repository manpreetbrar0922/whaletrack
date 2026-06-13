// Vercel serverless function — fetches recent whale activity (server-side, no CORS)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const KNOWN_NAMES = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  try {
    // Get top whale addresses from leaderboard
    const lbRes = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    const leaderboard = lbRes.ok ? await lbRes.json() : [];

    const addresses = [];
    const seen = new Set();

    for (const t of (Array.isArray(leaderboard) ? leaderboard : []).slice(0, 8)) {
      const addr = (t.proxyWallet || '').toLowerCase();
      if (addr && !seen.has(addr)) { seen.add(addr); addresses.push(t.proxyWallet); }
    }
    for (const addr of Object.keys(KNOWN_NAMES)) {
      if (!seen.has(addr.toLowerCase())) addresses.push(addr);
    }

    // Fetch recent activity for each whale in parallel
    const results = await Promise.allSettled(
      addresses.map(addr =>
        fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=8`)
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
      )
    );

    // Flatten, enrich with known names, sort by timestamp
    const all = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const t of (Array.isArray(r.value) ? r.value : [])) {
        const addr = (t.proxyWallet || '').toLowerCase();
        all.push({
          whale:     KNOWN_NAMES[addr] || t.name || t.pseudonym || addr.slice(0,8) + '…',
          address:   t.proxyWallet || '',
          side:      t.side || 'BUY',
          outcome:   t.outcome || '—',
          usdcSize:  Math.round(parseFloat(t.usdcSize || 0)),
          size:      parseFloat(t.size || 0),
          price:     parseFloat(t.price || 0),
          title:     t.title || 'Unknown Market',
          slug:      t.slug || '',
          timestamp: t.timestamp || 0,
        });
      }
    }

    // Sort by most recent, deduplicate by transactionHash equivalent (timestamp+address)
    all.sort((a, b) => b.timestamp - a.timestamp);

    // Return top 40 most recent trades
    res.status(200).json(all.slice(0, 40));
  } catch (e) {
    res.status(200).json([]);
  }
}
