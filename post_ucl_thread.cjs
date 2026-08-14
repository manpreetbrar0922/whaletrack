#!/usr/bin/env node
// Post UCL launch thread — Spanish main tweet + English replies

const https  = require('https');
const crypto = require('crypto');

const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ Missing Twitter credentials'); process.exit(1);
}

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
  const base     = `${method}&${pct(url)}&${pct(paramStr)}`;
  const sigKey   = `${pct(API_SECRET)}&${pct(ACCESS_TOKEN_SECRET)}`;
  p.oauth_signature = crypto.createHmac('sha1', sigKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).map(k => `${pct(k)}="${pct(p[k])}"`).join(', ');
}

function postTweet(text, replyToId = null) {
  return new Promise((resolve, reject) => {
    const url  = 'https://api.twitter.com/2/tweets';
    const body = replyToId
      ? JSON.stringify({ text, reply: { in_reply_to_tweet_id: replyToId } })
      : JSON.stringify({ text });
    const auth = buildOAuthHeader('POST', url);
    const req  = https.request({
      hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postThread() {
  const tweets = [
    // Tweet 1 — Spanish (main)
    `🏆 La Champions League vuelve en septiembre.

Seguimos el dinero inteligente en Polymarket — cuando abran los mercados, sabrás exactamente dónde están apostando las ballenas 🐋

Real Madrid, Man City, PSG, Bayern... ¿quién tiene más dinero inteligente a favor?

→ whaletrack.app/champions-league

#ChampionsLeague #UCL #Polymarket #FutbolEnPolymarket`,

    // Tweet 2 — English
    `For the English speakers in the thread 🌍

We just launched a Champions League whale tracker — when UCL markets open on Polymarket, you'll see exactly where the big money is going.

Real-time positions, copy bet buttons, smart money signals 👇

whaletrack.app/champions-league`,

    // Tweet 3 — How it works
    `How it works:

🐋 We track the top Polymarket whale wallets 24/7
📡 When they bet on a UCL market, it shows up instantly
📋 One-click "Copy Bet" to follow their position
🔔 Telegram alerts before it hits Twitter

It's free. No signup needed.`,

    // Tweet 4 — CTA
    `UCL group stage starts September 2026 🏆

Bookmark this now so you're ready when the whale money starts flowing:

→ whaletrack.app/champions-league

Follow @WhaleTrackApp for alerts every match week ⚽`,
  ];

  let lastId = null;

  for (let i = 0; i < tweets.length; i++) {
    try {
      console.log(`\nPosting tweet ${i + 1}/${tweets.length}...`);
      const result = await postTweet(tweets[i], lastId);
      lastId = result.data?.id;
      console.log(`✅ Posted: ${lastId}`);
      console.log(`   Preview: ${tweets[i].slice(0, 60)}...`);
      if (i < tweets.length - 1) {
        console.log('   Waiting 3s...');
        await sleep(3000);
      }
    } catch(e) {
      console.error(`❌ Failed tweet ${i + 1}:`, e.message);
      process.exit(1);
    }
  }

  console.log('\n🎉 UCL thread posted successfully!');
  console.log(`View thread: https://twitter.com/WhaleTrackApp/status/${tweets[0]}`);
}

postThread();
