// Daily health check — runs via Vercel cron at 8 AM UTC
// Checks all public pages and API endpoints, emails on failure via Resend

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BASE = 'https://whaletrack.app';
const ALERT_TO = 'manpreetbrar491@gmail.com';

const PAGES = [
  { url: '/',          label: 'Main page',      keyword: 'WhaleTrack' },
  { url: '/worldcup',  label: 'World Cup page',  keyword: 'World Cup'  },
  { url: '/crypto',    label: 'Crypto page',     keyword: 'Crypto'     },
  { url: '/sports',    label: 'Sports page',     keyword: 'Sports'     },
  { url: '/politics',  label: 'Politics page',   keyword: 'Politics'   },
];

const APIS = [
  { url: '/api/whales',    label: 'Whales API'    },
  { url: '/api/matches',   label: 'Matches API'   },
  { url: '/api/activity',  label: 'Activity API'  },
  { url: '/api/consensus', label: 'Consensus API' },
];

async function checkPage({ url, label, keyword }) {
  try {
    const r = await fetch(BASE + url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { label, ok: false, reason: `HTTP ${r.status}` };
    const html = await r.text();
    if (!html.includes(keyword)) return { label, ok: false, reason: `Missing keyword "${keyword}"` };
    return { label, ok: true };
  } catch (e) {
    return { label, ok: false, reason: e.message || 'Timeout / network error' };
  }
}

async function checkApi({ url, label }) {
  try {
    const r = await fetch(BASE + url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { label, ok: false, reason: `HTTP ${r.status}` };
    const data = await r.json();
    if (!Array.isArray(data) && typeof data !== 'object') {
      return { label, ok: false, reason: 'Response is not valid JSON object/array' };
    }
    return { label, ok: true, count: Array.isArray(data) ? data.length : null };
  } catch (e) {
    return { label, ok: false, reason: e.message || 'Timeout / network error' };
  }
}

async function sendAlert(failures, results) {
  if (!RESEND_API_KEY) return;

  const failureRows = failures
    .map(f => `<tr style="background:#1c0a0a"><td style="padding:8px 12px;color:#f85149;font-weight:700">❌ ${f.label}</td><td style="padding:8px 12px;color:#e6edf3">${f.reason}</td></tr>`)
    .join('');

  const allRows = results
    .map(r => `<tr><td style="padding:6px 12px;color:${r.ok ? '#3fb950' : '#f85149'}">${r.ok ? '✅' : '❌'} ${r.label}</td><td style="padding:6px 12px;color:#8b949e">${r.ok ? (r.count !== null ? `${r.count} items` : 'OK') : r.reason}</td></tr>`)
    .join('');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;padding:24px;border-radius:12px;max-width:600px">
      <h2 style="color:#f85149;margin:0 0 8px">🚨 WhaleTrack Health Check Failed</h2>
      <p style="color:#8b949e;margin:0 0 20px;font-size:14px">${failures.length} issue${failures.length !== 1 ? 's' : ''} detected · ${new Date().toUTCString()}</p>

      <h3 style="color:#e6edf3;font-size:14px;margin:0 0 8px">⚠️ Failures</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
        ${failureRows}
      </table>

      <h3 style="color:#e6edf3;font-size:14px;margin:0 0 8px">📋 Full Report</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${allRows}
      </table>

      <p style="color:#484f58;font-size:11px;margin-top:20px">WhaleTrack Daily Health Check · whaletrack.app</p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'WhaleTrack Alerts <alerts@whaletrack.app>',
      to: ALERT_TO,
      subject: `🚨 WhaleTrack: ${failures.length} page${failures.length !== 1 ? 's' : ''} down — ${failures.map(f => f.label).join(', ')}`,
      html,
    }),
  });
}

export default async function handler(req, res) {
  // Allow manual trigger via GET, or cron via any method
  const checks = [
    ...PAGES.map(p => checkPage(p)),
    ...APIS.map(a => checkApi(a)),
  ];

  const results = await Promise.all(checks);
  const failures = results.filter(r => !r.ok);

  if (failures.length > 0) {
    await sendAlert(failures, results);
  }

  const summary = {
    checked: results.length,
    passed: results.filter(r => r.ok).length,
    failed: failures.length,
    failures: failures.map(f => ({ label: f.label, reason: f.reason })),
    timestamp: new Date().toISOString(),
  };

  res.status(200).json(summary);
}
