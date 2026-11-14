// Vercel serverless function — fetches Polymarket leaderboard server-side (no CORS issues)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

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
      const BASE = `https://data-api.polymarket.com/v2/positions?user=${address}&limit=500&sizeThreshold=0`;

      // Two parallel fetches:
      //   1. sorted by current_value DESC → catches big open bets (for topBet)
      //   2. sorted by end_date DESC      → catches recently resolved positions (for WR)
      // Merging both gives a full picture for whales with 1000+ positions where
      // a single value-sorted fetch misses all the zero-value resolved losses.
      const [r1, r2] = await Promise.all([
        fetch(`${BASE}&sortBy=current_value&sortDirection=DESC`),
        fetch(`${BASE}&sortBy=end_date&sortDirection=DESC`),
      ]);

      const parse = async r => {
        if (!r.ok) return [];
        const b = await r.json();
        return Array.isArray(b) ? b : (b.data || []);
      };
      const [p1, p2] = await Promise.all([parse(r1), parse(r2)]);

      // Merge + dedupe by condition_id (unique position key)
      const seen = new Set();
      const positions = [];
      for (const p of [...p1, ...p2]) {
        const key = p.condition_id || p.market || (p.title + p.outcome);
        if (!seen.has(key)) { seen.add(key); positions.push(p); }
      }

      if (!positions.length) return { winRate: '—', trades: '—', topBet: null, pendingRedeems: 0, realizedPct: null, inactive: true };

      // Skip wallets whose most recent position has an end_date before 2024 — these are
      // ancient/inactive traders (e.g. 2021 Polymarket era) not worth showing to users
      const mostRecent = p1[0] || positions[0];
      const endDate = mostRecent?.end_date || '';
      const endYear = endDate ? parseInt(endDate.slice(0, 4)) : 9999;
      if (endYear < 2024) return { winRate: '—', trades: '—', topBet: null, pendingRedeems: 0, realizedPct: null, inactive: true };

      // Won = redeemable AND current_value > 0 (in v2, lost positions also have redeemable:true but value=0)
      // Lost = current_value=0 (market resolved against them, worth nothing)
      const withInvestment = positions.filter(p => parseFloat(p.entry_cost_usdc || p.total_cost_usdc || 0) > 0);
      const won  = withInvestment.filter(p => p.redeemable === true && parseFloat(p.current_value || 0) > 0).length;
      const lost = withInvestment.filter(p => parseFloat(p.current_value || 0) === 0 && parseFloat(p.current_price || 0) === 0).length;
      const total = won + lost;

      const winRate = total >= 3 ? Math.round((won / total) * 100) : '—';

      // Top open bet = biggest current_value position that's still active.
      // Use p1 (value-sorted) so we always find the highest-value open bet.
      // Price filter (0.03–0.97) excludes resolved markets: lost positions sit at ~0¢,
      // won/redeemable sit at ~100¢ — only truly open markets land in this range.
      const open = p1.filter(p => {
        if (p.redeemable !== false) return false;
        if (parseFloat(p.current_value || 0) <= 1) return false;
        const px = parseFloat(p.current_price || 0);
        return px > 0.03 && px < 0.97;
      });
      let topBet = null;
      if (open.length) {
        const top = open[0]; // already sorted by current_value DESC
        topBet = {
          title:     top.title || null,
          outcome:   top.outcome || null,
          value:     Math.round(parseFloat(top.current_value || 0)),
          // event_slug works on polymarket.com/event/ — market-level slug gives 404
          slug:      top.event_slug || top.slug || top.condition_id || null,
          price:     parseFloat(top.current_price || 0),
          enteredAt: top.first_entry_at || top.last_event_at || null,
        };
      }

      // True P&L: sum profit from won positions not yet cashed out (value > 0)
      const pendingRedeems = Math.round(
        withInvestment
          .filter(p => p.redeemable === true && parseFloat(p.current_value || 0) > 0)
          .reduce((sum, p) => {
            const val  = parseFloat(p.current_value || 0);
            const cost = parseFloat(p.entry_cost_usdc || p.total_cost_usdc || 0);
            return sum + Math.max(0, val - cost);
          }, 0)
      );

      // Realized % = won (locked-in) value vs open (still riding) value
      const realizedValue = withInvestment
        .filter(p => p.redeemable === true && parseFloat(p.current_value || 0) > 0)
        .reduce((sum, p) => sum + parseFloat(p.current_value || 0), 0);
      const openValue = withInvestment
        .filter(p => p.redeemable === false && parseFloat(p.current_value || 0) > 1)
        .reduce((sum, p) => sum + parseFloat(p.current_value || 0), 0);
      const totalValue = realizedValue + openValue;
      const realizedPct = totalValue > 0 ? Math.round((realizedValue / totalValue) * 100) : null;

      return { winRate, trades: withInvestment.length, topBet, pendingRedeems, realizedPct };
    } catch (e) {
      return { winRate: '—', trades: '—', topBet: null, pendingRedeems: 0, realizedPct: null };
    }
  }

  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v2/leaderboard?limit=50');
    if (r.ok) {
      const body = await r.json();
      leaderboard = Array.isArray(body) ? body : (body.data || []);
    }
  } catch (e) {}

  const seen = new Set();
  const whaleBase = [];

  // Top leaderboard traders
  for (const t of leaderboard.slice(0, 30)) {
    const addr = (t.user_id || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const rawName = (t.user_name || t.x_username || '').replace(/ - \d{3,}$/, '').trim();
    // Reject hex addresses / conditionIds used as display names
    const cleanName = (rawName && !/^0x[0-9a-fA-F]{8}/i.test(rawName) && rawName.length <= 42) ? rawName : null;
    const displayName = knownNames[addr]
      || cleanName
      || addrShort(t.user_id);
    whaleBase.push({
      name:    displayName,
      address: t.user_id || '',
      pnl:     Math.round(parseFloat(t.pnl || 0)),
      volume:  parseFloat(t.volume || 0),
      rank:    t.rank || '—',
    });
  }

  // Add known wallets not already in leaderboard top
  for (const [addr, name] of Object.entries(knownNames)) {
    if (seen.has(addr.toLowerCase())) continue;
    const e = leaderboard.find(t =>
      (t.user_id || '').toLowerCase() === addr.toLowerCase()
    );
    whaleBase.push({
      name,
      address: addr,
      pnl:     e ? Math.round(parseFloat(e.pnl || 0)) : null,  // null = not on leaderboard, show — not $0
      volume:  parseFloat(e?.volume || 0),
      rank:    e?.rank || '—',
    });
  }

  // Fetch win rate + trade count for all whales in parallel
  const stats = await Promise.all(whaleBase.map(w => fetchWalletStats(w.address)));

  // Filter out inactive wallets (last trade before 2024) — they show dead links and old data
  const whales = whaleBase
    .map((w, i) => ({
      ...w,
      winRate:        stats[i].winRate,
      trades:         stats[i].trades,
      topBet:         stats[i].topBet,
      pendingRedeems: stats[i].pendingRedeems || 0,
      realizedPct:    stats[i].realizedPct,
      // truePnl = leaderboard P&L + uncashed winning positions
      truePnl: w.pnl !== null && w.pnl !== undefined
        ? Math.round(w.pnl + (stats[i].pendingRedeems || 0))
        : null,
      _inactive: stats[i].inactive,
    }))
    .filter(w => !w._inactive)
    .map(({ _inactive, ...w }) => w);

  res.status(200).json(whales);
}
