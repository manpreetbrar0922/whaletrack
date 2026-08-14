#!/usr/bin/env node
// Post-match result tweet — World Cup Final Spain vs Argentina (July 19)
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
  // Check Polymarket for Spain vs Argentina final result
  try {
    const data = await fetchJson(
      'https://gamma-api.polymarket.com/events?active=false&closed=true&limit=50&order=volume&ascending=false&tag_slug=soccer'
    );
    for (const event of (Array.isArray(data) ? data : [])) {
      const title = (event.title || '').toLowerCase();
      if (!title.includes('spain') || !title.includes('argentina')) continue;

      const markets = event.markets || [];
      for (const m of markets) {
        const q = (m.question || m.groupItemTitle || '').toLowerCase();
        if (!q.includes('spain') && !q.includes('argentina')) continue;

        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices   = JSON.parse(m.outcomePrices || '[]');

        for (let i = 0; i < outcomes.length; i++) {
          if (parseFloat(prices[i] || 0) >= 0.99) {
            return outcomes[i];
          }
        }
      }
    }
  } catch (e) {
    console.error('Result check error:', e.message);
  }

  // Fallback: check World Cup winner market
  try {
    const data = await fetchJson(
      'https://gamma-api.polymarket.com/markets?active=false&closed=true&limit=100&order=volume&ascending=false'
    );
    for (const m of (Array.isArray(data) ? data : [])) {
      const q = (m.question || '').toLowerCase();
      if ((!q.includes('world cup') && !q.includes('fifa')) || !q.includes('2026')) continue;
      if (!q.includes('winner') && !q.includes('champion')) continue;

      const outcomes = JSON.parse(m.outcomes || '[]');
      const prices   = JSON.parse(m.outcomePrices || '[]');
      for (let i = 0; i < outcomes.length; i++) {
        if (parseFloat(prices[i] || 0) >= 0.99) {
          return outcomes[i];
        }
      }
    }
  } catch (e) {}

  return null;
}

async function main() {
  console.log('Checking World Cup Final result...');
  const result = await checkResult();
  console.log('Result detected:', result);

  let tweetEN, tweetES;

  if (!result) {
    tweetEN = `🐋 Spain vs Argentina — still waiting on the final result

Biggest whale bets on Polymarket:
🇪🇸 $290K on Spain 🏆
🇦🇷 $52K on Argentina

The whale who predicted this exact final is still sweating...

Track live → whaletrack.app/worldcup`;

    tweetES = `🐋 España vs Argentina — aún esperando el resultado final

Las apuestas más grandes en Polymarket:
🇪🇸 $290K en España
🇦🇷 $52K en Argentina

La ballena sigue esperando...

whaletrack.app/worldcup #FinalDelMundial #Mundial2026`;

  } else if (result.toLowerCase().includes('spain') || result === 'Yes') {
    tweetEN = `🏆 $290K whale wins BIG!

Spain 🇪🇸 are the 2026 World Cup Champions!

The biggest whale on Polymarket had $290K on Spain — and called this exact final from the start.

That's what following smart money looks like 🐋

See who the whales are betting on NOW →
whaletrack.app/worldcup`;

    tweetES = `🏆 ¡La ballena de $290K gana en grande!

¡España 🇪🇸 es Campeón del Mundial 2026!

La ballena más grande de Polymarket apostó $290K en España — y predijo esta final desde el principio.

Así se ve seguir el dinero inteligente 🐋

whaletrack.app/worldcup
#EspañaCampeon #Mundial2026 #Polymarket`;

  } else {
    tweetEN = `🇦🇷 Argentina are the 2026 World Cup Champions!

The $290K Spain whale didn't get there in the end...

But smart money came CLOSE — Spain were favourites right until the final whistle.

See which whales are winning NOW 🐋

Track live → whaletrack.app/worldcup`;

    tweetES = `🇦🇷 ¡Argentina es Campeón del Mundial 2026!

La ballena de $290K en España no llegó esta vez...

Pero el dinero inteligente estuvo cerca — España fue favorita hasta el pitazo final.

¿Quiénes son las ballenas ganadoras ahora? 🐋

whaletrack.app/worldcup
#ArgentinaCampeon #Mundial2026 #Polymarket`;
  }

  // Post English first
  try {
    const r1 = await postTweet(tweetEN);
    console.log(`✅ Post-final EN tweet: https://twitter.com/i/web/status/${r1.data.id}`);
  } catch (e) {
    console.error(`❌ EN tweet failed: ${e.message}`);
  }

  // Wait 3 mins then post Spanish
  await new Promise(r => setTimeout(r, 180000));

  try {
    const r2 = await postTweet(tweetES);
    console.log(`✅ Post-final ES tweet: https://twitter.com/i/web/status/${r2.data.id}`);
  } catch (e) {
    console.error(`❌ ES tweet failed: ${e.message}`);
  }
}

main();
