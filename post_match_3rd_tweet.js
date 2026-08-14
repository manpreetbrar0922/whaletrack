#!/usr/bin/env node
// Post-match tweet — France vs England 3rd place result (July 18)
const https  = require('https');
const crypto = require('crypto');

const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

function pct(s) { return encodeURIComponent(String(s)); }

function buildOAuthHeader(method, url) {
  const p = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
  };
  const paramStr = Object.keys(p).sort().map(k => `${pct(k)}=${pct(p[k])}`).join('&');
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const sigKey = `${pct(API_SECRET)}&${pct(ACCESS_TOKEN_SECRET)}`;
  p.oauth_signature = crypto.createHmac('sha1', sigKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).map(k => `${pct(k)}="${pct(p[k])}"`).join(', ');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WhaleTrack/1.0' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function postTweet(text) {
  return new Promise((resolve, reject) => {
    const url  = 'https://api.twitter.com/2/tweets';
    const body = JSON.stringify({ text });
    const auth = buildOAuthHeader('POST', url);
    const req  = https.request({
      hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const result = JSON.parse(d);
        if (res.statusCode === 201) resolve(result);
        else reject(new Error(`Twitter ${res.statusCode}: ${d}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function checkResult() {
  try {
    const data = await fetchJson(
      'https://gamma-api.polymarket.com/markets?active=false&closed=true&limit=50&order=volume&ascending=false'
    );
    for (const m of (Array.isArray(data) ? data : [])) {
      const q = (m.question || '').toLowerCase();
      if (!q.includes('france') && !q.includes('england')) continue;
      if (!q.includes('3rd') && !q.includes('third')) continue;
      const outcomes = JSON.parse(m.outcomes || '[]');
      const prices   = JSON.parse(m.outcomePrices || '[]');
      for (let i = 0; i < outcomes.length; i++) {
        if (parseFloat(prices[i] || 0) >= 0.99) return outcomes[i];
      }
    }
  } catch(e) {}
  return null;
}

async function main() {
  const result = await checkResult();
  console.log('3rd place result:', result);

  let tweetEN, tweetES;

  if (!result) {
    tweetEN = `🐋 France vs England — still waiting on result

Polymarket had France as heavy favourite at 65¢

We'll update when it settles 👀

Track live → whaletrack.app/worldcup
#Mundial2026 #Polymarket`;

    tweetES = `🐋 Francia vs Inglaterra — aún esperando el resultado

Polymarket tenía a Francia como favorita a 65¢

whaletrack.app/worldcup
#Mundial2026 #Polymarket`;

  } else if (result.toLowerCase().includes('france') || result === 'Yes') {
    tweetEN = `✅ Smart money wins!

France 🇫🇷 finish 3rd at the 2026 World Cup

Polymarket had them at 65¢ — the favourite came through 💰

Tomorrow is the big one: Spain 🇪🇸 vs Argentina 🇦🇷

$290K whale has been on Spain all tournament 👀
whaletrack.app/worldcup
#Mundial2026 #Polymarket`;

    tweetES = `✅ ¡El dinero inteligente gana!

Francia 🇫🇷 termina 3ra en el Mundial 2026

Polymarket la tenía como favorita a 65¢ — acertó 💰

Mañana es la grande: España 🇪🇸 vs Argentina 🇦🇷

Una ballena tiene $290K en España 👀
whaletrack.app/worldcup
#Mundial2026 #EspañaArgentina #Polymarket`;

  } else {
    tweetEN = `🏴󠁧󠁢󠁥󠁮󠁧󠁿 England finish 3rd at the 2026 World Cup!

Polymarket had them as underdogs at 35¢ — smart money didn't see that coming 😅

Tomorrow is the big one: Spain 🇪🇸 vs Argentina 🇦🇷

$290K whale on Spain — all eyes on the final 👀
whaletrack.app/worldcup
#Mundial2026 #Polymarket`;

    tweetES = `🏴󠁧󠁢󠁥󠁮󠁧󠁿 ¡Inglaterra termina 3ra en el Mundial 2026!

Polymarket la tenía como outsider a 35¢ — ¡sorpresa! 😅

Mañana es la grande: España 🇪🇸 vs Argentina 🇦🇷

Una ballena tiene $290K en España 👀
whaletrack.app/worldcup
#Mundial2026 #EspañaArgentina #Polymarket`;
  }

  try {
    const r1 = await postTweet(tweetEN);
    console.log(`✅ 3rd place result EN: https://twitter.com/i/web/status/${r1.data.id}`);
  } catch(e) {
    console.error(`❌ EN failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 180000)); // 3 min gap

  try {
    const r2 = await postTweet(tweetES);
    console.log(`✅ 3rd place result ES: https://twitter.com/i/web/status/${r2.data.id}`);
  } catch(e) {
    console.error(`❌ ES failed: ${e.message}`);
  }
}

main();
