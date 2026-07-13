// Vercel serverless function — fetches open positions for a wallet (server-side, no CORS)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) {
    res.status(400).json({ error: 'address required' });
    return;
  }

  try {
    const r = await fetch(
      `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=.01&limit=50&sortBy=CURRENT&sortDirection=DESC`
    );
    if (!r.ok) {
      res.status(200).json([]);
      return;
    }
    const raw = await r.json();
    if (!Array.isArray(raw)) { res.status(200).json([]); return; }

    // Only return positions that are still open (redeemable=false).
    // redeemable=true = already cashed out → shows as $0 rows, useless to user.
    // If wallet has redeemed everything, fall back to last 20 for history view.
    const open = raw.filter(p => p.redeemable === false);
    const result = open.length > 0 ? open : raw.slice(0, 20);
    res.status(200).json(result);
  } catch (e) {
    res.status(200).json([]);
  }
}
