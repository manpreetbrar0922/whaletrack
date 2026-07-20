// Vercel serverless function — daily whale digest email
// Triggered by Vercel cron: 0 14 * * * (8 AM MDT / 2 PM UTC)
import { Resend } from 'resend';

const KNOWN_NAMES = {
  '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
  '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
  '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  '0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf': 'Sparkling8899',
  '0xa01c0a5e4f8c1114e95c68ee97694bc95e51766c': 'AbrahamE',
};

function addrShort(addr) {
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
}

function fmtUSD(n) {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + Math.round(n / 1_000) + 'K';
  return '$' + Math.round(n);
}

function reliabilityGrade(wr, trades) {
  if (wr === '—' || trades < 5)         return { grade: 'NEW', color: '#8b949e' };
  if (wr >= 70 && trades >= 20)         return { grade: 'A+',  color: '#00ff88' };
  if (wr >= 65 && trades >= 10)         return { grade: 'A',   color: '#3fb950' };
  if (wr >= 55 && trades >= 5)          return { grade: 'B',   color: '#58a6ff' };
  if (wr >= 45)                         return { grade: 'C',   color: '#f0c040' };
  return                                       { grade: 'D',   color: '#f85149' };
}

// ── Fetch top whale positions ─────────────────────────────────────────────────
async function fetchWhaleData() {
  let leaderboard = [];
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    if (r.ok) leaderboard = await r.json();
  } catch {}

  const seen = new Set();
  const whales = [];

  for (const t of leaderboard.slice(0, 8)) {
    const addr = (t.proxyWallet || '').toLowerCase();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const rawName = (t.userName || t.xUsername || '').replace(/ - \d{3,}$/, '').trim();
    whales.push({
      name:    KNOWN_NAMES[addr] || (rawName && !rawName.startsWith('0x') ? rawName : addrShort(t.proxyWallet)),
      address: t.proxyWallet || addr,
      pnl:     Math.round(parseFloat(t.pnl || 0)),
      rank:    t.rank || '—',
    });
  }

  // Fetch win rate + trades for each
  const stats = await Promise.all(whales.map(async w => {
    try {
      const r = await fetch(`https://data-api.polymarket.com/positions?user=${w.address}&limit=100&sortBy=CURRENT&sortDirection=DESC`);
      if (!r.ok) return { wr: '—', trades: 0 };
      const pos = await r.json();
      if (!Array.isArray(pos) || !pos.length) return { wr: '—', trades: 0 };
      const withInv = pos.filter(p => parseFloat(p.totalBought || 0) > 0);
      const won  = withInv.filter(p => p.redeemable === true).length;
      const lost = withInv.filter(p => p.currentValue === 0 && p.redeemable === false).length;
      const total = won + lost;
      return { wr: total >= 3 ? Math.round((won / total) * 100) : '—', trades: withInv.length };
    } catch { return { wr: '—', trades: 0 }; }
  }));

  return whales.map((w, i) => ({ ...w, wr: stats[i].wr, trades: stats[i].trades }));
}

// ── Fetch recent big activity ─────────────────────────────────────────────────
async function fetchTopActivity() {
  try {
    const r = await fetch('https://data-api.polymarket.com/activity?limit=100');
    if (!r.ok) return [];
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.data || data.activities || []);
    return items
      .filter(a => parseFloat(a.usdcSize || a.size || 0) >= 5000)
      .sort((a, b) => parseFloat(b.usdcSize || b.size || 0) - parseFloat(a.usdcSize || a.size || 0))
      .slice(0, 3);
  } catch { return []; }
}

