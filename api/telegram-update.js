// Telegram bot webhook — captures when someone joins the premium channel
// Stores email → Telegram user ID mapping so we can auto-kick on cancellation
//
// Required env vars:
//   BOT_TOKEN, PREMIUM_CHANNEL_ID, ADMIN_CHAT_ID
//   KV_REST_API_URL, KV_REST_API_TOKEN (Vercel KV for mapping storage)

const BOT_TOKEN          = process.env.BOT_TOKEN;
const PREMIUM_CHANNEL_ID = process.env.PREMIUM_CHANNEL_ID || '-1004351425636';
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID      || '7660826549';
const KV_BASE            = process.env.KV_REST_API_URL;
const KV_TOKEN           = process.env.KV_REST_API_TOKEN;

async function saveTelegramUserId(email, userId) {
  if (!KV_BASE || !KV_TOKEN) return;
  try {
    await fetch(`${KV_BASE}/set/tg:${encodeURIComponent(email)}/${userId}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
  } catch {}
}

async function notifyAdmin(msg) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: msg, parse_mode: 'HTML' }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let update;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    update = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return res.status(400).end();
  }

  // We care about chat_member updates (someone joining the channel)
  const chatMember = update.chat_member;
  if (!chatMember) return res.status(200).json({ ok: true });

  const chatId     = String(chatMember.chat?.id);
  const newMember  = chatMember.new_chat_member;
  const inviteLink = chatMember.invite_link;

  // Only care about our premium channel joins
  if (chatId !== String(PREMIUM_CHANNEL_ID)) return res.status(200).json({ ok: true });

  // Only care about new members (status: member)
  if (newMember?.status !== 'member') return res.status(200).json({ ok: true });

  const userId   = newMember?.user?.id;
  const username = newMember?.user?.username || newMember?.user?.first_name || 'unknown';
  const linkName = inviteLink?.name || ''; // e.g. "sub::email@x.com::John"

  // Extract email from invite link name (format: sub::email::name)
  const emailMatch = linkName.match(/^sub::([^:]+)::/);
  const email      = emailMatch ? emailMatch[1] : null;

  if (email && userId) {
    await saveTelegramUserId(email, userId);
    await notifyAdmin(`✅ <b>Premium member joined!</b>\n\n👤 @${username} (ID: ${userId})\n📧 ${email}\n\n🔗 Mapped for auto-kick on cancellation.`);
    console.log(`[telegram-update] Mapped ${email} → ${userId}`);
  } else {
    // Unknown join — notify admin to manually note the mapping
    await notifyAdmin(`⚠️ <b>New channel member</b>\n\n👤 @${username} (ID: ${userId})\n📧 Email unknown — link name: "${linkName}"\n\nManually map if needed.`);
  }

  return res.status(200).json({ ok: true });
}
