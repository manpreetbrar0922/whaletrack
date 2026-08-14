#!/usr/bin/env node
// Post the WhaleTrack launch announcement card to Twitter

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ Twitter credentials missing');
  process.exit(1);
}

const IMG_PATH = path.join(__dirname, 'launch-card.png');

function pct(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

function buildOAuthHeader(method, url, extra = {}) {
  const params = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
    ...extra,
  };
  const base = [method, pct(url), pct(Object.keys(params).sort().map(k => `${pct(k)}=${pct(params[k])}`).join('&'))].join('&');
  const sig  = crypto.createHmac('sha1', `${pct(API_SECRET)}&${pct(ACCESS_TOKEN_SECRET)}`).update(base).digest('base64');
  params.oauth_signature = sig;
  return 'OAuth ' + Object.keys(params).filter(k => k.startsWith('oauth_')).sort().map(k => `${pct(k)}="${pct(params[k])}"`).join(', ');
}

async function uploadMedia(imgPath) {
  const mediaData = fs.readFileSync(imgPath).toString('base64');
  const url       = 'https://upload.twitter.com/1.1/media/upload.json';
  const auth      = buildOAuthHeader('POST', url, { media_data: mediaData });
  const bodyStr   = `media_data=${pct(mediaData)}`;
  const bodyBuf   = Buffer.from(bodyStr);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'upload.twitter.com',
      path:     '/1.1/media/upload.json',
      method:   'POST',
      headers: {
        'Authorization':  auth,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (result.media_id_string) resolve(result.media_id_string);
          else reject(new Error(`Media upload ${res.statusCode}: ${d}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function postTweet(text, mediaId) {
  return new Promise((resolve, reject) => {
    const url     = 'https://api.twitter.com/2/tweets';
    const payload = { text };
    if (mediaId) payload.media = { media_ids: [mediaId] };
    const body    = JSON.stringify(payload);
    const auth    = buildOAuthHeader('POST', url);

    const req = https.request({
      hostname: 'api.twitter.com',
      path:     '/2/tweets',
      method:   'POST',
      headers: {
        'Authorization': auth,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('📤 Uploading launch card...');
  const mediaId = await uploadMedia(IMG_PATH);
  console.log('✅ Media uploaded:', mediaId);

  console.log('🐦 Posting tweet...');
  // Image-only tweet — minimal text so the card is the focus
  const result = await postTweet('🐋 whaletrack.app', mediaId);

  if (result?.data?.id) {
    console.log(`✅ Posted! https://twitter.com/i/web/status/${result.data.id}`);
  } else {
    console.error('❌ Tweet failed:', JSON.stringify(result, null, 2));
  }
})();
