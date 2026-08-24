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
const INTERNAL_SECRET       = process.env.INTERNAL_SECRET;
const KV_BASE               = process.env.KV_REST_API_URL;
const KV_TOKEN              = process.env.KV_REST_API_TOKEN;

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
// Encodes email in the link name so we can match it when they join
async function createInviteLink(customerName, email) {
  const expireDate = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const linkName   = `sub::${email}::${customerName || 'subscriber'}`.slice(0, 32); // Telegram max 32 chars
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:      PREMIUM_CHANNEL_ID,
      name:         linkName,
      expire_date:  expireDate,
      member_limit: 1, // single use
    }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result.invite_link;
}

// Kick a user from the premium channel
async function kickMember(telegramUserId) {
  // Ban then immediately unban = kick without permanent block
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: PREMIUM_CHANNEL_ID, user_id: telegramUserId }),
  });
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: PREMIUM_CHANNEL_ID, user_id: telegramUserId, only_if_banned: true }),
  });
}

// Notify admin on cancellation
async function notifyAdminCancellation(email, name, telegramUserId) {
  const kicked = telegramUserId ? '✅ Auto-kicked from channel.' : '⚠️ Telegram ID unknown — kick manually.';
  const msg = `🚫 <b>Subscription Cancelled</b>\n\n📧 ${email}\n👤 ${name || 'Unknown'}\n\n${kicked}`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: msg, parse_mode: 'HTML' }),
  });
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

  const r = await fetch('https://api.resend.com/emails', {
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

  if (!r.ok) {
    const errBody = await r.text().catch(() => '(unreadable)');
    throw new Error(`Resend ${r.status}: ${errBody}`);
  }
}

// ── KV HELPERS ────────────────────────────────────────────────────────
async function kvCmd(cmd) {
  if (!KV_BASE || !KV_TOKEN) return null;
  try {
    const r    = await fetch(`${KV_BASE}/${cmd}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const data = await r.json();
    return data.result;
  } catch { return null; }
}

// Store email → Telegram chat ID mapping (for cancellation kicks)
async function saveTelegramUserId(email, chatId) {
  await kvCmd(`set/tg:${encodeURIComponent(email)}/${chatId}`);
}

async function getTelegramUserId(email) {
  return await kvCmd(`get/tg:${encodeURIComponent(email)}`);
}

// Add/remove from premium_subs set (bot reads this)
async function addPremiumSub(chatId) {
  await kvCmd(`sadd/premium_subs/${chatId}`);
}

async function removePremiumSub(chatId) {
  await kvCmd(`srem/premium_subs/${chatId}`);
}

// Send a Telegram DM directly to the new subscriber
async function sendTelegramDM(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// Notify admin on Telegram
async function notifyAdmin(email, inviteLink, chatId) {
  const botStatus = chatId ? `✅ Bot access auto-granted (ID: ${chatId})` : `⚠️ No WhaleTrack ID entered — grant manually with /addpremium`;
  const msg = `✅ <b>New Premium Subscriber!</b>\n\n📧 ${email}\n🔗 ${inviteLink}\n\n${botStatus}\n💰 $9/mo`;
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

  // ── NEW SUBSCRIPTION ──────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session      = event.data.object;
    const email        = session.customer_details?.email || session.customer_email;
    const customerName = session.customer_details?.name || '';

    // Read WhaleTrack ID (Telegram chat ID) from Stripe custom field
    const customFields = session.custom_fields || [];
    const chatIdField  = customFields.find(f => f.key === 'whaletrackid');
    const chatId       = chatIdField?.text?.value?.replace(/[^0-9\-]/g, '') || null;

    if (!email) {
      console.error('[stripe-webhook] No email in session');
      return res.status(200).json({ received: true, error: 'No email' });
    }

    try {
      // ── If chat ID provided: grant bot access automatically ──
      if (chatId) {
        await addPremiumSub(chatId);
        await saveTelegramUserId(email, chatId);

        // Send welcome DM directly to their Telegram
        await sendTelegramDM(chatId, [
          `🎉 <b>Welcome to WhaleTrack Premium!</b>`,
          ``,
          `Your subscription is active. You now have full bot access:`,
          ``,
          `⚡ /whales — tracked whales + P&amp;L`,
          `🎯 /winrate &lt;name&gt; — win rate + track record`,
          `📊 /positions &lt;name&gt; — open bets right now`,
          `🔔 /setminbet 25000 — filter alerts by size`,
          ``,
          `Alerts will fire directly to this chat when whales bet big 🐋`,
          ``,
          `Questions? DM @manpreetbrar09 on Twitter`,
        ].join('\n'));

        console.log(`[stripe-webhook] Bot access granted to chatId ${chatId} (${email})`);
      }

      // ── Always create channel invite link + notify admin ──
      const inviteLink = await createInviteLink(customerName, email);
      await notifyAdmin(email, inviteLink, chatId);

      // ── Email the subscriber ──
      try {
        await sendInviteEmail(email, inviteLink, customerName);
        console.log(`[stripe-webhook] Invite emailed to ${email}`);
      } catch (emailErr) {
        console.error(`[stripe-webhook] Email failed for ${email}:`, emailErr.message);
        const fallbackMsg =
          `⚠️ <b>Email delivery FAILED</b>\n\n📧 ${email}\n❌ ${emailErr.message}\n\nForward invite manually:\n${inviteLink}`;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: fallbackMsg, parse_mode: 'HTML' }),
        });
      }

      return res.status(200).json({ received: true, email, chatId: chatId || 'not provided' });
    } catch (err) {
      console.error('[stripe-webhook] Error:', err.message);
      return res.status(200).json({ received: true, error: err.message });
    }
  }

  // ── CANCELLATION / PAYMENT FAILED ─────────────────────────────────
  if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
    const obj          = event.data.object;
    const customerId   = obj.customer;

    // Fetch customer email from Stripe
    let email = '', name = '';
    try {
      const r    = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      });
      const cust = await r.json();
      email = cust.email || '';
      name  = cust.name  || '';
    } catch {}

    // Look up Telegram user ID from our mapping store
    const telegramUserId = await getTelegramUserId(email);

    if (telegramUserId) {
      await kickMember(telegramUserId);           // remove from channel
      await removePremiumSub(telegramUserId);     // remove bot access
      console.log(`[stripe-webhook] Kicked + removed bot access for ${email} (tg: ${telegramUserId})`);
    }

    await notifyAdminCancellation(email, name, telegramUserId);
    return res.status(200).json({ received: true, kicked: !!telegramUserId });
  }

  return res.status(200).json({ received: true, skipped: event.type });
}
