// WhaleTrack — Build unsigned Polymarket order params for client-side MetaMask signing.
// Frontend calls this to get the EIP-712 typed data, signs with MetaMask, then POSTs
// the signed order to /api/trade which handles HMAC auth + CLOB proxy.

const CLOB_HOST   = 'https://clob.polymarket.com';
const GAMMA_API   = 'https://gamma-api.polymarket.com';
const CHAIN_ID    = 137; // Polygon

// CTF Exchange addresses on Polygon mainnet
const EXCHANGE     = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// EIP-712 types for Polymarket CTF Exchange orders
const ORDER_TYPES = {
  EIP712Domain: [
    { name: 'name',              type: 'string'  },
    { name: 'version',           type: 'string'  },
    { name: 'chainId',           type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMarketBySlug(slug) {
  const r = await fetch(
    `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}&limit=1`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getClobMarket(conditionId) {
  const r = await fetch(
    `${CLOB_HOST}/markets/${conditionId}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  return r.json();
}

async function getOrderbook(tokenId) {
  const r = await fetch(
    `${CLOB_HOST}/book?token_id=${tokenId}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  return r.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).end();

  const { slug, outcome, amount, address } = req.query;

  if (!slug || !outcome || !amount || !address)
    return res.status(400).json({ error: 'Required: slug, outcome, amount, address' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 1 || amt > 1000)
    return res.status(400).json({ error: 'Amount must be between $1 and $1,000' });

  // 1. Get Gamma market metadata
  const market = await getMarketBySlug(slug);
  if (!market)
    return res.status(404).json({ error: 'Market not found' });
  if (market.closed || market.archived)
    return res.status(400).json({ error: 'This market is closed and no longer accepting bets' });

  const conditionId = market.conditionId;
  if (!conditionId)
    return res.status(400).json({ error: 'Could not identify market condition' });

  // 2. Get CLOB market (token IDs + active status)
  const clobMarket = await getClobMarket(conditionId);
  if (!clobMarket || !clobMarket.active || clobMarket.closed)
    return res.status(400).json({ error: 'Market is not currently active for trading on Polymarket' });

  const tokens = clobMarket.tokens || [];
  const match  = tokens.find(t => t.outcome?.toLowerCase() === outcome.toLowerCase());
  if (!match)
    return res.status(400).json({ error: `No ${outcome} outcome found for this market` });

  const tokenId = match.token_id;

  // 3. Get live orderbook for best ask price
  const book = await getOrderbook(tokenId);
  if (!book || !book.asks || !book.asks.length)
    return res.status(400).json({ error: 'No active order book for this market right now — try again in a moment' });

  // Asks sorted ascending (lowest first) → best ask = asks[0]
  const bestAsk = parseFloat(book.asks[0].price);
  if (!bestAsk || bestAsk <= 0 || bestAsk >= 1)
    return res.status(400).json({ error: 'Invalid market price. Try again in a moment.' });

  // 4. Build order amounts (6 decimal places, USDC + outcome tokens)
  // BUY: makerAmount = USDC you pay, takerAmount = outcome tokens you receive
  // With 5% slippage tolerance so FOK fills even if price moves slightly
  const makerAmount  = Math.floor(amt * 1e6).toString();
  const maxPrice     = bestAsk * 1.05;           // accept up to 5% above best ask
  const takerAmount  = Math.floor(amt * 1e6 / maxPrice).toString();

  // Random salt (prevent replay; 15-digit random int)
  const salt = Math.floor(Math.random() * 1e15 + 1e14).toString();

  // Which exchange contract? Depends on neg-risk flag
  const isNegRisk    = market.negRisk === true || clobMarket.neg_risk === true;
  const exchangeAddr = isNegRisk ? NEG_EXCHANGE : EXCHANGE;

  // 5. Build the unsigned order struct (matches EIP-712 Order type exactly)
  const order = {
    salt,
    maker:         address,
    signer:        address,
    taker:         ZERO_ADDR,
    tokenId,
    makerAmount,
    takerAmount,
    expiration:    '0',   // no expiry — FOK fires immediately
    nonce:         '0',
    feeRateBps:    '0',   // Polymarket charges 0% fees on most markets
    side:          0,     // 0 = BUY
    signatureType: 0,     // 0 = EOA (MetaMask / Deposit Wallet)
  };

  const domain = {
    name:              'Polymarket CTF Exchange',
    version:           '1',
    chainId:           CHAIN_ID,
    verifyingContract: exchangeAddr,
  };

  return res.status(200).json({
    domain,
    types:       ORDER_TYPES,
    primaryType: 'Order',
    order,
    meta: {
      question:    market.question || market.title || slug,
      outcome,
      amount:      amt,
      bestAsk:     bestAsk.toFixed(4),
      exchangeAddr,
      isNegRisk,
    },
  });
}
