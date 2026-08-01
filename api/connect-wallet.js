// WhaleTrack — Connect Polymarket Account
// Supports: MetaMask wallet signature OR API key paste
// Stores credentials in Upstash KV

const KV_BASE  = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvSet(key, value, exSeconds = 60 * 60 * 24 * 30) {
  // Store with 30 day expiry
  await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${exSeconds}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

async function kvGet(key) {
  const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(decodeURIComponent(d.result)); } catch { return d.result; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_BASE || !KV_TOKEN) return res.status(500).json({ error: 'KV not configured' });

  // ── GET: check if wallet already connected ─────────────────────
  if (req.method === 'GET') {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    const creds = await kvGet(`wt:wallet:${address.toLowerCase()}`);
    if (!creds) return res.status(200).json({ connected: false });
    return res.status(200).json({ connected: true, method: creds.method, address });
  }

  // ── POST: save credentials ─────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).end();

  const { method, address, apiKey, secret, passphrase } = req.body || {};

  if (!method || !address) {
    return res.status(400).json({ error: 'method and address required' });
  }

  const addr = address.toLowerCase();

  // ── Method 1: MetaMask wallet connect ─────────────────────────
  if (method === 'wallet') {
    // For wallet connect, we store the address only
    // CLOB credentials will be created on first trade via Bullpen
    await kvSet(`wt:wallet:${addr}`, {
      method: 'wallet',
      address: addr,
      connectedAt: new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, method: 'wallet', address: addr });
  }

  // ── Method 2: API Key ──────────────────────────────────────────
  if (method === 'apikey') {
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

    // Validate key looks right (basic check)
    if (apiKey.length < 10) return res.status(400).json({ error: 'Invalid API key' });

    await kvSet(`wt:wallet:${addr}`, {
      method: 'apikey',
      address: addr,
      apiKey,
      secret:     secret     || '',
      passphrase: passphrase || '',
      connectedAt: new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, method: 'apikey', address: addr });
  }

  return res.status(400).json({ error: 'method must be wallet or apikey' });
}
