// Vercel serverless function — add email to Resend audience
import { Resend } from 'resend';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.contacts.create({
      email,
      audienceId: process.env.RESEND_AUDIENCE_ID,
      unsubscribed: false,
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    // Treat duplicate as success — user is already subscribed
    if (e?.message?.toLowerCase().includes('already')) {
      return res.status(200).json({ ok: true, existing: true });
    }
    console.error('Subscribe error:', e);
    res.status(500).json({ error: 'Failed to subscribe. Please try again.' });
  }
}
