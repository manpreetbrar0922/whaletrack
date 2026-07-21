// Stripe webhook — auto-joins paying subscribers to WhaleTrack Premium Telegram channel
// Triggered by Stripe on checkout.session.completed (Payment Link purchase)
//
// Required env vars (set in Vercel dashboard):
//   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard > Webhooks > signing secret
//   BOT_TOKEN              — Telegram bot token
//   PREMIUM_CHANNEL_ID     — Telegram channel ID (e.g. -1004351425636)
//   RESEND_API_KEY         — for sending the invite link email
//   ADMIN_CHAT_ID          — your Telegram ID for admin notifications

import crypto from 'crypto';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BOT_TOKEN             = process.env.BOT_TOKEN;
const PREMIUM_CHANNEL_ID    = process.env.PREMIUM_CHANNEL_ID || '-1004351425636';
const RESEND_API_KEY        = process.env.RESEND_API_KEY;
const ADMIN_CHAT_ID         = process.env.ADMIN_CHAT_ID || '7660826549';

// Read raw body from request stream (needed for Stripe signature verification)
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Verify Stripe webhook signature
function verifyStripeSignature(rawBody, signature, secret) {
  try {
    const parts    = signature.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const sig       = parts['v1'];
    if (!timestamp || !sig) return false;

    const payload  = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Generate a single-use Telegram invite link (expires in 24h)
async function createInviteLink(customerName) {
  const expireDate = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:      PREMIUM_CHANNEL_ID,
      name:         `Premium — ${customerName || 'subscriber'}`,
      expire_date:  expireDate,
      member_limit: 1, // single use
    }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result.invite_link;
}

// Send invite link email via Resend
async function sendInviteEmail(email, inviteLink, customerName) {
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;padding:32px;border-radius:12px;max-width:520px;margin:0 auto">
      <div style="font-size:32px;margin-bottom:8px">🐋</div>
      <h1 style="color:#e6edf3;font-size:22px;margin:0 0 8px">Welcome to WhaleTrack Premium!</h1>
      <p style="color:#8b949e;font-size:14px;margin:0 0 24px">Hi${customerName ? ' ' + customerName : ''}! Your subscription is active. Click below to join the private Telegram channel.</p>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:13px;color:#8b949e;margin-bottom:12px">You'll get inside the channel:</div>
        <div style="font-size:13px;color:#e6edf3;margin-bottom:6px">⚡ Real-time alerts for bets over $5K</div>
        <div style="font-size:13px;color:#e6edf3;margin-bottom:6px">🏆 Whale rank + win rate on every alert</div>
        <div style="font-size:13px;color:#e6edf3;margin-bottom:6px">💰 P&L context so you know who to trust</div>
        <div style="font-size:13px;color:#e6edf3">🎯 Copy-bet links — 10+ min before Twitter</div>
      </div>

      <a href="${inviteLink}" style="display:block;background:#2563eb;color:#fff;text-align:center;padding:14px;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:16px">
        Join WhaleTrack Premium on Telegram →
      </a>

      <p style="color:#484f58;font-size:11px;text-align:center;margin:0">
        This invite link is single-use and expires in 24 hours.<br>
        Questions? Reply to this email or DM @manpreetbrar09 on Twitter.
      </p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'WhaleTrack Premium <alerts@whaletrack.app>',
      to:      email,
      subject: '🐋 Your WhaleTrack Premium Telegram invite is here',
      html,
    }),
  });
}

// Notify admin on Telegram
async function notifyAdmin(email, inviteLink) {
  const msg = `✅ <b>New Premium Subscriber!</b>\n\n📧 ${email}\n🔗 ${inviteLink}\n\n💰 $9/mo — manual kick needed if they cancel`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: msg, parse_mode: 'HTML' }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody  = await getRawBody(req);
  const signature = req.headers['stripe-signature'];

  // Verify webhook signature
  if (STRIPE_WEBHOOK_SECRET && signature) {
    if (!verifyStripeSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET)) {
      console.error('[stripe-webhook] Invalid signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Only handle completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, skipped: event.type });
  }

  const session      = event.data.object;
  const email        = session.customer_details?.email || session.customer_email;
  const customerName = session.customer_details?.name || '';

  if (!email) {
    console.error('[stripe-webhook] No email in session');
    return res.status(200).json({ received: true, error: 'No email' });
  }

  try {
    const inviteLink = await createInviteLink(customerName);
    await Promise.all([
      sendInviteEmail(email, inviteLink, customerName),
      notifyAdmin(email, inviteLink),
    ]);
    console.log(`[stripe-webhook] Invite sent to ${email}`);
    return res.status(200).json({ received: true, email });
  } catch (err) {
    console.error('[stripe-webhook] Error:', err.message);
    // Still return 200 so Stripe doesn't retry — log the error
    return res.status(200).json({ received: true, error: err.message });
  }
}
