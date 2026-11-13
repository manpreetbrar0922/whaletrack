// Vercel serverless function — finds markets where 2+ whales agree on the same side
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  const knownNames = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
  }

  function sanitizeName(raw) {
    if (!raw) return null;
    if (/^0x[0-9a-fA-F]{8}/i.test(raw)) return null; // hex address/conditionId
    if (raw.length > 42) return null;
    return raw;
  }

  // Build whale list
  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v2/leaderboard?limit=50');
    if (r.ok) { const j = await r.json(); leaderboard = Array.isArray(j) ? j : (j.data || []); }
  } catch (e) {}

  const seen = new Set();
  const whales = [];

  for (const t of leaderboard.slice(0, 30)) {
    const addr = (t.user_id || t.proxyWallet || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    whales.push({
      address: t.user_id || t.proxyWallet || addr,
      name: knownNames[addr] || sanitizeName(t.userName) || sanitizeName(t.xUsername) || addrShort(t.proxyWallet),
    });
  }

  for (const [addr, name] of Object.entries(knownNames)) {
    if (seen.has(addr.toLowerCase())) continue;
    whales.push({ address: addr, name });
  }

  // Fetch top open positions for all whales in parallel
  const allResults = await Promise.all(whales.map(async whale => {
    try {
      const r = await fetch(
        `https://data-api.polymarket.com/v2/positions?user=${whale.address}&limit=50&sortBy=current_value&sortDirection=DESC`
      );
      if (!r.ok) return [];
      const body = await r.json();
      const positions = Array.isArray(body) ? body : (body.data || []);
      if (!positions.length) return [];

      return positions
        .filter(p => p.redeemable === false && parseFloat(p.current_value || 0) > 100)
        .slice(0, 15)
        .map(p => ({
          whaleName: whale.name,
          title: p.title || p.market || p.question || 'Unknown',
          outcome: p.outcome || p.side || '?',
          value: Math.round(parseFloat(p.current_value || 0)),
          slug: p.event_slug || p.eventSlug || p.slug || p.condition_id || p.conditionId || null,
          conditionId: p.condition_id || p.conditionId || null,
        }));
    } catch (e) { return []; }
  }));

  // Flatten and group by market + outcome
  const flat = allResults.flat();
  const marketMap = {};

  for (const pos of flat) {
    const key = pos.conditionId || pos.slug || pos.title;
    if (!marketMap[key]) {
      marketMap[key] = { title: pos.title, slug: pos.slug, yes: [], no: [] };
    }
    if (pos.outcome === 'Yes') {
      marketMap[key].yes.push({ whale: pos.whaleName, value: pos.value });
    } else if (pos.outcome === 'No') {
      marketMap[key].no.push({ whale: pos.whaleName, value: pos.value });
    }
  }

  // Find consensus — markets where 2+ whales agree on the same side
  const consensus = [];

  for (const m of Object.values(marketMap)) {
    const yesBigger = m.yes.length >= m.no.length;
    const side     = yesBigger ? 'Yes' : 'No';
    const agreeing = yesBigger ? m.yes : m.no;
    const opposing = yesBigger ? m.no  : m.yes;

    if (agreeing.length < 2) continue;

    const totalAgreeing = agreeing.reduce((s, b) => s + b.value, 0);
    const totalOpposing = opposing.reduce((s, b) => s + b.value, 0);
    const totalValue    = totalAgreeing + totalOpposing;

    // Strength label
    let strength, strengthColor;
    if (agreeing.length >= 4) {
      strength = '🚨🚨 MEGA CONSENSUS';
      strengthColor = '#ff4444';
    } else if (agreeing.length >= 3) {
      strength = '🚨 CONSENSUS';
      strengthColor = '#ff8800';
    } else {
      strength = '📊 SIGNAL';
      strengthColor = '#58a6ff';
    }

    consensus.push({
      title: m.title,
      slug: m.slug,
      side,
      agreeing,
      opposing,
      totalAgreeing,
      totalOpposing,
      totalValue,
      whaleCount: agreeing.length,
      totalWhales: whales.length,
      strength,
      strengthColor,
    });
  }

  // Sort by whale count desc, then total value desc
  consensus.sort((a, b) => b.whaleCount - a.whaleCount || b.totalAgreeing - a.totalAgreeing);

  res.status(200).json(consensus.slice(0, 8));
}
