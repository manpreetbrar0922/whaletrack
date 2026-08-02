// Vercel serverless function — fetches recent whale activity (server-side, no CORS)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

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
        // Derive outcome if missing: outcomeIndex 0 = Yes, 1 = No for binary markets
        let outcome = t.outcome || '';
        if (!outcome && t.outcomeIndex !== undefined && t.outcomeIndex !== null) {
          outcome = t.outcomeIndex === 0 ? 'Yes' : t.outcomeIndex === 1 ? 'No' : '';
        }
        if (!outcome) outcome = '—';

        all.push({
          whale:     KNOWN_NAMES[addr] || t.name || t.pseudonym || addr.slice(0,8) + '…',
          address:   t.proxyWallet || '',
          side:      t.side || 'BUY',
          outcome,
          usdcSize:  Math.round(parseFloat(t.usdcSize || 0)),
          size:      parseFloat(t.size || 0),
          price:     parseFloat(t.price || 0),
          title:     t.title || 'Unknown Market',
          slug:      t.eventSlug || t.slug || '',  // eventSlug works on polymarket.com/event/, market slug gives 404
          timestamp: t.timestamp || 0,
        });
      }
    }

    // Helper: extract YYYY-MM-DD from a slug like "phi-int-2026-08-01-more-markets"
    function slugDate(slug) {
      const m = (slug || '').match(/(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    }

    // Sports/timed markets have a date in the slug. If that date was more than
    // 12 hours ago (UTC) the game/event is almost certainly over and the market
    // is resolved. Filter those out so we don't show stale "LIVE" alerts.
    const nowMs = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    const filtered = all.filter(t => {
      // Must have title and real price
      if (!t.title || t.title === 'Unknown Market' || t.price <= 0) return false;

      // Check if slug contains a past date
      const d = slugDate(t.slug);
      if (d) {
        const marketDate = new Date(d + 'T23:59:00Z').getTime(); // end of that UTC day
        if (nowMs - marketDate > TWELVE_HOURS) return false;     // resolved — skip
      }

      return true;
    });

    // Sort by most recent
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Return top 40 most recent trades
    res.status(200).json(filtered.slice(0, 40));
  } catch (e) {
    res.status(200).json([]);
  }
}
