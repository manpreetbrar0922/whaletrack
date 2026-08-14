#!/usr/bin/env node
// Post-match result tweet — checks Polymarket to see who won, posts outcome
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
  // Check Polymarket for England vs Argentina result
  try {
    const data = await fetchJson(
      'https://gamma-api.polymarket.com/events?active=false&closed=true&limit=50&order=volume&ascending=false&tag_slug=soccer'
    );

    // Look for resolved England match market
    for (const event of (Array.isArray(data) ? data : [])) {
      const title = (event.title || '').toLowerCase();
      if (!title.includes('england') || !title.includes('argentina')) continue;

      const markets = event.markets || [];
      for (const m of markets) {
        const q = (m.question || m.groupItemTitle || '').toLowerCase();
        if (!q.includes('england') && !q.includes('argentina')) continue;

        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices   = JSON.parse(m.outcomePrices || '[]');

        // Find winner — price = 1 means resolved YES
        for (let i = 0; i < outcomes.length; i++) {
          if (parseFloat(prices[i] || 0) >= 0.99) {
            return outcomes[i]; // "England" or "Argentina" or "Yes"/"No"
          }
        }
      }
    }
  } catch (e) {
    console.error('Result check error:', e.message);
  }

  // Fallback: check the "Will England win on 2026-07-15?" market
  try {
    const data = await fetchJson(
      'https://gamma-api.polymarket.com/markets?active=false&closed=true&limit=50'
    );
    for (const m of (Array.isArray(data) ? data : [])) {
      const q = (m.question || '').toLowerCase();
      if (!q.includes('england') || !q.includes('2026-07-15')) continue;
      const prices = JSON.parse(m.outcomePrices || '[]');
      const outcomes = JSON.parse(m.outcomes || '[]');
      for (let i = 0; i < outcomes.length; i++) {
        if (parseFloat(prices[i] || 0) >= 0.99) {
          return outcomes[i]; // "Yes" or "No"
        }
      }
    }
  } catch (e) {}

  return null; // can't determine yet
}

async function main() {
  console.log('Checking match result...');
  const result = await checkResult();
  console.log('Result detected:', result);

  let tweet;

  if (!result) {
    // Match result not settled yet — post a "watching" tweet
    tweet = `🐋 England vs Argentina — still watching the result on Polymarket

Whales had:
🏴󠁧󠁢󠁥󠁮󠁧󠁿 $206K on England to win the World Cup
🇦🇷 $52K on Argentina

We'll see if smart money was right...

Track live → whaletrack.app/worldcup`;

  } else if (result.toLowerCase().includes('england') || result === 'Yes') {
    tweet = `✅ Smart money wins again!

Whales had $206K on England 🏴󠁧󠁢󠁥󠁮󠁧󠁿 to win the World Cup

England advance to the final vs Spain 🇪🇸

The same whale has $290K on Spain too — betting on the final he wanted all along 👀

Follow the smart money → whaletrack.app/worldcup`;

  } else {
    tweet = `🇦🇷 Argentina knock out England!

Whales had $206K on England... didn't work out this time

But the biggest whale still has $290K on Spain 🇪🇸 to win it all

Spain vs Argentina final incoming? Smart money says Spain 👇

Track whale bets → whaletrack.app/worldcup`;
  }

  try {
    const r = await postTweet(tweet);
    console.log(`✅ Post-match tweet: https://twitter.com/i/web/status/${r.data.id}`);
  } catch (e) {
    console.error(`❌ Tweet failed: ${e.message}`);
  }
}

main();
