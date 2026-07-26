#!/usr/bin/env node
// WhaleTrack Twitter Alert Bot
// Auto-tweets Polymarket whale trades >= $10K
// No npm deps — pure Node.js with built-in crypto + https

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');
const { generateCard } = require('./card-generator.cjs');

const BULLPEN = '/opt/homebrew/bin/bullpen';

// ── CONFIG ───────────────────────────────────────────────────────────
const API_KEY             = process.env.TWITTER_API_KEY;
const API_SECRET          = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN        = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ Missing Twitter credentials.');
  console.error('   Set: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET');
  process.exit(1);
}

const TWEET_MIN      = parseInt(process.env.TWEET_MIN     || '15000');   // $15K
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL || '300000');  // 5 min
const DAILY_LIMIT    = parseInt(process.env.DAILY_LIMIT   || '50');      // max tweets/day (pay-per-use)
const COOLDOWN_MS    = 25 * 60 * 1000;                                   // 25 min between tweets
const SEEN_FILE      = process.env.SEEN_FILE || path.join(__dirname, 'twitter_seen_trades.json');
const COUNTER_FILE   = path.join(__dirname, 'twitter_daily_count.json');
const LAST_TWEET_FILE = path.join(__dirname, 'twitter_last_tweet.json');

// ── KNOWN WHALE NAMES ────────────────────────────────────────────────
const KNOWN_NAMES = {
  '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
  '0xd9eee545c64c3f5c3acc088259289677858a89a4': 'somalianKing #2',
  '0xeccf1ecfcf3ffe049d48f60b4697ca91e8256603': 'Whale #3',
  '0x09b428f7c2b469786286214aa5c90dd9015f7320': 'DEEDDIT',
  '0x7c1ee865a785de4c00ee90ed86a38489fb8bbab3': 'CandleHammerDrums',
  '0x640de3430e9a05e1b1fe04b42d651da1abe99a4c': 'coldsway',
  '0x224a89dbe0db0d6124b335edabd15b3f877da3d5': 'wr0ngw4yb3tt0r',
  '0xe9a6ed2e4d4ee8ce47cd47cac834746dc4cf627b': 'Oneger',
  '0x83720820a8aa6c3f20ad71850e7a1a17d16c5223': 'Jsram',
  '0xc31d0a0d63d760d72a1236d16beaa6a71c854ebe': 'FootballFan98',
  '0xe72bb501df5306c75c89383d48a1e81073fbb0a0': 'norrisfan',
  '0xc6a63ad5a788a576d4acc9911c50fef9fde49458': 'filthybetz',
  '0x5e9458202b5817a72cf81105ec8a30e6f3705ba1': 'pleaseplease123',
  '0xa7b7505abe2fdcc497c00074534f7fbd7e07962e': 'gud.hl',
  '0xb809a4b78b5eadc71d84be43eda0491eedf72004': 'R88N',
  '0x56acab44cfca2e88bb9b3406890aea7bfa0cd77e': 'dv-pm',
  '0x412fe1a101554f0b382181c3af932e4b2d8030fa': 'GrizzliesSuck',
  '0xb61b2079b95f6b7476fd3203e0274ffb93308a06': 'hot2trot',
  '0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf': 'Sparkling8899',
  '0x50f0a0fc7364d3c10fc4578b9b1d955368335355': 'bettguy',
};

// ── WHALE NAME FORMATTER ─────────────────────────────────────────────
function formatWhaleName(name, addr) {
  // If it's a raw address or address-with-timestamp, truncate nicely
  const rawAddr = addr || '';
  if (!name || name.startsWith('0x') || name.match(/^0x[a-fA-F0-9]+-\d+$/)) {
    const clean = rawAddr.replace(/-\d+$/, ''); // strip timestamp suffix
    return clean.length > 10
      ? clean.slice(0, 6) + '…' + clean.slice(-4)
      : 'Unknown Whale';
  }
  return name;
}

// ── PERSISTENCE ──────────────────────────────────────────────────────
let seenTrades = new Set();

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      seenTrades = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
  } catch (e) { seenTrades = new Set(); }
}

function saveSeen() {
  try {
    const arr = [...seenTrades].slice(-500);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
    seenTrades = new Set(arr);
  } catch (e) {}
}

