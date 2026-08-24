// POST /api/add-premium
// Body: { chatId: "123456789", action: "add"|"remove" }
// Adds or removes a Telegram chat ID from the premium_subs KV set
// Protected by INTERNAL_SECRET

const KV_BASE  = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SECRET   = process.env.INTERNAL_SECRET;

async function kvCmd(cmd) {
  const r = await fetch(`${KV_BASE}/${cmd}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Auth check
  const secret = req.headers['x-internal-secret'] || req.body?.secret;
  if (SECRET && secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!KV_BASE || !KV_TOKEN) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  const { chatId, action = 'add' } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  const id = String(chatId).replace(/[^0-9\-]/g, '');
  if (!id) return res.status(400).json({ error: 'Invalid chatId' });

  try {
    if (action === 'remove') {
      await kvCmd(`srem/premium_subs/${id}`);
      console.log(`[add-premium] Removed ${id}`);
      return res.status(200).json({ ok: true, action: 'removed', chatId: id });
    } else {
      await kvCmd(`sadd/premium_subs/${id}`);
      console.log(`[add-premium] Added ${id}`);
      return res.status(200).json({ ok: true, action: 'added', chatId: id });
    }
  } catch (e) {
    console.error('[add-premium] KV error:', e.message);
    return res.status(500).json({ error: 'KV write failed' });
  }
}
