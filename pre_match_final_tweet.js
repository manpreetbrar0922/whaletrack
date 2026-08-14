#!/usr/bin/env node
// Pre-match tweet — Spain vs Argentina World Cup Final (July 19)
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

const tweetEN = `🐋 World Cup Final — Kickoff in 30 mins

Spain 🇪🇸 vs Argentina 🇦🇷

Where the biggest whales are betting on Polymarket:

🇪🇸 $290K on Spain to win the World Cup
🇦🇷 $52K on Argentina

The same whale predicted this exact final weeks ago.

Smart money has spoken 👇
Track live → whaletrack.app/worldcup`;

const tweetES = `🐋 ¡La Final del Mundial arranca en 30 minutos!

España 🇪🇸 vs Argentina 🇦🇷

Las ballenas más grandes de Polymarket apuestan:

🇪🇸 $290K en España
🇦🇷 $52K en Argentina

La misma ballena predijo esta final desde el principio 👀

¿Vas a seguir el dinero inteligente?
whaletrack.app/worldcup

#EspañaArgentina #FinalDelMundial #Mundial2026 #Polymarket`;

async function main() {
  // Post English first
  try {
    const r1 = await postTweet(tweetEN);
    console.log(`✅ Pre-final EN tweet: https://twitter.com/i/web/status/${r1.data.id}`);
  } catch(e) {
    console.error(`❌ EN tweet failed: ${e.message}`);
  }

  // Wait 2 mins then post Spanish
  await new Promise(r => setTimeout(r, 120000));

  try {
    const r2 = await postTweet(tweetES);
    console.log(`✅ Pre-final ES tweet: https://twitter.com/i/web/status/${r2.data.id}`);
  } catch(e) {
    console.error(`❌ ES tweet failed: ${e.message}`);
  }
}

main();