// ── Fetch market consensus (markets where 2+ whales agree) ───────────────────
async function fetchConsensus() {
  try {
    const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    if (!r.ok) return [];
    const lb = await r.json();
    const top10 = lb.slice(0, 10);

    const marketMap = {};
    await Promise.all(top10.map(async t => {
      const addr = t.proxyWallet || '';
      try {
        const r2 = await fetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=5&limit=50`);
        if (!r2.ok) return;
        const pos = await r2.json();
        for (const p of (Array.isArray(pos) ? pos : [])) {
          const px = parseFloat(p.price || p.curPrice || 0);
          if (px < 0.03 || px > 0.97) continue;
          if (parseFloat(p.currentValue || 0) < 500) continue;
          const key = p.conditionId || p.title || '';
          if (!key) continue;
          if (!marketMap[key]) marketMap[key] = { title: p.title || p.market || key, yes: 0, no: 0, total: 0 };
          const outcome = (p.outcome || '').toLowerCase();
          const val = parseFloat(p.currentValue || 0);
          if (outcome === 'yes') marketMap[key].yes += val;
          else                   marketMap[key].no  += val;
          marketMap[key].total += val;
        }
      } catch {}
    }));

    return Object.values(marketMap)
      .filter(m => m.total >= 2000)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);
  } catch { return []; }
}

// ── Build HTML email ──────────────────────────────────────────────────────────
function buildEmail(whales, activity, consensus, date) {

  const leaderboardRows = whales.slice(0, 5).map((w, i) => {
    const { grade, color } = reliabilityGrade(w.wr, w.trades);
    const pnlColor = w.pnl >= 0 ? '#3fb950' : '#f85149';
    const pnlStr   = (w.pnl >= 0 ? '+' : '') + fmtUSD(Math.abs(w.pnl));
    return `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #21262d;color:#8b949e;font-size:13px">#${i+1}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #21262d;font-weight:700;color:#e6edf3;font-size:13px">${w.name}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #21262d;text-align:center">
          <span style="background:rgba(0,0,0,0.3);color:${color};font-weight:800;font-size:12px;padding:2px 8px;border-radius:6px">${grade}</span>
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid #21262d;text-align:right;color:${pnlColor};font-weight:700;font-size:13px">${pnlStr}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #21262d;text-align:right;color:#8b949e;font-size:12px">${w.wr !== '—' ? w.wr + '%' : '—'}</td>
      </tr>`;
  }).join('');

  const activityRows = activity.length ? activity.map(a => {
    const title   = (a.title || a.market || a.question || 'Unknown market').slice(0, 55);
    const outcome = (a.outcome || a.side || '').toLowerCase() === 'yes' ? '🟢 YES' : '🔴 NO';
    const size    = fmtUSD(parseFloat(a.usdcSize || a.size || 0));
    const name    = a.pseudonym || a.name || addrShort(a.proxyWallet || '');
    return `
      <div style="padding:12px 0;border-bottom:1px solid #21262d;">
        <div style="font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:4px">${title}${title.length >= 55 ? '…' : ''}</div>
        <div style="display:flex;gap:12px;font-size:12px;color:#8b949e">
          <span>${outcome}</span>
          <span style="color:#58a6ff;font-weight:700">${size}</span>
          <span>by ${name}</span>
        </div>
      </div>`;
  }).join('') : '<div style="color:#8b949e;font-size:13px;padding:12px 0">No major trades in the last 24h</div>';

  const consensusRows = consensus.length ? consensus.map(m => {
    const title    = (m.title || '').slice(0, 55);
    const dominant = m.yes >= m.no ? 'YES' : 'NO';
    const domVal   = Math.max(m.yes, m.no);
    const pct      = m.total > 0 ? Math.round((domVal / m.total) * 100) : 0;
    const color    = dominant === 'YES' ? '#3fb950' : '#f85149';
    return `
      <div style="padding:12px 0;border-bottom:1px solid #21262d;">
        <div style="font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:4px">${title}${title.length >= 55 ? '…' : ''}</div>
        <div style="font-size:12px;color:#8b949e">
          Whales leaning <span style="color:${color};font-weight:700">${dominant}</span> · ${pct}% of whale money (${fmtUSD(m.total)} total)
        </div>
      </div>`;
  }).join('') : '<div style="color:#8b949e;font-size:13px;padding:12px 0">No strong consensus today</div>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">

  <!-- Header -->
  <div style="text-align:center;padding:28px 0 20px;">
    <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px">🐋 WhaleTrack</div>
    <div style="font-size:13px;color:#8b949e;margin-top:6px">Daily Whale Intelligence · ${date}</div>
  </div>

  <!-- Top Whale Bets -->
  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:16px;">
    <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:14px">🔥 Top Whale Bets Today</div>
    ${activityRows}
  </div>

  <!-- Market Consensus -->
  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:16px;">
    <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:14px">🤝 Where Whales Agree</div>
    ${consensusRows}
  </div>

  <!-- Leaderboard -->
  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:24px;">
    <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:14px">🏆 Whale Leaderboard</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr>
          <th style="padding:6px 8px;font-size:11px;color:#8b949e;text-align:left;font-weight:600">#</th>
          <th style="padding:6px 8px;font-size:11px;color:#8b949e;text-align:left;font-weight:600">Whale</th>
          <th style="padding:6px 8px;font-size:11px;color:#8b949e;text-align:center;font-weight:600">Grade</th>
          <th style="padding:6px 8px;font-size:11px;color:#8b949e;text-align:right;font-weight:600">P&L</th>
          <th style="padding:6px 8px;font-size:11px;color:#8b949e;text-align:right;font-weight:600">WR</th>
        </tr>
      </thead>
      <tbody>${leaderboardRows}</tbody>
    </table>
  </div>

  <!-- CTA -->
  <div style="text-align:center;padding:8px 0 24px;">
    <a href="https://whaletrack.app" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.2px">
      Track Live on WhaleTrack →
    </a>
    <div style="margin-top:12px;font-size:12px;color:#8b949e">
      Get Telegram alerts instantly · <a href="https://t.me/WhaleTrackBot" style="color:#58a6ff;text-decoration:none">@WhaleTrackBot</a>
    </div>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0;border-top:1px solid #21262d;">
    <div style="font-size:12px;color:#484f58">
      You're receiving this because you subscribed at whaletrack.app<br>
      <a href="{{unsubscribeUrl}}" style="color:#484f58;text-decoration:underline">Unsubscribe</a>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow GET from Vercel cron or manual trigger
  res.setHeader('Cache-Control', 'no-store');

  // Optional: protect with a secret so random people can't trigger it
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend   = new Resend(process.env.RESEND_API_KEY);
  const audId    = process.env.RESEND_AUDIENCE_ID;
  const fromAddr = process.env.RESEND_FROM_EMAIL || 'WhaleTrack <digest@whaletrack.app>';

  // Fetch all data in parallel
  const [whales, activity, consensus] = await Promise.all([
    fetchWhaleData(),
    fetchTopActivity(),
    fetchConsensus(),
  ]);

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const html = buildEmail(whales, activity, consensus, date);
  const subject = `🐋 Daily Whale Brief — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  // Get all subscribers
  let contacts = [];
  try {
    const r = await resend.contacts.list({ audienceId: audId });
    contacts = (r.data?.data || []).filter(c => !c.unsubscribed);
  } catch (e) {
    console.error('Failed to fetch contacts:', e);
    return res.status(500).json({ error: 'Failed to fetch subscribers' });
  }

  if (!contacts.length) {
    return res.status(200).json({ sent: 0, message: 'No subscribers yet' });
  }

  // Send to each subscriber
  let sent = 0, failed = 0;
  for (const contact of contacts) {
    try {
      await resend.emails.send({
        from:    fromAddr,
        to:      contact.email,
        subject,
        html,
        headers: {
          'List-Unsubscribe': `<mailto:unsubscribe@whaletrack.app?subject=unsubscribe>`,
        },
      });
      sent++;
    } catch (e) {
      console.error(`Failed to send to ${contact.email}:`, e);
      failed++;
    }
  }

  res.status(200).json({ sent, failed, total: contacts.length });
}
