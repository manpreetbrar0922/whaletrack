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
    const data = await r.json();
    res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(200).json([]);
  }
}
