// GET /api/premium-subs?secret=xxx
// Returns array of premium Telegram chat IDs from Vercel KV
// Protected — only callable by the bot (shared INTERNAL_SECRET)

const KV_BASE  = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SECRET   = process.env.INTERNAL_SECRET;

async function kvGet(cmd) {
  const r = await fetch(`${KV_BASE}/${cmd}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Auth check
  const secret = req.query.secret || req.headers['x-internal-secret'];
  if (SECRET && secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!KV_BASE || !KV_TOKEN) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  try {
    const members = await kvGet('smembers/premium_subs');
    return res.status(200).json({ chatIds: Array.isArray(members) ? members : [] });
  } catch (e) {
    console.error('[premium-subs] KV error:', e.message);
    return res.status(500).json({ error: 'KV read failed' });
  }
}
