#!/usr/bin/env node
// Fabrizio Romano Auto-Reply Monitor
// Watches his tweets via RSS, replies when UCL transfer news detected
// Max 2 replies/day · Only UCL clubs · Only transfer news

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');

const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

const STATE_FILE = '/Users/manpreetbrar/whaletrack/romano_replied.json';
const LOG_FILE   = '/Users/manpreetbrar/whaletrack/romano_monitor.log';
const MAX_DAILY  = 2;

// ── UCL clubs & transfer keywords ────────────────────────────
const UCL_CLUBS = [
  'real madrid', 'man city', 'manchester city',
  'psg', 'paris saint-germain', 'paris saint germain',
  'bayern', 'arsenal', 'liverpool', 'barcelona',
  'inter milan', 'inter', 'juventus', 'chelsea',
  'dortmund', 'atletico madrid', 'atletico',
  'benfica', 'sporting', 'porto', 'ajax',
];

const TRANSFER_SIGNALS = [
  'here we go', 'signed', 'agreement', 'deal confirmed', 'transfer confirmed',
  'contract signed', 'medical', 'announcement', 'confirmed', 'completed',
  'done deal', 'official', 'joins', 'move confirmed',
];

// ── Reply templates per club ──────────────────────────────────
const CLUB_REPLIES = {
  'real madrid':      '🇪🇸 Real Madrid',
  'manchester city':  '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Man City',
  'man city':         '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Man City',
  'psg':              '🇫🇷 PSG',
  'paris saint-germain': '🇫🇷 PSG',
  'paris saint germain': '🇫🇷 PSG',
  'bayern':           '🇩🇪 Bayern Munich',
  'arsenal':          '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Arsenal',
  'liverpool':        '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Liverpool',
  'barcelona':        '🇪🇸 Barcelona',
  'inter milan':      '🇮🇹 Inter Milan',
  'inter':            '🇮🇹 Inter Milan',
  'juventus':         '🇮🇹 Juventus',
  'chelsea':          '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Chelsea',
  'dortmund':         '🇩🇪 Dortmund',
  'atletico':         '🇪🇸 Atletico Madrid',
};

function getClubLabel(text) {
  const t = text.toLowerCase();
  for (const [key, label] of Object.entries(CLUB_REPLIES)) {
    if (t.includes(key)) return label;
  }
  return null;
}

// ── Logging ───────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── State (replied tweets + daily count) ─────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { replied: [], dailyCount: 0, lastReset: '' };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { replied: [], dailyCount: 0, lastReset: '' }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function checkDailyReset(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastReset !== today) {
    state.dailyCount = 0;
    state.lastReset  = today;
  }
  return state;
}

// ── Fetch RSS via Nitter (multiple fallbacks) ─────────────────
const NITTER_INSTANCES = [
  'nitter.privacydev.net',
  'nitter.poast.org',
  'nitter.tiekoetter.com',
];

function fetchRSS(host) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: host,
      path: '/FabrizioRomano/rss',
      headers: { 'User-Agent': 'Mozilla/5.0 WhaleTrackBot/1.0' },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getRomanoTweets() {
  for (const host of NITTER_INSTANCES) {
    try {
      const xml = await fetchRSS(host);
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
        const link  = (block.match(/<link>(.*?)<\/link>/)                   || [])[1] || '';
        const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)           || [])[1] || '';
        const tweetIdMatch = link.match(/status\/(\d+)/);
        if (!tweetIdMatch) continue;
        items.push({ title, link, pubDate, tweetId: tweetIdMatch[1] });
      }
      log(`Fetched ${items.length} tweets from ${host}`);
      return items;
    } catch (e) {
      log(`Nitter ${host} failed: ${e.message}`);
    }
  }
  return [];
}

