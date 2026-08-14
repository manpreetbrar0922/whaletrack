#!/usr/bin/env node
// Pre-match tweet — England vs Argentina semi-final (July 15)
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

const tweet = `🐋 Kickoff in 30 mins — England vs Argentina

Where whales are betting on Polymarket:

🏴󠁧󠁢󠁥󠁮󠁧󠁿 $206K on England to win the World Cup
🇦🇷 $52K on Argentina to win
⚽ $37K on both teams to score today

3 whale wallets backing England. 0 on Argentina.

Smart money has spoken 👇
Track live → whaletrack.app/worldcup`;

postTweet(tweet)
  .then(r => console.log(`✅ Pre-match tweet posted: https://twitter.com/i/web/status/${r.data.id}`))
  .catch(e => console.error(`❌ Failed: ${e.message}`));