// ── DAILY TWEET COUNTER ───────────────────────────────────────────────
function getDailyCount() {
  try {
    if (!fs.existsSync(COUNTER_FILE)) return { date: '', count: 0 };
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch (e) { return { date: '', count: 0 }; }
}

function incrementDailyCount() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = getDailyCount();
  const count = data.date === today ? data.count + 1 : 1;
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify({ date: today, count })); } catch (e) {}
  return count;
}

function canTweetToday() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = getDailyCount();
  if (data.date !== today) return true; // new day, reset
  return data.count < DAILY_LIMIT;
}

// ── COOLDOWN (25 min between tweets) ─────────────────────────────────
function getLastTweetTime() {
  try {
    if (!fs.existsSync(LAST_TWEET_FILE)) return 0;
    const d = JSON.parse(fs.readFileSync(LAST_TWEET_FILE, 'utf8'));
    return d.ts || 0;
  } catch (e) { return 0; }
}

function saveLastTweetTime() {
  try { fs.writeFileSync(LAST_TWEET_FILE, JSON.stringify({ ts: Date.now() })); } catch (e) {}
}

function canTweetNow() {
  const elapsed = Date.now() - getLastTweetTime();
  if (elapsed < COOLDOWN_MS) {
    const waitMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
    console.log(`  ⏳ Cooldown active — next tweet in ~${waitMin}min`);
    return false;
  }
  return true;
}

// ── HTTP HELPER ──────────────────────────────────────────────────────
function fetchJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WhaleTrack-Bot/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── OAUTH 1.0a SIGNING ────────────────────────────────────────────────
function pct(s) { return encodeURIComponent(String(s)); }

// extraParams: additional body/query params to include in signature (for form-encoded requests)
function buildOAuthHeader(method, url, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
  };

  // Merge all signable params (OAuth + form body) before building signature
  const allParams = { ...oauthParams, ...extraParams };
  const paramStr = Object.keys(allParams).sort()
    .map(k => `${pct(k)}=${pct(allParams[k])}`)
    .join('&');

  const base    = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const sigKey  = `${pct(API_SECRET)}&${pct(ACCESS_TOKEN_SECRET)}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', sigKey).update(base).digest('base64');

  return 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${pct(k)}="${pct(oauthParams[k])}"`)
    .join(', ');
}

// ── TWITTER MEDIA UPLOAD ──────────────────────────────────────────────
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

// ── GENERATE + UPLOAD CARD (never blocks a tweet on failure) ─────────
async function getCardMediaId(tradeData) {
  try {
    const { imgPath } = await generateCard(tradeData);
    const mediaId = await uploadMedia(imgPath);
    try { fs.unlinkSync(imgPath); } catch (_) {}
    return mediaId;
  } catch (e) {
    console.log(`  ⚠️ Card skipped (tweeting text-only): ${e.message}`);
    return null;
  }
}

