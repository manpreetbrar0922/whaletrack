#!/usr/bin/env node
// Pre-match tweet — France vs England 3rd place (July 18)
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

const tweetEN = `🐋 3rd Place — Kickoff in 30 mins

France 🇫🇷 vs England 🏴󠁧󠁢󠁥󠁮󠁧󠁿

What Polymarket says:

🇫🇷 France: 65¢ (favourite)
🏴󠁧󠁢󠁥󠁮󠁧󠁿 England: 35¢

Smart money backing Les Bleus to bounce back 💰

Track live → whaletrack.app/worldcup
#Mundial2026 #Polymarket`;

const tweetES = `🐋 Partido por el 3er lugar — ¡En 30 minutos!

Francia 🇫🇷 vs Inglaterra 🏴󠁧󠁢󠁥󠁮󠁧󠁿

Lo que dice Polymarket:

🇫🇷 Francia: 65¢ (favorita)
🏴󠁧󠁢󠁥󠁮󠁧󠁿 Inglaterra: 35¢

El dinero inteligente apoya a Francia 💰

whaletrack.app/worldcup
#Mundial2026 #Polymarket #FranciaInglaterra`;

async function main() {
  try {
    const r1 = await postTweet(tweetEN);
    console.log(`✅ 3rd place pre-match EN: https://twitter.com/i/web/status/${r1.data.id}`);
  } catch(e) {
    console.error(`❌ EN failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 120000)); // 2 min gap

  try {
    const r2 = await postTweet(tweetES);
    console.log(`✅ 3rd place pre-match ES: https://twitter.com/i/web/status/${r2.data.id}`);
  } catch(e) {
    console.error(`❌ ES failed: ${e.message}`);
  }
}

main();