// ── Fetch UCL odds from Polymarket ────────────────────────────
async function getUCLOdds() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'gamma-api.polymarket.com',
      path: '/events?active=true&closed=false&limit=100&order=volume&ascending=false',
      headers: { 'User-Agent': 'WhaleTrackBot/1.0' },
      timeout: 8000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const events = JSON.parse(data);
          const clTerms = ['champions league', 'ucl 2026', 'ucl 2027'];
          const teams = {};

          for (const ev of (Array.isArray(events) ? events : [])) {
            const evTitle = (ev.title || '').toLowerCase();
            if (!clTerms.some(t => evTitle.includes(t))) continue;
            for (const m of (ev.markets || [])) {
              const q = (m.question || m.title || '').toLowerCase();
              if (!q.includes('win')) continue;
              try {
                const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
                const prices   = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []);
                const yesIdx   = outcomes.findIndex(o => (o||'').toLowerCase() === 'yes');
                if (yesIdx === -1) continue;
                const pct = Math.round(parseFloat(prices[yesIdx] || 0) * 100);
                if (pct < 1) continue;
                const teamMatch = q.match(/will (.+?) win/i);
                if (teamMatch) teams[teamMatch[1].trim()] = pct;
              } catch {}
            }
          }
          resolve(teams);
        } catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// ── Build reply text ──────────────────────────────────────────
function buildReply(clubLabel, odds) {
  // Find odds for this club if available
  const clubKey = clubLabel.replace(/[🇪🇸🏴󠁧󠁢󠁥󠁮󠁧󠁿🇫🇷🇩🇪🇮🇹]\s*/u, '').toLowerCase();
  let oddsLine = '';

  for (const [team, pct] of Object.entries(odds)) {
    if (team.toLowerCase().includes(clubKey) || clubKey.includes(team.toLowerCase())) {
      oddsLine = `Polymarket has them at ${pct}% to win the UCL 🔥\n\n`;
      break;
    }
  }

  if (!oddsLine) {
    oddsLine = `UCL markets open on Polymarket in September — smart money will follow 👀\n\n`;
  }

  return `${clubLabel} transfer news = UCL odds moving 📊\n\n${oddsLine}Track whale bets → whaletrack.app/champions-league 🐋`;
}

// ── Twitter OAuth & post ──────────────────────────────────────
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

function postReply(text, replyToId) {
  return new Promise((resolve, reject) => {
    const url  = 'https://api.twitter.com/2/tweets';
    const body = JSON.stringify({ text, reply: { in_reply_to_tweet_id: replyToId } });
    const auth = buildOAuthHeader('POST', url);
    const req  = https.request({
      hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

// ── Is tweet recent (< 30 min)? ───────────────────────────────
function isRecent(pubDate) {
  try {
    const age = Date.now() - new Date(pubDate).getTime();
    return age < 30 * 60 * 1000; // 30 minutes
  } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    log('❌ Missing Twitter credentials'); process.exit(1);
  }

  let state = loadState();
  state = checkDailyReset(state);

  if (state.dailyCount >= MAX_DAILY) {
    log(`Daily limit reached (${MAX_DAILY} replies). Skipping.`);
    return;
  }

  const tweets = await getRomanoTweets();
  if (!tweets.length) { log('No tweets fetched'); return; }

  const odds = await getUCLOdds();
  log(`UCL odds: ${JSON.stringify(odds)}`);

  for (const tweet of tweets) {
    if (!isRecent(tweet.pubDate)) continue;
    if (state.replied.includes(tweet.tweetId)) continue;

    const text = tweet.title.toLowerCase();

    // Check transfer signal
    const hasTransfer = TRANSFER_SIGNALS.some(s => text.includes(s));
    if (!hasTransfer) continue;

    // Check UCL club
    const club = UCL_CLUBS.find(c => text.includes(c));
    if (!club) continue;

    const clubLabel = CLUB_REPLIES[club] || club;
    const replyText = buildReply(clubLabel, odds);

    log(`🎯 Match found: "${tweet.title.slice(0, 80)}" → replying as ${clubLabel}`);

    try {
      const result = await postReply(replyText, tweet.tweetId);
      log(`✅ Reply posted: ${result.data?.id}`);
      state.replied.push(tweet.tweetId);
      state.dailyCount++;
      saveState(state);

      if (state.dailyCount >= MAX_DAILY) {
        log('Daily limit reached. Stopping.');
        break;
      }
    } catch (e) {
      log(`❌ Reply failed: ${e.message}`);
    }
  }

  saveState(state);
  log('Done.');
}

main();
