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

    const nowMs   = Date.now();
    const nowSec  = Math.floor(nowMs / 1000);
    const MONTH_NAMES = {
      jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
      jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
      january:1, february:2, march:3, april:4, june:6, july:7,
      august:8, september:9, october:10, november:11, december:12,
    };

    // Extract the earliest date mentioned in a slug or title.
    // Returns a Date if a past date is found, null otherwise.
    function findPastDate(slug, title) {
      const nowYear = new Date().getUTCFullYear();

      // 1. YYYY-MM-DD in slug (sports markets)
      const slugMatch = (slug || '').match(/(\d{4}-\d{2}-\d{2})/);
      if (slugMatch) {
        const d = new Date(slugMatch[1] + 'T23:59:00Z');
        if (d < new Date(nowMs)) return d;
      }

      // 2. "Month Day" or "Month Day," in title — e.g. "on July 17?" "before August 1"
      const titleMatch = (title || '').match(
        /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\b/i
      );
      if (titleMatch) {
        const mon = MONTH_NAMES[(titleMatch[1] || '').toLowerCase()];
        const day = parseInt(titleMatch[2], 10);
        if (mon && day) {
          // First assume current year; if that date is in the future, try previous year
          let d = new Date(Date.UTC(nowYear, mon - 1, day, 23, 59, 0));
          if (d > new Date(nowMs)) d = new Date(Date.UTC(nowYear - 1, mon - 1, day, 23, 59, 0));
          if (d < new Date(nowMs)) return d;
        }
      }

      return null;
    }

    // Markets with a past date in slug/title are resolved — remove them.
    // Also drop trades older than 10 days (stale regardless of market type).
    const TEN_DAYS_SEC = 10 * 24 * 3600;
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

    const filtered = all.filter(t => {
      // Must have title and real price
      if (!t.title || t.title === 'Unknown Market' || t.price <= 0) return false;

      // Drop trades older than 10 days
      if (t.timestamp && nowSec - t.timestamp > TEN_DAYS_SEC) return false;

      // Drop if a past date is found in slug or title (market resolved)
      const pastDate = findPastDate(t.slug, t.title);
      if (pastDate && nowMs - pastDate.getTime() > TWELVE_HOURS_MS) return false;

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
