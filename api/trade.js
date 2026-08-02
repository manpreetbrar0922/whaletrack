// WhaleTrack — Execute Trade on Polymarket
// Uses Polymarket CLOB API directly — no Bullpen CLI dependency, works on Vercel.

import { ClobClient, OrderSide, OrderType, SignatureType } from '@polymarket/clob-client';
import { ethers } from 'ethers';

const KV_BASE   = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CHAIN_ID  = 137; // Polygon

// ── KV helper ────────────────────────────────────────────────────────────────
async function kvGet(key) {
  const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(decodeURIComponent(d.result)); } catch { return d.result; }
}

// ── Market helpers ────────────────────────────────────────────────────────────
async function getMarketBySlug(slug) {
  try {
    const r = await fetch(
      `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch { return null; }
}

async function getClobTokenId(conditionId, outcome) {
  const r = await fetch(`${CLOB_HOST}/markets/${conditionId}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  const market = await r.json();
  if (!market.active || market.closed) return null;
  const tokens = market.tokens || [];
  const match  = tokens.find(t => t.outcome?.toLowerCase() === outcome.toLowerCase());
  return match ? match.token_id : null;
}

// ── Parse CLOB errors into user-friendly messages ────────────────────────────
function friendlyError(errMsg) {
  const e = (errMsg || '').toLowerCase();
  if (e.includes('balance') || e.includes('insufficient'))
    return 'Insufficient pUSD balance. Add funds to your Polymarket account first.';
  if (e.includes('closed') || e.includes('resolved') || e.includes('not active'))
    return 'This market is closed and no longer accepting bets.';
  if (e.includes('price') || e.includes('slippage') || e.includes('tick'))
    return 'Price moved too fast. Please try again.';
  if (e.includes('auth') || e.includes('unauthorized') || e.includes('forbidden'))
    return 'Authentication failed. Please reconnect your API credentials.';
  if (e.includes('no orderbook') || e.includes('no market'))
    return 'No active order book for this market right now.';
  return errMsg || 'Trade failed. Please try again.';
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  if (!KV_BASE || !KV_TOKEN)
    return res.status(500).json({ error: 'KV not configured' });

  const { address, slug, outcome, amount } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────────
  if (!address) return res.status(400).json({ error: 'Wallet address required' });
  if (!slug)    return res.status(400).json({ error: 'Market slug required' });
  if (!outcome) return res.status(400).json({ error: 'Outcome required (Yes/No)' });
  const amt = parseFloat(amount);
  if (!amount || isNaN(amt) || amt <= 0)
    return res.status(400).json({ error: 'Valid amount required' });
  if (amt < 1)    return res.status(400).json({ error: 'Minimum trade is $1' });
  if (amt > 1000) return res.status(400).json({ error: 'Maximum trade is $1,000' });

  // ── Load credentials ────────────────────────────────────────────────────────
  const creds = await kvGet(`wt:wallet:${address.toLowerCase()}`);
  if (!creds)
    return res.status(401).json({ error: 'Wallet not connected. Please connect your Polymarket account first.' });

  if (creds.method !== 'apikey') {
    return res.status(400).json({
      error: 'To trade directly from WhaleTrack you need API Key credentials. Reconnect via the API Key tab.',
      code: 'NEED_APIKEY',
      fallbackUrl: `https://polymarket.com/event/${slug}`,
    });
  }

  if (!creds.apiKey || !creds.secret)
    return res.status(401).json({ error: 'Incomplete credentials. Please reconnect via API Key.' });

  try {
    // ── Build L2 signer ───────────────────────────────────────────────────────
    // @polymarket/clob-client v5+ expects a viem-compatible WalletClient.
    // We wrap ethers v6 Wallet to match that interface.
    let l2Signer;
    try {
      const privateWallet = new ethers.Wallet(creds.secret);
      l2Signer = {
        account: { address: privateWallet.address },
        signTypedData: async ({ domain, types, message }) => {
          // ethers v6: signTypedData(domain, types, value)
          return privateWallet.signTypedData(domain, types, message);
        },
      };
    } catch {
      return res.status(401).json({ error: 'Invalid API secret. Please reconnect with correct credentials.' });
    }

    // ── Look up market ────────────────────────────────────────────────────────
    const market = await getMarketBySlug(slug);
    if (!market)
      return res.status(400).json({ error: 'Market not found. It may have been removed or renamed.' });
    if (market.closed || market.archived)
      return res.status(400).json({ error: 'This market is closed and no longer accepting bets.' });

    const conditionId = market.conditionId;
    if (!conditionId)
      return res.status(400).json({ error: 'Could not identify market condition.' });

    // ── Get CLOB token ID ─────────────────────────────────────────────────────
    const tokenId = await getClobTokenId(conditionId, outcome);
    if (!tokenId)
      return res.status(400).json({ error: `No active ${outcome} position found for this market.` });

    // ── Build CLOB client ─────────────────────────────────────────────────────
    const makerAddr = (creds.address || address).toLowerCase();
    const clob = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      l2Signer,                                               // L2 signer (viem-compatible wrapper)
      { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase || '' },
      SignatureType.EOA,                                      // Deposit Wallet = EOA
      makerAddr,                                              // funderAddress (actual wallet with funds)
    );

    // ── Create market buy order ───────────────────────────────────────────────
    // createMarketOrder auto-fetches live price + tick size from CLOB
    const order = await clob.createMarketOrder({
      tokenID: tokenId,
      amount:  amt,
      side:    OrderSide.BUY,
    });

    // ── Submit order (FOK = Fill-or-Kill for market orders) ───────────────────
    const result = await clob.postOrder(order, OrderType.FOK);

    // ── Handle CLOB response ──────────────────────────────────────────────────
    if (result.errorMsg) {
      const userMsg = friendlyError(result.errorMsg);
      const status  = userMsg.includes('Authentication') ? 401 : 400;
      if (status === 401) {
        // Creds are bad — don't leave stale entry in KV, force reconnect
        return res.status(401).json({ error: userMsg });
      }
      return res.status(status).json({ error: userMsg });
    }

    return res.status(200).json({
      ok:      true,
      message: `Successfully placed $${amt.toFixed(2)} ${outcome} bet on "${market.question || slug}"`,
      orderId: result.orderID || result.order_id,
      status:  result.status,
      sizeFilled: result.sizeFilled,
    });

  } catch(e) {
    console.error('[trade] Error:', e?.message || e);

    // Specific recognisable errors
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('invalid private key') || msg.includes('invalid arrayify') || msg.includes('invalid hex'))
      return res.status(401).json({ error: 'Invalid API secret format. Please reconnect with correct credentials.' });
    if (msg.includes('invalid price') || msg.includes('tick'))
      return res.status(400).json({ error: 'Price tick error — try again in a moment.' });
    if (msg.includes('timeout') || msg.includes('abort'))
      return res.status(504).json({ error: 'Request timed out. Polymarket may be slow — please try again.' });

    return res.status(500).json({ error: 'Trade failed. Please try again or place the bet directly on Polymarket.' });
  }
}
