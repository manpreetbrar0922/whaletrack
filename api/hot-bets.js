// Vercel serverless function — biggest whale bets in last 24 hours
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const MIN_SIZE_USD = 2000;  // $2K minimum bet to show
  const MAX_AGE_SEC  = 24 * 3600; // last 24 hours

  const KNOWN_NAMES = {
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
    '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
    '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
    '0x5268527977f700f9bf9b6d5cd843859e4e70135d': 'HomeRunHazard',
    '0x5dab5ed9691fab220535891d9c7f5c28eed322e1': 'Weaseloftheweek',
    '0x4bff30af91642dc7d2b19a8664378fe55c45fc26': 'Sassy-Bucket',
  };

  function addrShort(addr) {
    return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '?';
  }

  function sanitizeName(raw) {
    if (!raw) return null;
    if (/^0x[0-9a-fA-F]{8}/i.test(raw)) return null;
    if (raw.length > 42) return null;
    return raw;
  }

  // Build whale list
  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=50');
    if (r.ok) leaderboard = await r.json();
  } catch (e) {}

  const seen = new Set();
  const whales = [];

  for (const t of (Array.isArray(leaderboard) ? leaderboard : []).slice(0, 50)) {
    const addr = (t.proxyWallet || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    whales.push({
      address: t.proxyWallet || addr,
      name: KNOWN_NAMES[addr] || sanitizeName(t.userName) || sanitizeName(t.xUsername) || addrShort(t.proxyWallet),
    });
  }

  for (const [addr, name] of Object.entries(KNOWN_NAMES)) {
    if (!seen.has(addr.toLowerCase())) {
      seen.add(addr.toLowerCase());
      whales.push({ address: addr, name });
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - MAX_AGE_SEC;

  // Fetch recent activity for all whales in parallel
  const results = await Promise.allSettled(
    whales.map(whale =>
      fetch(`https://data-api.polymarket.com/activity?user=${whale.address}&limit=50`)
        .then(r => r.ok ? r.json() : [])
        .then(trades => (Array.isArray(trades) ? trades : []).map(t => ({ ...t, _whale: whale })))
        .catch(() => [])
    )
  );

  const all = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      const size = parseFloat(t.usdcSize || 0);
      const ts   = t.timestamp || 0;

      // Only BUY trades, large enough, within 24h
      if (t.side !== 'BUY' && t.type !== 'BUY') continue;
      if (size < MIN_SIZE_USD) continue;
      if (ts < cutoff) continue;
      if (!t.title || t.title === 'Unknown Market') continue;
      if (t.price <= 0) continue;

      let outcome = t.outcome || '';
      if (!outcome && t.outcomeIndex !== undefined) {
        outcome = t.outcomeIndex === 0 ? 'Yes' : t.outcomeIndex === 1 ? 'No' : '';
      }

      const addr = (t.proxyWallet || '').toLowerCase();
      all.push({
        id:        `${t._whale.name}-${ts}-${Math.round(size)}`,
        whaleName: t._whale.name,
        title:     t.title,
        outcome:   outcome || '—',
        usdcSize:  size,
        price:     parseFloat(t.price || 0),
        slug:      t.eventSlug || t.slug || '',
        timestamp: ts,
      });
    }
  }

  // Global large-bet scanner — catches ANY wallet betting ≥ $5K (not just tracked whales)
  try {
    const globalTrades = await fetch('https://data-api.polymarket.com/trades?limit=200')
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

    const MIN_GLOBAL_USD = 10000; // $10K threshold for unknown wallets (higher bar to keep quality)
    for (const t of (Array.isArray(globalTrades) ? globalTrades : [])) {
      const usdcSize = parseFloat(t.size || 0) * parseFloat(t.price || 0);
      const ts = t.timestamp || 0;

      if (t.side !== 'BUY') continue;
      if (usdcSize < MIN_GLOBAL_USD) continue;
      if (ts < cutoff) continue;
      if (!t.title || t.title === 'Unknown Market') continue;
      if ((t.price || 0) <= 0) continue;

      const addr = (t.proxyWallet || '').toLowerCase();
      // Skip if already covered by whale tracking
      if (seen.has(addr)) continue;

      const whaleName = sanitizeName(t.name) || sanitizeName(t.pseudonym) || addrShort(t.proxyWallet);
      let outcome = t.outcome || (t.outcomeIndex === 0 ? 'Yes' : t.outcomeIndex === 1 ? 'No' : '—');

      all.push({
        id:        `global-${addr}-${ts}-${Math.round(usdcSize)}`,
        whaleName: whaleName,
        title:     t.title,
        outcome:   outcome,
        usdcSize:  usdcSize,
        price:     parseFloat(t.price || 0),
        slug:      t.eventSlug || t.slug || '',
        timestamp: ts,
        isNewWhale: true,
      });
    }
  } catch (e) {}

  // Deduplicate by id, sort by size descending
  const seen2 = new Set();
  const deduped = all.filter(b => {
    if (seen2.has(b.id)) return false;
    seen2.add(b.id);
    return true;
  });

  deduped.sort((a, b) => b.usdcSize - a.usdcSize);

  res.status(200).json(deduped.slice(0, 50));
}
