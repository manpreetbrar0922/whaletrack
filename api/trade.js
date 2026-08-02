// WhaleTrack — Post a pre-signed Polymarket order to the CLOB API.
// The order was signed client-side by MetaMask (EIP-712). This endpoint:
//   1. Loads the user's API credentials from KV
//   2. Computes the Polymarket HMAC request signature
//   3. Proxies the signed order to clob.polymarket.com/order
//
// No private keys involved — MetaMask handles all order signing.

import crypto from 'crypto';

const KV_BASE   = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const CLOB_HOST = 'https://clob.polymarket.com';

// ── KV helper ────────────────────────────────────────────────────────────────
async function kvGet(key) {
  const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(decodeURIComponent(d.result)); } catch { return d.result; }
}

// ── Build Polymarket HMAC auth headers ───────────────────────────────────────
// HMAC-SHA256(base64Decode(apiSecret), timestamp+method+path+body), base64 encoded
function buildHmacHeaders(apiKey, apiSecret, passphrase, walletAddress, method, path, bodyStr) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = timestamp + method.toUpperCase() + path + bodyStr;

  const secretBuf = Buffer.from(apiSecret, 'base64');
  const sig       = crypto.createHmac('sha256', secretBuf)
                          .update(message)
                          .digest('base64');

  return {
    'Content-Type':   'application/json',
    'POLY_ADDRESS':   walletAddress,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY':   apiKey,
    'POLY_PASSPHRASE': passphrase || '',
  };
}

// ── Translate raw CLOB errors into readable messages ─────────────────────────
function friendlyError(errMsg) {
  const e = (errMsg || '').toLowerCase();
  if (e.includes('balance') || e.includes('insufficient') || e.includes('collateral'))
    return 'Insufficient pUSD balance. Add funds to your Polymarket account first, then try again.';
  if (e.includes('closed') || e.includes('resolved') || e.includes('not active'))
    return 'This market is closed and no longer accepting bets.';
  if (e.includes('price') || e.includes('slippage') || e.includes('tick') || e.includes('fok'))
    return 'Price moved too fast — order not filled. Please try again.';
  if (e.includes('auth') || e.includes('unauthorized') || e.includes('forbidden') || e.includes('api key'))
    return 'Authentication failed. Please reconnect your wallet.';
  if (e.includes('no orderbook') || e.includes('no market') || e.includes('no match'))
    return 'No matching orders in the book right now. Try again in a moment.';
  if (e.includes('minimum') || e.includes('min size'))
    return 'Bet is below Polymarket minimum size. Try a slightly larger amount.';
  return errMsg || 'Trade failed. Please try again.';
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  if (!KV_BASE || !KV_TOKEN)
    return res.status(500).json({ error: 'Server configuration error. Please try again later.' });

  const { signedOrder, address, orderType = 'FOK' } = req.body || {};

  if (!address)
    return res.status(400).json({ error: 'Wallet address required' });
  if (!signedOrder)
    return res.status(400).json({ error: 'Signed order required' });
  if (!signedOrder.signature)
    return res.status(400).json({ error: 'Order signature missing — please sign the order in MetaMask first' });

  // Load API credentials from KV
  const creds = await kvGet(`wt:wallet:${address.toLowerCase()}`);
  if (!creds)
    return res.status(401).json({
      error: 'Wallet not connected. Please connect your Polymarket account first.',
    });
  if (!creds.apiKey || !creds.secret)
    return res.status(401).json({
      error: 'Incomplete credentials. Please disconnect and reconnect your wallet.',
    });

  try {
    const body    = { order: signedOrder, orderType };
    const bodyStr = JSON.stringify(body);
    const path    = '/order';

    const headers = buildHmacHeaders(
      creds.apiKey,
      creds.secret,
      creds.passphrase,
      address,
      'POST',
      path,
      bodyStr,
    );

    const clobRes = await fetch(`${CLOB_HOST}${path}`, {
      method:  'POST',
      headers,
      body:    bodyStr,
      signal:  AbortSignal.timeout(15000),
    });

    let result = {};
    try { result = await clobRes.json(); } catch { /* ignore parse errors */ }

    console.log('[trade] CLOB', clobRes.status, JSON.stringify(result).slice(0, 300));

    if (result.errorMsg || result.error) {
      const rawErr = result.errorMsg || result.error || '';
      return res.status(400).json({ error: friendlyError(rawErr) });
    }

    if (!clobRes.ok) {
      return res.status(400).json({ error: `Polymarket rejected the order (HTTP ${clobRes.status}). Try again.` });
    }

    // Success
    const usdcPaid = signedOrder.makerAmount
      ? (parseInt(signedOrder.makerAmount) / 1e6).toFixed(2)
      : '?';

    return res.status(200).json({
      ok:         true,
      message:    `$${usdcPaid} bet submitted to Polymarket successfully`,
      orderId:    result.orderID || result.order_id || result.id,
      status:     result.status,
      sizeFilled: result.sizeFilled,
    });

  } catch (e) {
    console.error('[trade] Error:', e?.message || e);
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('abort'))
      return res.status(504).json({ error: 'Polymarket is slow right now — please try again in a moment.' });
    return res.status(500).json({ error: 'Trade failed. Please try again.' });
  }
}
