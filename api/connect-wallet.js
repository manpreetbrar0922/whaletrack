// WhaleTrack — Connect Polymarket Account
// Method 1: MetaMask → auto-derives CLOB API credentials via EIP-712 signature
// Method 2: Manual API key paste
// Credentials stored in Upstash KV (30-day TTY)

const KV_BASE  = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CLOB_HOST = 'https://clob.polymarket.com';

async function kvSet(key, value, exSeconds = 60 * 60 * 24 * 30) {
  await fetch(
    `${KV_BASE}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${exSeconds}`,
    { headers: { Authorization: `Bearer ${KV_TOKEN}` } }
  );
}

async function kvGet(key) {
  const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(decodeURIComponent(d.result)); } catch { return d.result; }
}

// Call Polymarket CLOB to derive API credentials using L1 auth headers
// (signature is the EIP-712 signed by MetaMask client-side)
async function derivePolymarketCreds(address, signature, timestamp, nonce = 0) {
  const headers = {
    'POLY_ADDRESS':   address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': String(timestamp),
    'POLY_NONCE':     String(nonce),
    'Content-Type':   'application/json',
  };
  const r = await fetch(`${CLOB_HOST}/auth/derive-api-key`, { headers });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`CLOB derive failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  return await r.json(); // { apiKey, secret, passphrase }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_BASE || !KV_TOKEN) return res.status(500).json({ error: 'KV not configured' });

  // ── GET: check if wallet already connected ────────────────────────────────
  if (req.method === 'GET') {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    const creds = await kvGet(`wt:wallet:${address.toLowerCase()}`);
    if (!creds) return res.status(200).json({ connected: false });
    return res.status(200).json({ connected: true, method: creds.method, address });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { method, address, signature, timestamp, nonce, apiKey, secret, passphrase } = req.body || {};

  if (!method || !address)
    return res.status(400).json({ error: 'method and address required' });

  const addr = address.toLowerCase();

  // ── Method 1: MetaMask — auto-derive CLOB credentials ────────────────────
  if (method === 'wallet') {
    if (!signature || !timestamp)
      return res.status(400).json({ error: 'signature and timestamp required for wallet method' });

    try {
      // Server calls CLOB to derive the API key from the MetaMask signature
      const raw = await derivePolymarketCreds(address, signature, timestamp, nonce ?? 0);

      if (!raw.apiKey || !raw.secret)
        return res.status(400).json({ error: 'Could not derive Polymarket credentials. Make sure your wallet is registered on Polymarket.' });

      await kvSet(`wt:wallet:${addr}`, {
        method:      'apikey',        // Store as apikey — we have real creds now
        address:     addr,
        apiKey:      raw.apiKey,
        secret:      raw.secret,
        passphrase:  raw.passphrase || '',
        derivedFrom: 'metamask',
        connectedAt: new Date().toISOString(),
      });

      return res.status(200).json({ ok: true, method: 'wallet', address: addr });
    } catch(e) {
      console.error('[connect-wallet] derive error:', e.message);

      // Friendly errors
      if (e.message.includes('400') || e.message.includes('not found') || e.message.includes('not registered'))
        return res.status(400).json({
          error: 'Wallet not registered on Polymarket. Please create a free account at polymarket.com first, then reconnect.',
        });
      if (e.message.includes('401') || e.message.includes('signature') || e.message.includes('auth'))
        return res.status(401).json({ error: 'Signature invalid. Please try connecting again.' });

      return res.status(500).json({ error: 'Could not connect to Polymarket. Please try again.' });
    }
  }

  // ── Method 2: Manual API key paste ───────────────────────────────────────
  if (method === 'apikey') {
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    if (apiKey.length < 10) return res.status(400).json({ error: 'Invalid API key' });

    await kvSet(`wt:wallet:${addr}`, {
      method:      'apikey',
      address:     addr,
      apiKey,
      secret:      secret     || '',
      passphrase:  passphrase || '',
      derivedFrom: 'manual',
      connectedAt: new Date().toISOString(),
    });

    return res.status(200).json({ ok: true, method: 'apikey', address: addr });
  }

  return res.status(400).json({ error: 'method must be "wallet" or "apikey"' });
}
