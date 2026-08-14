#!/usr/bin/env node
// Scheduled Tweet Poster
// Reads from tweet_queue.json, posts the next due tweet, removes it from queue

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ Missing Twitter credentials'); process.exit(1);
}

const QUEUE_FILE = path.join(__dirname, 'tweet_queue.json');

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

function postTweet(text) {
  return new Promise((resolve, reject) => {
    const url  = 'https://api.twitter.com/2/tweets';
    const body = JSON.stringify({ text });
    const auth = buildOAuthHeader('POST', url);
    const req  = https.request({
      hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
      headers: {
        'Authorization': auth, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(QUEUE_FILE)) {
    console.log('No tweet_queue.json found. Nothing to post.');
    return;
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const now   = Date.now();

  // Find tweets that are due (post_at <= now)
  const due = queue.filter(t => t.post_at <= now && !t.posted);
  if (!due.length) {
    console.log(`[${new Date().toISOString()}] No tweets due yet.`);
    return;
  }

  // Post ONE tweet per run (avoid rate limit)
  const tweet = due[0];
  console.log(`[${new Date().toISOString()}] Posting: "${tweet.text.slice(0, 60)}..."`);

  try {
    const result = await postTweet(tweet.text);
    if (result.data?.id) {
      console.log(`✅ Posted! Tweet ID: ${result.data.id}`);
      tweet.posted    = true;
      tweet.posted_at = now;
      tweet.tweet_id  = result.data.id;
    } else {
      console.error('❌ Unexpected response:', JSON.stringify(result));
      tweet.error     = JSON.stringify(result);
      tweet.posted    = false;
    }
  } catch (e) {
    console.error('❌ Error posting tweet:', e.message);
    tweet.error = e.message;
  }

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

main();
