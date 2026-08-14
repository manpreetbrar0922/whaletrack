#!/usr/bin/env node
// Pre-tournament tweet — The Open Championship 2026 (July 17-20)
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

const tweetEN = `🐋 The Open Championship starts TODAY

$1.3M bet on Polymarket. Here's where smart money is going:

🏆 Scheffler: 14.5¢ (favourite)
🎯 Cameron Young: 7.4¢
🏴󠁧󠁢󠁳󠁣󠁴󠁿 MacIntyre: 5.7¢ (home crowd)
⛳ Morikawa: 5.1¢ (links specialist)

Rory McIlroy most traded ($200K volume) at just 2.5¢ 👀

Track whale bets live →
whaletrack.app
#TheOpen #TheOpen2026 #Polymarket`;

const tweetES = `🐋 ¡Comienza The Open Championship!

$1.3M apostados en Polymarket:

🏆 Scheffler: 14.5¢ (favorito)
🎯 Cameron Young: 7.4¢
🏴󠁧󠁢󠁳󠁣󠁴󠁿 MacIntyre: 5.7¢
⛳ Morikawa: 5.1¢

Rory McIlroy — el más negociado ($200K) a solo 2.5¢ 👀

whaletrack.app
#TheOpen #Polymarket #Golf`;

async function main() {
  try {
    const r1 = await postTweet(tweetEN);
    console.log(`✅ Open Championship EN: https://twitter.com/i/web/status/${r1.data.id}`);
  } catch(e) {
    console.error(`❌ EN failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 120000)); // 2 min gap

  try {
    const r2 = await postTweet(tweetES);
    console.log(`✅ Open Championship ES: https://twitter.com/i/web/status/${r2.data.id}`);
  } catch(e) {
    console.error(`❌ ES failed: ${e.message}`);
  }
}

main();
