// Vercel serverless — fetch all open positions for a wallet, grouped by event
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  const address = (req.query.address || '').toLowerCase().trim();
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid or missing wallet address' });
  }

  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
    '0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf': 'Sparkling8899',
    '0xa01c0a5e4f8c1114e95c68ee97694bc95e51766c': 'AbrahamE',
  };

  try {
    // Fetch all positions (v2 API)
    const r = await fetch(
      `https://data-api.polymarket.com/v2/positions?user=${address}&limit=500&sortBy=current_value&sortDirection=DESC`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'WhaleTrack/1.0' } }
    );
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Failed to fetch positions', status: r.status, detail: errBody.slice(0, 200) });
    }

    const body = await r.json();
    const allPositions = Array.isArray(body) ? body : (body.data || []);
    if (!allPositions.length && body.error) return res.status(502).json({ error: 'Unexpected positions format' });

    // Open positions only: not redeemable, price in active range, value > $1
    const open = allPositions.filter(p => {
      if (p.redeemable !== false) return false;
      if (parseFloat(p.current_value || 0) <= 1) return false;
      const px = parseFloat(p.current_price || 0);
      return px > 0.03 && px < 0.97;
    });

    // Won positions awaiting redemption — must have current_value > 0
    // (in v2, lost positions also have redeemable:true but current_value:0)
    const redeemable = allPositions.filter(p => p.redeemable === true && parseFloat(p.current_value || 0) > 0);

    // Combine for display
    const relevant = [...open, ...redeemable];

    // Group by event_slug (fall back to market slug or condition_id)
    const eventMap = {};
    for (const p of relevant) {
      const slug = p.event_slug || p.slug || p.condition_id || 'unknown';
      if (!eventMap[slug]) {
        eventMap[slug] = {
          eventSlug: slug,
          eventTitle: p.event_title || deriveEventTitle(p.title || ''),
          positions:  [],
        };
      }
      eventMap[slug].positions.push({
        title:       p.title || null,
        outcome:     p.outcome || null,
        value:       Math.round(parseFloat(p.current_value || 0)),
        cost:        Math.round(parseFloat(p.entry_cost_usdc || p.total_cost_usdc || 0)),
        price:       Math.round(parseFloat(p.current_price || 0) * 100),
        avgPrice:    p.avg_price ? Math.round(parseFloat(p.avg_price) * 100) : null,
        size:        Math.round(parseFloat(p.current_size || p.total_size || 0)),
        slug:        p.slug || null,
        redeemable:  p.redeemable === true,
        firstEntry:  p.first_entry_at || null,  // unix timestamp — when position was first opened
      });
    }

    // Build event summaries
    const events = Object.values(eventMap).map(ev => {
      const totalValue = ev.positions.reduce((s, p) => s + p.value, 0);
      const totalCost  = ev.positions.reduce((s, p) => s + p.cost, 0);
      const pnl        = totalValue - totalCost;
      const outcomes   = ev.positions.map(p => (p.outcome || '').toLowerCase());
      const hasYes     = outcomes.some(o => o.includes('yes'));
      const hasNo      = outcomes.some(o => o.includes('no'));
      let exposure = 'directional';
      if (hasYes && hasNo) exposure = 'hedge';
      else if (ev.positions.length > 2) exposure = 'multi';

      return {
        eventSlug:  ev.eventSlug,
        eventTitle: ev.eventTitle,
        totalValue,
        totalCost,
        pnl,
        exposure,
        positions: ev.positions.sort((a, b) => b.value - a.value),
      };
    }).sort((a, b) => b.totalValue - a.totalValue);

    // Leaderboard lookup for P&L / volume / rank (v2)
    let leaderboardEntry = null;
    try {
      const lr = await fetch('https://data-api.polymarket.com/v2/leaderboard?limit=200');
      if (lr.ok) {
        const lb = await lr.json();
        const list = Array.isArray(lb) ? lb : (lb.data || []);
        leaderboardEntry = list.find(
          t => (t.user_id || '').toLowerCase() === address
        ) || null;
      }
    } catch (_) {}

    const displayName = knownNames[address]
      || leaderboardEntry?.user_name
      || leaderboardEntry?.x_username
      || null;

    return res.status(200).json({
      address,
      name:        displayName,
      rank:        leaderboardEntry?.rank || null,
      pnl:         leaderboardEntry ? Math.round(parseFloat(leaderboardEntry.pnl || 0)) : null,
      volume:      leaderboardEntry ? Math.round(parseFloat(leaderboardEntry.volume || 0)) : null,
      openCount:   open.length,
      totalOpen:   open.reduce((s, p) => s + parseFloat(p.current_value || 0), 0) | 0,
      events,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}

// Derive a short event title from a market title by stripping trailing detail
// e.g. "Will Trump win the 2024 presidential election?" → "2024 Presidential Election"
function deriveEventTitle(title) {
  return title
    .replace(/\?$/, '')
    .replace(/^(will|who|does|is|are|what|when|how|which)\s+/i, '')
    .replace(/\s+(win|lose|happen|be elected|be the winner|get elected|elected).*$/i, '')
    .trim()
    .slice(0, 60) || 'Unknown Event';
}
