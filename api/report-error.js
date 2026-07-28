// Vercel serverless — receives JS errors from the browser, forwards to Telegram
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { message, url, line, userAgent, page } = req.body || {};
    if (!message) return res.status(400).json({ error: 'missing message' });

    const BOT_TOKEN    = process.env.BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) return res.status(200).json({ ok: true }); // silent if not configured

    // Deduplicate — skip repeat errors within same deploy
    const sig = `${message}-${line}`;
    if (recentErrors.has(sig)) return res.status(200).json({ ok: 'deduped' });
    recentErrors.add(sig);
    setTimeout(() => recentErrors.delete(sig), 10 * 60 * 1000); // forget after 10 min

    const text = [
      `🚨 <b>WhaleTrack JS Error</b>`,
      ``,
      `<code>${(message || '').slice(0, 200)}</code>`,
      ``,
      `📍 Page: ${page || url || 'unknown'}`,
      `📱 ${(userAgent || '').slice(0, 80)}`,
    ].join('\n');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML' }),
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true }); // never break the user's page
  }
}

// In-memory dedupe (per serverless instance)
const recentErrors = new Set();