// ── POST TWEET ────────────────────────────────────────────────────────
function postTweet(text, mediaId = null) {
  return new Promise((resolve, reject) => {
    const url     = 'https://api.twitter.com/2/tweets';
    const payload = { text };
    if (mediaId) payload.media = { media_ids: [mediaId] };
    const body = JSON.stringify(payload);
    const auth = buildOAuthHeader('POST', url);

    const req = https.request({
      hostname: 'api.twitter.com',
      path:     '/2/tweets',
      method:   'POST',
      headers: {
        'Authorization':  auth,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (res.statusCode === 201) resolve(result);
          else reject(new Error(`Twitter ${res.statusCode}: ${d}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── TWEET A BET (shared helper used in both BET and fallback paths) ──
async function tweetBet(t, label = 'Bet') {
  const obContext = getOrderBookContext(t.slug, t.outcome, t.price);
  const text      = buildTweet(t, obContext);

  // Generate visual card
  const mediaId = await getCardMediaId({
    title:     t.title,
    outcome:   t.outcome,
    amount:    fmtUSD(t.usdcSize),
    price:     t.price,
    whaleName: t.whaleName,
  });

  console.log(`  → ${label} Tweet${mediaId ? ' 🖼️' : ''}: ${t.whaleName} ${fmtUSD(t.usdcSize)} | ${text.length} chars`);
  const result   = await postTweet(text, mediaId);
  const tweetId  = result?.data?.id;
  const todayCount = incrementDailyCount();
  console.log(`  ✅ https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
  seenTrades.add(t.key);
  const marketKey = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
  seenTrades.add(marketKey);
  saveSeen();
  saveLastCycleType('bet');
  saveLastTweetTime();
}

// ── TWEET A WIN ──────────────────────────────────────────────────────
async function tweetWin(w) {
  const text = buildWinTweet(w);

  // Win card — use WHALE category (no outcome/price for wins)
  const mediaId = await getCardMediaId({
    title:     w.title,
    outcome:   'Yes',
    amount:    fmtUSD(w.usdcSize),
    price:     0.99,
    whaleName: w.whaleName,
  });

  console.log(`  → Win Tweet${mediaId ? ' 🖼️' : ''}: ${w.whaleName} ${fmtUSD(w.usdcSize)} | ${text.length} chars`);
  const result   = await postTweet(text, mediaId);
  const tweetId  = result?.data?.id;
  const todayCount = incrementDailyCount();
  console.log(`  ✅ Win: https://twitter.com/i/web/status/${tweetId} [${todayCount}/${DAILY_LIMIT} today]`);
  seenTrades.add(w.key);
  saveSeen();
  saveLastCycleType('win');
  saveLastTweetTime();
}

// ── POLYMARKET FETCH ──────────────────────────────────────────────────
function addrShort(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '?'; }

function fmtUSD(n) {
  n = Math.abs(parseFloat(n));
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

// Cache whale PnL from leaderboard
const whalePnl = {};

async function fetchWhaleAddresses() {
  try {
    const data = await fetchJson('https://data-api.polymarket.com/v1/leaderboard?limit=20');
    const addrs = (Array.isArray(data) ? data : [])
      .slice(0, 15)
      .map(t => {
        const addr = (t.proxyWallet || '').toLowerCase();
        if (addr && t.pnl) whalePnl[addr] = t.pnl;
        return addr;
      })
      .filter(Boolean);
    for (const addr of Object.keys(KNOWN_NAMES)) {
      if (!addrs.includes(addr.toLowerCase())) addrs.push(addr.toLowerCase());
    }
    return [...new Set(addrs)];
  } catch (e) {
    return Object.keys(KNOWN_NAMES);
  }
}

async function fetchActivity(address, limit = 5) {
  try {
    const data = await fetchJson(
      `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`
    );
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

// ── SMART HASHTAG BUILDER ─────────────────────────────────────────────
function buildHashtags(title) {
  const t = title.toLowerCase();
  const tags = [];

  // ── UFC / MMA / Boxing ──
  const isUFC = t.includes('ufc') || t.includes(' mma') || t.includes('boxing');
  if (isUFC) {
    tags.push('#UFC', '#MMA');
    const ufcNum = title.match(/UFC\s*(\d+)/i);
    if (ufcNum) tags.push(`#UFC${ufcNum[1]}`);
    const fighters = {
      'jones':       '#JonJones',    'miocic':      '#StipeMiocic',
      'adesanya':    '#Adesanya',    'makhachev':   '#Makhachev',
      'poirier':     '#DustinPoirier','mcgregor':   '#McGregor',
      'conor':       '#McGregor',    'pereira':     '#AlexPereira',
      'topuria':     '#Topuria',     'volkanovski': '#Volkanovski',
      'usman':       '#KamaruUsman', 'aspinall':    '#TomAspinall',
      'holloway':    '#MaxHolloway', 'strickland':  '#Strickland',
      'oliveira':    '#Oliveira',    'gaethje':     '#Gaethje',
      'khabib':      '#Khabib',      'du plessis':  '#DricusDuPlessis',
      'chimaev':     '#Chimaev',     'diaz':        '#NateDiaz',
      'omalley':     '#SeanOMalley', 'shevchenko':  '#Shevchenko',
    };
    for (const [key, tag] of Object.entries(fighters)) {
      if (t.includes(key) && !tags.includes(tag)) tags.push(tag);
    }
    return tags.slice(0, 5);
  }

  // ── NBA / Basketball ──
  const isNBA = t.includes('nba') || t.includes('basketball') ||
    ['lakers','warriors','celtics','nuggets','bucks','heat','suns','sixers','76ers',
     'knicks','thunder','mavericks','mavs','grizzlies','timberwolves','spurs',
     'pelicans','hawks','clippers','cavaliers','cavs','kings','magic','pacers',
     'hornets','pistons','rockets','jazz','raptors','nets'].some(k => t.includes(k));
  if (isNBA) {
    tags.push('#NBA');
    const teams = {
      'lakers':       ['#Lakers',       '#LeBronJames'    ],
      'warriors':     ['#Warriors',     '#StephCurry'     ],
      'celtics':      ['#Celtics',      '#JaysonTatum'    ],
      'nuggets':      ['#Nuggets',      '#Jokic'          ],
      'bucks':        ['#Bucks',        '#Giannis'        ],
      'heat':         ['#Heat',         '#JimmyButler'    ],
      'suns':         ['#Suns',         '#KD'             ],
      '76ers':        ['#Sixers',       '#Embiid'         ],
      'sixers':       ['#Sixers',       '#Embiid'         ],
      'knicks':       ['#Knicks',       '#Brunson'        ],
      'thunder':      ['#Thunder',      '#SGA'            ],
      'mavericks':    ['#Mavs',         '#Luka'           ],
      'mavs':         ['#Mavs',         '#Luka'           ],
      'grizzlies':    ['#Grizzlies',    '#JaMorant'       ],
      'timberwolves': ['#Wolves',       '#AnthonyEdwards' ],
      'spurs':        ['#Spurs',        '#Wembanyama'     ],
      'pelicans':     ['#Pelicans',     '#Zion'           ],
      'hawks':        ['#Hawks',        '#TraeYoung'      ],
      'clippers':     ['#Clippers',     '#KawhiLeonard'   ],
      'cavaliers':    ['#Cavs',         '#DonovanMitchell'],
      'cavs':         ['#Cavs',         '#DonovanMitchell'],
      'kings':        ['#Kings',        '#DeAaronFox'     ],
      'magic':        ['#Magic',        '#Banchero'       ],
      'pacers':       ['#Pacers',       '#Haliburton'     ],
      'hornets':      ['#Hornets',      '#LaMelo'         ],
      'rockets':      ['#Rockets',      '#Sengun'         ],
      'raptors':      ['#Raptors',      '#ScottieBarnes'  ],
    };
    for (const [team, teamTags] of Object.entries(teams)) {
      if (t.includes(team)) { tags.push(...teamTags); break; }
    }
    // Second team for matchups
    let found = 0;
    for (const [team, teamTags] of Object.entries(teams)) {
      if (t.includes(team)) { found++; if (found === 2) { tags.push(teamTags[0]); break; } }
    }
    if (t.includes('finals'))    tags.push('#NBAFinals');
    if (t.includes('playoff'))   tags.push('#NBAPlayoffs');
    if (t.includes('mvp'))       tags.push('#MVP');
    if (t.includes('champion'))  tags.push('#NBAChampionship');
    return tags.slice(0, 5);
  }

  // ── NFL / American Football ──
  if (t.includes('nfl') || t.includes('super bowl') || t.includes('chiefs') || t.includes('football')) {
    tags.push('#NFL');
    if (t.includes('super bowl')) tags.push('#SuperBowl');
    if (t.includes('chiefs'))     tags.push('#Chiefs', '#PatrickMahomes');
    if (t.includes('49ers'))      tags.push('#49ers');
    if (t.includes('eagles'))     tags.push('#Eagles');
    if (t.includes('ravens'))     tags.push('#Ravens', '#LamarJackson');
    return tags.slice(0, 4);
  }

  // ── Soccer / Football ──
  if (t.includes('world cup') || t.includes('champions league') || t.includes('premier league') ||
      t.includes('real madrid') || t.includes('barcelona') || t.includes('arsenal') ||
      t.includes('manchester') || t.includes('soccer')) {
    tags.push('#Soccer', '#Football');
    if (t.includes('world cup'))        tags.push('#WorldCup');
    if (t.includes('champions league')) tags.push('#UCL', '#ChampionsLeague');
    if (t.includes('premier league'))   tags.push('#PremierLeague');
    if (t.includes('real madrid'))      tags.push('#RealMadrid');
    if (t.includes('barcelona'))        tags.push('#Barcelona');
    if (t.includes('arsenal'))          tags.push('#Arsenal');
    if (t.includes('manchester city'))  tags.push('#ManCity');
    if (t.includes('manchester united'))tags.push('#MUFC');
    return tags.slice(0, 4);
  }

  // ── F1 ──
  if (t.includes(' f1') || t.includes('formula 1') || t.includes('grand prix')) {
    tags.push('#F1', '#Formula1');
    if (t.includes('verstappen')) tags.push('#Verstappen');
    if (t.includes('hamilton'))   tags.push('#Hamilton');
    if (t.includes('norris'))     tags.push('#Norris');
    return tags.slice(0, 4);
  }

  // ── Politics ──
  const isPolitics = ['president', 'election', 'trump', 'biden', 'harris', 'congress',
    'senate', 'vote', 'republican', 'democrat', 'modi', 'macron', 'putin', 'zelensky',
    'political', 'governor', 'party'].some(k => t.includes(k));
  if (isPolitics) {
    tags.push('#Politics', '#Polymarket');
    if (t.includes('trump'))       { tags.push('#Trump', '#Republican'); }
    else if (t.includes('biden'))  { tags.push('#Biden', '#Democrat'); }
    else if (t.includes('harris')) { tags.push('#KamalaHarris', '#Democrat'); }
    else if (t.includes('modi'))   { tags.push('#Modi', '#India', '#BJP'); }
    else if (t.includes('macron')) { tags.push('#Macron', '#France'); }
    else if (t.includes('putin'))  { tags.push('#Putin', '#Russia'); }
    else if (t.includes('zelensky')) { tags.push('#Zelensky', '#Ukraine'); }
    else { tags.push('#Election', '#Politics'); }
    if (t.includes('election'))    tags.push('#Election2028');
    if (t.includes('republican'))  tags.push('#Republican');
    if (t.includes('democrat'))    tags.push('#Democrat');
    return tags.slice(0, 5);
  }

  // ── Crypto ──
  const isCrypto = ['bitcoin','btc','ethereum','eth','solana','sol','crypto','xrp',
    'doge','bnb','matic','avax','blockchain','defi','nft'].some(k => t.includes(k));
  if (isCrypto) {
    tags.push('#Crypto');
    if (t.includes('bitcoin')  || t.includes('btc'))     tags.push('#Bitcoin', '#BTC');
    if (t.includes('ethereum') || t.includes('eth'))     tags.push('#Ethereum', '#ETH');
    if (t.includes('solana')   || t.includes('sol'))     tags.push('#Solana', '#SOL');
    if (t.includes('xrp'))                               tags.push('#XRP');
    if (t.includes('doge'))                              tags.push('#Dogecoin', '#DOGE');
    if (t.includes('bnb'))                               tags.push('#BNB');
    if (t.includes('defi'))                              tags.push('#DeFi');
    if (t.includes('nft'))                               tags.push('#NFT');
    if (t.includes('all-time high') || t.includes('ath'))tags.push('#ATH');
    return tags.slice(0, 5);
  }

  return []; // default — no extra tags for generic markets
}

// ── TWEET FORMAT ──────────────────────────────────────────────────────
// ── ORDER BOOK CONTEXT ────────────────────────────────────────────────
// Fetches live ask depth so followers know if they can still copy the bet
function getOrderBookContext(slug, outcome, whaleFillPrice) {
  if (!slug || slug.startsWith('0x')) return null;
  try {
    const raw = execSync(`${BULLPEN} polymarket orderbook ${slug} --output json`, {
      timeout: 12000, maxBuffer: 2 * 1024 * 1024
    });
    const data = JSON.parse(raw.toString());

    // For Yes bets we look at asks; for No bets we look at bids
    const side = outcome === 'No' ? (data.bids || []) : (data.asks || []);
    if (!side.length) return null;

    const bestPrice = side[0].price;
    // Sum liquidity within 3¢ of best price (what a follower could actually buy)
    const depth = side
      .filter(l => Math.abs(l.price - bestPrice) <= 0.03)
      .reduce((sum, l) => sum + l.size, 0);
    if (depth < 100) return null; // not enough to be useful

    const bestCents  = Math.round(bestPrice * 100);
    const fillCents  = Math.round(whaleFillPrice * 100);
    const depthStr   = depth >= 1000 ? `$${Math.round(depth / 1000)}K` : `$${Math.round(depth)}`;
    const priceMoved = bestCents - fillCents; // positive = price went up since whale filled

    if (priceMoved > 2) {
      // Price moved against followers — warn them
      return `💧 ${depthStr} left @ ${bestCents}¢ (whale got ${fillCents}¢ — moved +${priceMoved}¢)`;
    } else {
      return `💧 ${depthStr} still available @ ${bestCents}¢`;
    }
  } catch (e) {
    return null; // never block a tweet for this
  }
}

function buildTweet(t, obContext) {
  const outcomeEmoji = t.outcome === 'Yes' ? '🟢' : t.outcome === 'No' ? '🔴' : '⚪';
  const price = (t.price * 100).toFixed(0);

  // Twitter counts any URL as 23 chars — keep title short to fit
  const maxTitle = 60;
  const rawTitle = t.title || 'Unknown Market';
  // Clean up raw slug-style titles like "Will France win on 2026-07-09?"
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title = cleanTitle.length > maxTitle
    ? cleanTitle.slice(0, maxTitle - 1) + '…'
    : cleanTitle;

  // Smart hashtags based on market category
  const extraTags  = buildHashtags(rawTitle);
  const baseTag    = t.usdcSize >= 50000 ? '@Polymarket #Polymarket' : '#Polymarket';
  const allTags    = [baseTag, '#PredictionMarkets', ...extraTags].join(' ');
  const tags       = `📋 Copy this bet → whaletrack.app | ${allTags}`;

  // Show whale's total profit if available
  const addrKey = (t.proxyWallet || '').toLowerCase();
  const pnl = whalePnl[addrKey];
  const pnlStr = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)} on Polymarket)` : '';

  const lines = [
    `🐋 Whale Alert!`,
    ``,
    `${t.whaleName}${pnlStr} just bet ${fmtUSD(t.usdcSize)} on ${outcomeEmoji} ${t.outcome} @ ${price}¢`,
    ``,
    `📊 ${title}`,
  ];

  if (obContext) {
    lines.push(``);
    lines.push(obContext);
  }

  lines.push(``);
  lines.push(`Would you copy this bet? 👇`);
  lines.push(``);
  lines.push(tags);

  return lines.join('\n');
}

// ── WIN TWEET ─────────────────────────────────────────────────────────
function buildWinTweet(t) {
  const rawTitle = t.title || 'Unknown Market';
  const cleanTitle = rawTitle.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i, '?').trim();
  const title = cleanTitle.length > 60 ? cleanTitle.slice(0, 59) + '…' : cleanTitle;
  const addrKey = (t.proxyWallet || '').toLowerCase();
  const pnl = whalePnl[addrKey];
  const pnlStr = pnl && pnl > 0 ? ` (up ${fmtUSD(pnl)} total)` : '';
  const extraTags = buildHashtags(rawTitle);
  const allTags   = ['#Polymarket', '#PredictionMarkets', ...extraTags].join(' ');
  return [
    `✅ Whale Win!`,
    ``,
    `${t.whaleName}${pnlStr} just collected ${fmtUSD(t.usdcSize)} on ${title}`,
    ``,
    `Think they'll bet big again? 👇`,
    ``,
    `📋 Copy their next bet → whaletrack.app | ${allTags}`,
  ].join('\n');
}

// ── CYCLE TRACKER (alternate bet vs win tweets) ───────────────────────
const CYCLE_FILE = path.join(__dirname, 'twitter_cycle.json');
function getLastCycleType() {
  try {
    if (fs.existsSync(CYCLE_FILE)) return JSON.parse(fs.readFileSync(CYCLE_FILE, 'utf8')).last || 'win';
  } catch (e) {}
  return 'win'; // default so first cycle tweets a bet
}
function saveLastCycleType(type) {
  try { fs.writeFileSync(CYCLE_FILE, JSON.stringify({ last: type })); } catch (e) {}
}

// ── MAIN CHECK ────────────────────────────────────────────────────────
let cachedAddresses = [];

async function checkAndTweet() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Checking whale activity...`);

  try {
    const addrs = await fetchWhaleAddresses();
    if (addrs.length) cachedAddresses = addrs;
    const addresses = cachedAddresses.length ? cachedAddresses : Object.keys(KNOWN_NAMES);

    const results = await Promise.allSettled(addresses.map(a => fetchActivity(a, 10)));

    const bigTrades = [];
    const bigWins = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const addr = addresses[i];
      for (const t of results[i].value) {
        // Detect wins (REDEEM = collected winnings)
        if (t.type === 'REDEEM' && parseFloat(t.usdcSize || 0) >= 100000) {
          const tsMs = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
          if (Date.now() - tsMs <= 86400000) {
            const winKey = `win-${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
            if (!seenTrades.has(winKey)) {
              bigWins.push({
                key: winKey,
                whaleName: KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || formatWhaleName(t.name, t.proxyWallet || addr),
                usdcSize: parseFloat(t.usdcSize || 0),
                title: t.title || 'Unknown Market',
                proxyWallet: t.proxyWallet || addr,
                timestamp: t.timestamp || 0,
              });
            }
          }
        }
        if (t.side !== 'BUY') continue;
        if (parseFloat(t.usdcSize || 0) < TWEET_MIN) continue;
        // Skip trades older than 24 hours
        const tsMs = t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000;
        if (Date.now() - tsMs > 86400000) continue;
        const key = `${(t.proxyWallet || addr).toLowerCase()}-${t.timestamp}`;
        // Deduplicate by whale + market (ignore multiple trades same whale same market)
        const marketKey = `market-${(t.proxyWallet || addr).toLowerCase()}-${t.slug || t.title || ''}`;
        if (seenTrades.has(key) || seenTrades.has(marketKey)) continue;
        bigTrades.push({
          key,
          whaleName: KNOWN_NAMES[(t.proxyWallet || addr).toLowerCase()] || KNOWN_NAMES[addr] || formatWhaleName(t.name, t.proxyWallet || addr),
          outcome:   t.outcome  || '—',
          usdcSize:  parseFloat(t.usdcSize || 0),
          price:     parseFloat(t.price    || 0),
          title:     t.title    || 'Unknown Market',
          slug:      t.slug     || '',
          timestamp: t.timestamp || 0,
        });
      }
    }

    bigTrades.sort((a, b) => b.timestamp - a.timestamp);
    // Deduplicate within this cycle by market key (same whale, same market)
    const seenThisCycle = new Set();
    const deduped = bigTrades.filter(t => {
      const mk = `market-${t.key.split('-')[0]}-${t.slug || t.title || ''}`;
      if (seenThisCycle.has(mk)) return false;
      seenThisCycle.add(mk);
      return true;
    });
    const toTweet = deduped.slice(0, 3); // max 3 per cycle to avoid rate limits

    // Alternate bet and win tweets each cycle
    const lastCycle = getLastCycleType();
    const doWinThisCycle = lastCycle === 'bet';

    if (!canTweetToday()) {
      console.log(`  ⚠️ Daily limit (${DAILY_LIMIT}) reached — skipping until tomorrow.`);
    } else if (!canTweetNow()) {
      // cooldown message already logged inside canTweetNow()
    } else if (doWinThisCycle) {
      // WIN cycle — tweet 1 win (with card)
      bigWins.sort((a, b) => b.timestamp - a.timestamp);
      const w = bigWins[0];
      if (w) {
        try { await tweetWin(w); }
        catch (e) { console.error(`  ❌ Win tweet failed: ${e.message}`); }
      } else {
        console.log(`  No new $100K+ wins — falling back to bet tweet.`);
        const t = toTweet[0];
        if (t) {
          try { await tweetBet(t, 'Bet (fallback)'); }
          catch (e) { console.error(`  ❌ Failed: ${e.message}`); }
        } else {
          console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found either.`);
        }
      }
    } else {
      // BET cycle — tweet 1 bet (with card)
      const t = toTweet[0];
      if (t) {
        try { await tweetBet(t); }
        catch (e) { console.error(`  ❌ Failed: ${e.message}`); }
      } else {
        console.log(`  No new ${fmtUSD(TWEET_MIN)}+ trades found.`);
      }
    }
  } catch (e) {
    console.error(`[Error] ${e.message}`);
  }
}

// ── START (one-shot, runs via cron every 5 min) ───────────────────────
loadSeen();
checkAndTweet();
