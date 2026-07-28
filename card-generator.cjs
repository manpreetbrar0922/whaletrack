#!/usr/bin/env node
// WhaleTrack Card Generator
// Generates fancy visual cards for tweets based on market category
// Categories: POLITICS, CRYPTO, SPORTS, WHALE (default)

const puppeteer = require('puppeteer');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

// ── CATEGORY DETECTION ──────────────────────────────────────────────
const POLITICS_KEYWORDS = ['president', 'election', 'trump', 'biden', 'harris', 'congress', 'senate', 'vote', 'republican', 'democrat', 'prime minister', 'modi', 'macron', 'putin', 'zelensky', 'political', 'governor', 'mayor', 'party'];
const CRYPTO_KEYWORDS   = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto', 'token', 'coin', 'doge', 'xrp', 'bnb', 'matic', 'avax', 'ada', 'link', 'uni', 'aave', 'price', '$100k', '$50k', 'all-time high', 'ath', 'blockchain', 'defi', 'nft'];
const SPORTS_KEYWORDS   = ['game', 'match', 'win', 'championship', 'nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'tennis', 'golf', 'f1', 'ufc', 'mma', 'boxing', 'world cup', 'super bowl', 'playoff', 'finals', 'lakers', 'warriors', 'chiefs', 'yankees', 'manchester', 'arsenal', 'real madrid', 'barcelona'];

// Known UFC fighters for title detection
const UFC_FIGHTERS = [
  'jones', 'ngannou', 'miocic', 'cormier', 'adesanya', 'pereira', 'makhachev',
  'volkanovski', 'poirier', 'mcgregor', 'khabib', 'usman', 'edwards', 'covington',
  'strickland', 'du plessis', 'aspinall', 'błachowicz', 'blachowicz', 'holloway',
  'topuria', 'pimblett', 'o\'malley', 'omalley', 'dvalishvili', 'pantoja', 'moreno',
  'shevchenko', 'nunes', 'pena', 'namajunas', 'zhang', 'cyborg', 'rousey',
  'whittaker', 'vettori', 'romero', 'costa', 'cannonier', 'imavov', 'chimaev',
  'diaz', 'masvidal', 'till', 'wonderboy', 'woodley', 'conor', 'dustin',
  'oliveira', 'gaethje', 'chandler', 'hooker', 'kattar', 'allen', 'ankalaev',
];

function detectCategory(title) {
  const t = title.toLowerCase();
  if (POLITICS_KEYWORDS.some(k => t.includes(k))) return 'POLITICS';
  if (CRYPTO_KEYWORDS.some(k => t.includes(k)))   return 'CRYPTO';
  if (SPORTS_KEYWORDS.some(k => t.includes(k)))   return 'SPORTS';
  return 'WHALE';
}

// Detect UFC/MMA specifically within SPORTS
function isUFCMarket(title) {
  const t = title.toLowerCase();
  return t.includes('ufc') || t.includes(' mma') || t.includes('boxing') ||
         UFC_FIGHTERS.some(f => t.includes(f));
}

// Extract two fighter names from title
function extractFighters(title) {
  const t = title.trim();

  // Pattern: "A vs B", "A vs. B", "A v B"
  const vsMatch = t.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-–—:]|\?|$)/i);
  if (vsMatch) {
    return [vsMatch[1].trim(), vsMatch[2].trim()];
  }

  // Pattern: "Will A beat/defeat/knock out B"
  const beatMatch = t.match(/will\s+(.+?)\s+(?:beat|defeat|knock out|stop|submit|finish)\s+(.+?)(?:\s*\?|$)/i);
  if (beatMatch) {
    return [beatMatch[1].trim(), beatMatch[2].trim()];
  }

  // Pattern: "A beats/defeats B"
  const beatsMatch = t.match(/^(.+?)\s+(?:beats|defeats|knocks out)\s+(.+?)(?:\s*\?|$)/i);
  if (beatsMatch) {
    return [beatsMatch[1].trim(), beatsMatch[2].trim()];
  }

  // Pattern: "Will A win [at UFC...]"  — single fighter
  const winMatch = t.match(/will\s+(.+?)\s+(?:win|retain|defend)/i);
  if (winMatch) {
    return [winMatch[1].trim(), null];
  }

  return [null, null];
}

// ── NBA TEAM → STAR PLAYER MAP ───────────────────────────────────────
const NBA_TEAM_STARS = {
  lakers:       { player: 'LeBron James',              colors: { team1: '#552583', team2: '#FDB927' } },
  warriors:     { player: 'Stephen Curry',             colors: { team1: '#1D428A', team2: '#FFC72C' } },
  celtics:      { player: 'Jayson Tatum',              colors: { team1: '#007A33', team2: '#BA9653' } },
  nuggets:      { player: 'Nikola Jokić',              colors: { team1: '#0E2240', team2: '#FEC524' } },
  bucks:        { player: 'Giannis Antetokounmpo',     colors: { team1: '#00471B', team2: '#EEE1C6' } },
  heat:         { player: 'Jimmy Butler',              colors: { team1: '#98002E', team2: '#F9A01B' } },
  suns:         { player: 'Kevin Durant',              colors: { team1: '#1D1160', team2: '#E56020' } },
  '76ers':      { player: 'Joel Embiid',               colors: { team1: '#006BB6', team2: '#ED174C' } },
  sixers:       { player: 'Joel Embiid',               colors: { team1: '#006BB6', team2: '#ED174C' } },
  knicks:       { player: 'Jalen Brunson',             colors: { team1: '#006BB6', team2: '#F58426' } },
  thunder:      { player: 'Shai Gilgeous-Alexander',  colors: { team1: '#007AC1', team2: '#EF3B24' } },
  mavericks:    { player: 'Luka Dončić',               colors: { team1: '#00538C', team2: '#002B5E' } },
  mavs:         { player: 'Luka Dončić',               colors: { team1: '#00538C', team2: '#002B5E' } },
  grizzlies:    { player: 'Ja Morant',                 colors: { team1: '#5D76A9', team2: '#12173F' } },
  timberwolves: { player: 'Anthony Edwards',           colors: { team1: '#236192', team2: '#9EA1A2' } },
  wolves:       { player: 'Anthony Edwards',           colors: { team1: '#236192', team2: '#9EA1A2' } },
  spurs:        { player: 'Victor Wembanyama',         colors: { team1: '#C4CED4', team2: '#000000' } },
  pelicans:     { player: 'Zion Williamson',           colors: { team1: '#0C2340', team2: '#C8102E' } },
  hawks:        { player: 'Trae Young',                colors: { team1: '#E03A3E', team2: '#C1D32F' } },
  clippers:     { player: 'Kawhi Leonard',             colors: { team1: '#C8102E', team2: '#1D428A' } },
  cavaliers:    { player: 'Donovan Mitchell',          colors: { team1: '#860038', team2: '#FDBB30' } },
  cavs:         { player: 'Donovan Mitchell',          colors: { team1: '#860038', team2: '#FDBB30' } },
  kings:        { player: 'De\'Aaron Fox',             colors: { team1: '#5A2D81', team2: '#63727A' } },
  magic:        { player: 'Paolo Banchero',            colors: { team1: '#0077C0', team2: '#C4CED4' } },
  pacers:       { player: 'Tyrese Haliburton',         colors: { team1: '#002D62', team2: '#FDBB30' } },
  hornets:      { player: 'LaMelo Ball',               colors: { team1: '#1D1160', team2: '#00788C' } },
  pistons:      { player: 'Cade Cunningham',           colors: { team1: '#C8102E', team2: '#1D42BA' } },
  rockets:      { player: 'Alperen Şengün',            colors: { team1: '#CE1141', team2: '#000000' } },
  jazz:         { player: 'Lauri Markkanen',           colors: { team1: '#002B5C', team2: '#00471B' } },
  raptors:      { player: 'Scottie Barnes',            colors: { team1: '#CE1141', team2: '#000000' } },
  nets:         { player: 'Mikal Bridges',             colors: { team1: '#000000', team2: '#FFFFFF' } },
};

// Direct NBA player name detection
const NBA_PLAYERS = {
  'lebron':       'LeBron James',
  'lebron james': 'LeBron James',
  'curry':        'Stephen Curry',
  'steph':        'Stephen Curry',
  'tatum':        'Jayson Tatum',
  'jokic':        'Nikola Jokić',
  'giannis':      'Giannis Antetokounmpo',
  'durant':       'Kevin Durant',
  'kd':           'Kevin Durant',
  'embiid':       'Joel Embiid',
  'luka':         'Luka Dončić',
  'doncic':       'Luka Dončić',
  'sga':          'Shai Gilgeous-Alexander',
  'morant':       'Ja Morant',
  'ja morant':    'Ja Morant',
  'wembanyama':   'Victor Wembanyama',
  'wemby':        'Victor Wembanyama',
  'trae':         'Trae Young',
  'ant':          'Anthony Edwards',
  'edwards':      'Anthony Edwards',
  'mitchell':     'Donovan Mitchell',
  'banchero':     'Paolo Banchero',
  'zion':         'Zion Williamson',
  'lamelo':       'LaMelo Ball',
  'haliburton':   'Tyrese Haliburton',
  'brunson':      'Jalen Brunson',
  'fox':          'De\'Aaron Fox',
};

// Detect if title is specifically NBA
function isNBAMarket(title) {
  const t = title.toLowerCase();
  return t.includes('nba') || t.includes('basketball') ||
    Object.keys(NBA_TEAM_STARS).some(k => t.includes(k)) ||
    Object.keys(NBA_PLAYERS).some(k => t.includes(k));
}

// Extract team stars from title — returns [{team, star, colors}, ...]
function extractNBATeams(title) {
  const t = title.toLowerCase();
  const found = [];
  for (const [key, val] of Object.entries(NBA_TEAM_STARS)) {
    if (t.includes(key) && !found.find(f => f.player === val.player)) {
      found.push({ key, ...val });
      if (found.length === 2) break;
    }
  }
  return found;
}

// Extract specific player mentioned in title
function extractNBAPlayer(title) {
  const t = title.toLowerCase();
  for (const [key, wikiName] of Object.entries(NBA_PLAYERS)) {
    if (t.includes(key)) return wikiName;
  }
  return null;
}

// Wikipedia article names for known fighters
const FIGHTER_WIKI = {
  'jones':        'Jon Jones',
  'jon jones':    'Jon Jones',
  'ngannou':      'Francis Ngannou',
  'miocic':       'Stipe Miocic',
  'adesanya':     'Israel Adesanya',
  'alex pereira': 'Alex Pereira (fighter)',
  'pereira':      'Alex Pereira (fighter)',
  'makhachev':    'Islam Makhachev',
  'volkanovski':  'Alexander Volkanovski',
  'poirier':      'Dustin Poirier',
  'mcgregor':     'Conor McGregor',
  'conor':        'Conor McGregor',
  'khabib':       'Khabib Nurmagomedov',
  'usman':        'Kamaru Usman',
  'edwards':      'Leon Edwards',
  'strickland':   'Sean Strickland',
  'aspinall':     'Tom Aspinall',
  'holloway':     'Max Holloway',
  'topuria':      'Ilia Topuria',
  'o\'malley':    'Sean O\'Malley',
  'omalley':      'Sean O\'Malley',
  'shevchenko':   'Valentina Shevchenko',
  'nunes':        'Amanda Nunes',
  'rousey':       'Ronda Rousey',
  'oliveira':     'Charles Oliveira',
  'gaethje':      'Justin Gaethje',
  'diaz':         'Nate Diaz',
  'masvidal':     'Jorge Masvidal',
  'pantoja':      'Alexandre Pantoja',
  'du plessis':   'Dricus du Plessis',
  'chimaev':      'Khamzat Chimaev',
  'whittaker':    'Robert Whittaker',
  'cormier':      'Daniel Cormier',
};

// ── CRYPTO COLORS ───────────────────────────────────────────────────
const CRYPTO_COLORS = {
  bitcoin:  { primary: '#F7931A', secondary: '#FF6B00', glow: 'rgba(247,147,26,0.45)', icon: '₿',   label: 'Bitcoin'   },
  btc:      { primary: '#F7931A', secondary: '#FF6B00', glow: 'rgba(247,147,26,0.45)', icon: '₿',   label: 'Bitcoin'   },
  ethereum: { primary: '#627EEA', secondary: '#3C55C9', glow: 'rgba(98,126,234,0.45)', icon: 'Ξ',   label: 'Ethereum'  },
  eth:      { primary: '#627EEA', secondary: '#3C55C9', glow: 'rgba(98,126,234,0.45)', icon: 'Ξ',   label: 'Ethereum'  },
  solana:   { primary: '#9945FF', secondary: '#14F195', glow: 'rgba(153,69,255,0.45)', icon: '◎',   label: 'Solana'    },
  sol:      { primary: '#9945FF', secondary: '#14F195', glow: 'rgba(153,69,255,0.45)', icon: '◎',   label: 'Solana'    },
  xrp:      { primary: '#00AAE4', secondary: '#005580', glow: 'rgba(0,170,228,0.45)',  icon: '✕',   label: 'XRP'       },
  doge:     { primary: '#C2A633', secondary: '#8B7525', glow: 'rgba(194,166,51,0.45)', icon: 'Ð',   label: 'Dogecoin'  },
  bnb:      { primary: '#F3BA2F', secondary: '#D4A017', glow: 'rgba(243,186,47,0.45)', icon: 'BNB', label: 'BNB'       },
  matic:    { primary: '#8247E5', secondary: '#5A31A0', glow: 'rgba(130,71,229,0.45)', icon: '⬡',   label: 'Polygon'   },
  avax:     { primary: '#E84142', secondary: '#A02020', glow: 'rgba(232,65,66,0.45)',  icon: 'A',   label: 'Avalanche' },
  default:  { primary: '#58a6ff', secondary: '#1A4A8A', glow: 'rgba(88,166,255,0.45)', icon: '◈',   label: 'Crypto'    },
};

function getCryptoTheme(title) {
  const t = title.toLowerCase();
  for (const [key, val] of Object.entries(CRYPTO_COLORS)) {
    if (key !== 'default' && t.includes(key)) return val;
  }
  return CRYPTO_COLORS.default;
}

// ── POLITICS THEMES ─────────────────────────────────────────────────
const POLITICS_THEMES = {
  republican: { bg1: '#B22222', bg2: '#6B0000', accent: '#FF5555', flag: '🇺🇸', party: 'Republican' },
  democrat:   { bg1: '#1C4587', bg2: '#0A2463', accent: '#5599FF', flag: '🇺🇸', party: 'Democrat'   },
  trump:      { bg1: '#B22222', bg2: '#6B0000', accent: '#FF5555', flag: '🇺🇸', party: 'Republican' },
  biden:      { bg1: '#1C4587', bg2: '#0A2463', accent: '#5599FF', flag: '🇺🇸', party: 'Democrat'   },
  harris:     { bg1: '#1C4587', bg2: '#0A2463', accent: '#5599FF', flag: '🇺🇸', party: 'Democrat'   },
  modi:       { bg1: '#FF6B00', bg2: '#B33000', accent: '#FFB347', flag: '🇮🇳', party: 'BJP'        },
  macron:     { bg1: '#002395', bg2: '#001060', accent: '#4477FF', flag: '🇫🇷', party: 'France'     },
  putin:      { bg1: '#003580', bg2: '#001540', accent: '#4488FF', flag: '🇷🇺', party: 'Russia'     },
  zelensky:   { bg1: '#005BBB', bg2: '#003080', accent: '#FFD500', flag: '🇺🇦', party: 'Ukraine'    },
  default:    { bg1: '#1a1a2e', bg2: '#0d0d1a', accent: '#E94560', flag: '🗳️',  party: 'Politics'   },
};

function getPoliticsTheme(title) {
  const t = title.toLowerCase();
  for (const [key, val] of Object.entries(POLITICS_THEMES)) {
    if (key !== 'default' && t.includes(key)) return val;
  }
  return POLITICS_THEMES.default;
}

// ── SPORTS THEMES ───────────────────────────────────────────────────
const SPORTS_THEMES = {
  lakers:        { team1: '#552583', team2: '#FDB927', emoji: '🏀', sport: 'NBA'    },
  warriors:      { team1: '#1D428A', team2: '#FFC72C', emoji: '🏀', sport: 'NBA'    },
  celtics:       { team1: '#007A33', team2: '#BA9653', emoji: '🏀', sport: 'NBA'    },
  chiefs:        { team1: '#E31837', team2: '#FFB81C', emoji: '🏈', sport: 'NFL'    },
  'real madrid': { team1: '#00529F', team2: '#FEBE10', emoji: '⚽', sport: 'Soccer' },
  barcelona:     { team1: '#A50044', team2: '#004D98', emoji: '⚽', sport: 'Soccer' },
  arsenal:       { team1: '#EF0107', team2: '#063672', emoji: '⚽', sport: 'Soccer' },
  'man city':    { team1: '#6CABDD', team2: '#1C2C5B', emoji: '⚽', sport: 'Soccer' },
  nba:           { team1: '#1D428A', team2: '#C8102E', emoji: '🏀', sport: 'NBA'    },
  nfl:           { team1: '#013369', team2: '#D50A0A', emoji: '🏈', sport: 'NFL'    },
  soccer:        { team1: '#1E6B3C', team2: '#FFFFFF', emoji: '⚽', sport: 'Soccer' },
  football:      { team1: '#013369', team2: '#D50A0A', emoji: '🏈', sport: 'NFL'    },
  tennis:        { team1: '#4CAF50', team2: '#FFEB3B', emoji: '🎾', sport: 'Tennis' },
  golf:          { team1: '#2E7D32', team2: '#FFFFFF', emoji: '⛳', sport: 'Golf'   },
  f1:            { team1: '#E10600', team2: '#1C1C1C', emoji: '🏎️', sport: 'F1'     },
  ufc:           { team1: '#D20A0A', team2: '#1C1C1C', emoji: '🥊', sport: 'UFC'   },
  boxing:        { team1: '#D20A0A', team2: '#1C1C1C', emoji: '🥊', sport: 'Boxing'},
  default:       { team1: '#1a1a2e', team2: '#16213e', emoji: '🏆', sport: 'Sports' },
};

function getSportsTheme(title) {
  const t = title.toLowerCase();
  for (const [key, val] of Object.entries(SPORTS_THEMES)) {
    if (key !== 'default' && t.includes(key)) return val;
  }
  return SPORTS_THEMES.default;
}

// ── KNOWN POLITICIAN → WIKIPEDIA ARTICLE MAP ─────────────────────────
const POLITICIAN_WIKI = {
  trump:    'Donald Trump',
  biden:    'Joe Biden',
  harris:   'Kamala Harris',
  obama:    'Barack Obama',
  clinton:  'Hillary Clinton',
  modi:     'Narendra Modi',
  macron:   'Emmanuel Macron',
  putin:    'Vladimir Putin',
  zelensky: 'Volodymyr Zelenskyy',
  vance:    'JD Vance',
  desantis: 'Ron DeSantis',
  newsom:   'Gavin Newsom',
};

// ── DOWNLOAD IMAGE AS BASE64 DATA URL ────────────────────────────────
function downloadImageBase64(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'WhaleTrack/1.0 (https://whaletrack.app)' } }, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImageBase64(res.headers.location).then(resolve);
      }
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf  = Buffer.concat(chunks);
          const mime = res.headers['content-type'] || 'image/jpeg';
          resolve(`data:${mime};base64,${buf.toString('base64')}`);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ── WIKIPEDIA IMAGE FETCH (returns base64 data URL) ──────────────────
const tryRestApi = (title) => new Promise((resolve) => {
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  const url  = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
  https.get(url, { headers: { 'User-Agent': 'WhaleTrack/1.0' } }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', async () => {
      try {
        const json = JSON.parse(data);
        resolve(json?.thumbnail?.source || json?.originalimage?.source || null);
      } catch { resolve(null); }
    });
  }).on('error', () => resolve(null));
});

async function fetchWikiImage(searchTerm, knownMap = {}) {
  const key = searchTerm.toLowerCase();

  // Try known map first (politicians or fighters)
  for (const [k, wikiTitle] of Object.entries(knownMap)) {
    if (key.includes(k)) {
      const imgUrl = await tryRestApi(wikiTitle);
      if (imgUrl) return downloadImageBase64(imgUrl);
    }
  }

  // Fallback: try as-is, then with common suffixes
  for (const attempt of [searchTerm, searchTerm + ' politician', searchTerm + ' president', searchTerm + ' fighter']) {
    const imgUrl = await tryRestApi(attempt);
    if (imgUrl) return downloadImageBase64(imgUrl);
  }

  return null;
}

// Fetch fighter photo — checks FIGHTER_WIKI map first
async function fetchFighterImage(name) {
  if (!name) return null;
  return fetchWikiImage(name, FIGHTER_WIKI);
}

// ── EXTRACT PERSON NAME FROM TITLE ──────────────────────────────────
function extractPersonName(title) {
  // Check known politicians directly in title first
  const t = title.toLowerCase();
  for (const name of Object.keys(POLITICIAN_WIKI)) {
    if (t.includes(name)) return name;
  }
  // Pattern-based extraction
  const patterns = [
    /will ([\w]+(?:\s[\w]+)?) win/i,
    /will ([\w]+(?:\s[\w]+)?) become/i,
    /will ([\w]+(?:\s[\w]+)?) be /i,
    /([\w]+(?:\s[\w]+)?) (wins|wins the|elected|appointed|nominated|resigns)/i,
    /^([\w]+(?:\s[\w]+)?) (vs\.?|v\.)\s/i,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m && m[1] && m[1].length > 2 && m[1].length < 30) return m[1].trim();
  }
  return null;
}

// ── HTML CARD TEMPLATES ──────────────────────────────────────────────

function buildCryptoCard({ title, outcome, amount, price, whaleName, odds }) {
  const theme   = getCryptoTheme(title);
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card {
    width:800px; height:418px; position:relative;
    background: radial-gradient(ellipse at 28% 50%, ${theme.glow} 0%, transparent 55%),
                linear-gradient(135deg, #0a0e17 0%, #151c2c 50%, #0a0e17 100%);
    display:flex; align-items:center; overflow:hidden;
  }
  .bg-icon {
    position:absolute; right:-30px; top:50%; transform:translateY(-50%);
    font-size:340px; opacity:0.05; font-weight:900; line-height:1;
    color:${theme.primary}; user-select:none; letter-spacing:-10px;
  }
  .glow-orb {
    position:absolute; left:-80px; top:50%; transform:translateY(-50%);
    width:380px; height:380px; border-radius:50%;
    background: radial-gradient(circle, ${theme.glow} 0%, transparent 70%);
  }
  .token-circle {
    position:absolute; left:44px; top:50%; transform:translateY(-50%);
    width:190px; height:190px; border-radius:50%;
    background: radial-gradient(circle at 35% 30%, ${theme.primary}, ${theme.secondary});
    display:flex; align-items:center; justify-content:center;
    font-size:78px; color:#fff; font-weight:900;
    box-shadow: 0 0 80px ${theme.glow}, 0 0 140px ${theme.glow}, 0 24px 48px rgba(0,0,0,0.6);
    border: 2px solid ${theme.primary}55;
  }
  .content { position:relative; z-index:2; margin-left:274px; flex:1; padding-right:44px; }
  .category { font-size:11px; font-weight:800; color:${theme.primary}; text-transform:uppercase; letter-spacing:2.5px; margin-bottom:10px; }
  .title { font-size:25px; font-weight:800; color:#f0f6ff; line-height:1.3; margin-bottom:22px; }
  .odds-label { font-size:11px; color:#6b7a99; text-transform:uppercase; letter-spacing:1px; margin-bottom:9px; }
  .odds-bar { height:9px; border-radius:5px; background:#1e2535; overflow:hidden; margin-bottom:8px; }
  .odds-fill { height:100%; border-radius:5px; background:linear-gradient(90deg, ${theme.primary}, ${theme.secondary}); }
  .odds-nums { display:flex; justify-content:space-between; font-size:14px; font-weight:800; margin-bottom:22px; }
  .yes { color:${theme.primary}; } .no { color:#4a5568; }
  .trade-row { display:flex; align-items:center; gap:14px; }
  .amount { font-size:34px; font-weight:900; color:#f0f6ff; letter-spacing:-0.5px; }
  .outcome-badge {
    padding:5px 14px; border-radius:20px; font-size:14px; font-weight:800;
    background:${outcome==='Yes'?'rgba(63,185,80,0.2)':'rgba(248,81,73,0.2)'};
    color:${outcome==='Yes'?'#4ade80':'#f87171'};
    border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.45)':'rgba(248,113,113,0.45)'};
  }
  .whale { font-size:13px; color:#6b7a99; margin-top:10px; }
  .watermark { position:absolute; top:18px; right:22px; font-size:12px; color:#3d4f70; font-weight:800; letter-spacing:1.5px; }
  .brand { position:absolute; bottom:18px; right:22px; font-size:12px; color:#3d4f70; font-weight:700; }
</style></head><body>
<div class="card">
  <div class="bg-icon">${theme.icon}</div>
  <div class="glow-orb"></div>
  <div class="token-circle">${theme.icon}</div>
  <div class="content">
    <div class="category">🔥 ${theme.label} · Polymarket</div>
    <div class="title">${title.slice(0,80)}${title.length>80?'…':''}</div>
    <div class="odds-label">Market Odds</div>
    <div class="odds-bar"><div class="odds-fill" style="width:${yesOdds}%"></div></div>
    <div class="odds-nums"><span class="yes">YES ${yesOdds}¢</span><span class="no">NO ${noOdds}¢</span></div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName}</div>
  </div>
  <div class="watermark">WHALETRACK.APP</div>
  <div class="brand">whaletrack.app</div>
</div>
</body></html>`;
}

function buildPoliticsCard({ title, outcome, amount, price, whaleName, odds, personImage }) {
  const theme   = getPoliticsTheme(title);
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;

  // If we have a photo, show it; otherwise show a styled avatar/silhouette
  const leftPanel = personImage
    ? `<div class="person-wrap">
         <img src="${personImage}" class="person-img"/>
         <div class="person-shadow"></div>
       </div>`
    : `<div class="avatar-wrap">
         <div class="avatar-circle">
           <svg viewBox="0 0 100 100" width="110" height="110" fill="none">
             <circle cx="50" cy="36" r="22" fill="rgba(255,255,255,0.25)"/>
             <ellipse cx="50" cy="95" rx="36" ry="28" fill="rgba(255,255,255,0.25)"/>
           </svg>
         </div>
         <div class="avatar-flag">${theme.flag}</div>
       </div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card {
    width:800px; height:418px; position:relative; overflow:hidden;
    background: linear-gradient(140deg, ${theme.bg1} 0%, ${theme.bg2} 100%);
    display:flex; align-items:stretch;
  }
  .stripe-overlay {
    position:absolute; inset:0; opacity:0.06;
    background: repeating-linear-gradient(48deg, #fff 0px, #fff 1px, transparent 1px, transparent 22px);
  }
  .accent-bar { position:absolute; left:0; top:0; bottom:0; width:5px; background:linear-gradient(180deg,${theme.accent},${theme.bg2}); }
  .left-panel { width:290px; position:relative; display:flex; align-items:flex-end; justify-content:center; overflow:hidden; }
  .left-glow { position:absolute; inset:0; background:radial-gradient(ellipse at 50% 85%, ${theme.accent}44 0%, transparent 65%); }
  /* Photo mode */
  .person-wrap { position:relative; z-index:2; width:230px; height:360px; }
  .person-img { width:100%; height:100%; object-fit:cover; object-position:top center; filter:drop-shadow(0 0 24px ${theme.accent}77); }
  .person-shadow { position:absolute; bottom:0; left:0; right:0; height:120px; background:linear-gradient(transparent, ${theme.bg2}cc); }
  /* Avatar mode */
  .avatar-wrap { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; padding-bottom:32px; height:100%; }
  .avatar-circle { width:160px; height:160px; border-radius:50%; background:${theme.accent}22; border:2px solid ${theme.accent}44; display:flex; align-items:center; justify-content:center; margin-bottom:16px; }
  .avatar-flag { font-size:56px; }
  /* Right panel */
  .right-panel { flex:1; display:flex; flex-direction:column; justify-content:center; padding:32px 36px 32px 20px; position:relative; z-index:2; }
  .party-badge { display:inline-flex; align-items:center; gap:7px; background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.25); border-radius:20px; padding:5px 14px; font-size:11px; font-weight:800; color:#fff; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:18px; width:fit-content; }
  .title { font-size:24px; font-weight:800; color:#fff; line-height:1.35; margin-bottom:22px; text-shadow:0 2px 12px rgba(0,0,0,0.6); }
  .odds-label { font-size:10px; color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:1.5px; margin-bottom:8px; }
  .odds-bar { height:7px; border-radius:4px; background:rgba(255,255,255,0.12); overflow:hidden; margin-bottom:8px; }
  .odds-fill { height:100%; border-radius:4px; background:linear-gradient(90deg, ${theme.accent}, rgba(255,255,255,0.9)); }
  .odds-nums { display:flex; justify-content:space-between; font-size:13px; font-weight:800; margin-bottom:20px; }
  .yes { color:#fff; } .no { color:rgba(255,255,255,0.35); }
  .trade-row { display:flex; align-items:center; gap:14px; }
  .amount { font-size:32px; font-weight:900; color:#fff; letter-spacing:-0.5px; }
  .outcome-badge { padding:5px 16px; border-radius:20px; font-size:14px; font-weight:800; background:${outcome==='Yes'?'rgba(63,185,80,0.3)':'rgba(248,81,73,0.3)'}; color:${outcome==='Yes'?'#4ade80':'#f87171'}; border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.5)':'rgba(248,113,113,0.5)'}; }
  .whale { font-size:13px; color:rgba(255,255,255,0.45); margin-top:10px; }
  .brand { position:absolute; bottom:16px; right:22px; font-size:12px; color:rgba(255,255,255,0.35); font-weight:800; letter-spacing:1px; }
</style></head><body>
<div class="card">
  <div class="stripe-overlay"></div>
  <div class="accent-bar"></div>
  <div class="left-panel">
    <div class="left-glow"></div>
    ${leftPanel}
  </div>
  <div class="right-panel">
    <div class="party-badge">${theme.flag} ${theme.party}</div>
    <div class="title">${title.slice(0,85)}${title.length>85?'…':''}</div>
    <div class="odds-label">Polymarket Odds</div>
    <div class="odds-bar"><div class="odds-fill" style="width:${yesOdds}%"></div></div>
    <div class="odds-nums"><span class="yes">YES ${yesOdds}%</span><span class="no">NO ${noOdds}%</span></div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName}</div>
  </div>
  <div class="brand">WHALETRACK.APP</div>
</div>
</body></html>`;
}

// ── NBA MATCHUP CARD (two teams head-to-head, both star players) ─────
function buildNBAMatchupCard({ title, outcome, amount, price, whaleName, odds, team1, team2, player1Image, player2Image }) {
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;
  const c1 = team1?.colors?.team1 || '#1D428A';
  const c2 = team2?.colors?.team1 || '#C8102E';
  const p1name = team1?.player?.split(' ').pop() || '';
  const p2name = team2?.player?.split(' ').pop() || '';

  const p1Img = player1Image
    ? `<img src="${player1Image}" class="player-img p1-img"/>`
    : `<div class="player-placeholder">🏀</div>`;
  const p2Img = player2Image
    ? `<img src="${player2Image}" class="player-img p2-img"/>`
    : `<div class="player-placeholder">🏀</div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card {
    width:800px; height:418px; position:relative; overflow:hidden;
    background: #07090f;
    display:flex; flex-direction:column; align-items:center; justify-content:flex-end;
    padding-bottom:26px;
  }
  .players-row { position:absolute; top:0; left:0; right:0; bottom:0; display:flex; align-items:flex-end; }
  .player-side { flex:1; height:100%; display:flex; align-items:flex-end; justify-content:center; overflow:hidden; position:relative; }
  .player-side.left  { background:linear-gradient(90deg,  ${c1}33 0%, transparent 100%); }
  .player-side.right { background:linear-gradient(270deg, ${c2}33 0%, transparent 100%); }
  .player-img { height:92%; width:auto; object-fit:cover; object-position:top center; filter:drop-shadow(0 0 28px ${c1}66); }
  .p1-img { transform:scaleX(-1); }
  .p2-img { filter:drop-shadow(0 0 28px ${c2}66); }
  .player-placeholder { font-size:110px; opacity:0.12; padding-bottom:20px; }
  .shadow-left  { position:absolute; right:0;  top:0; bottom:0; width:55%; background:linear-gradient(90deg, transparent, #07090f 90%); }
  .shadow-right { position:absolute; left:0; top:0; bottom:0; width:55%; background:linear-gradient(270deg, transparent, #07090f 90%); }
  .shadow-top { position:absolute; left:0; right:0; bottom:0; height:45%; background:linear-gradient(transparent, #07090f 80%); }
  /* name tags */
  .name-left  { position:absolute; bottom:118px; left:12px;  font-size:12px; font-weight:900; color:${c1}; text-transform:uppercase; letter-spacing:1px; }
  .name-right { position:absolute; bottom:118px; right:12px; font-size:12px; font-weight:900; color:${c2}; text-transform:uppercase; letter-spacing:1px; }
  /* VS */
  .vs-wrap { position:absolute; left:50%; top:42%; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; z-index:10; }
  .nba-badge { font-size:11px; font-weight:900; color:#F7A900; text-transform:uppercase; letter-spacing:3px; margin-bottom:6px; }
  .vs-text { font-size:68px; font-weight:900; color:#fff; line-height:1; text-shadow:0 0 40px rgba(247,169,0,0.7), 0 0 80px rgba(247,169,0,0.3), 0 4px 20px rgba(0,0,0,0.9); letter-spacing:-2px; }
  /* bottom */
  .bottom-info { position:relative; z-index:20; text-align:center; width:100%; }
  .gold-line { width:180px; height:1px; background:linear-gradient(90deg,transparent,#F7A900,transparent); margin:0 auto 11px; }
  .title { font-size:17px; font-weight:800; color:#e8e8e8; line-height:1.3; margin-bottom:11px; padding:0 20px; text-shadow:0 2px 8px rgba(0,0,0,0.9); }
  .odds-row { display:flex; align-items:center; gap:14px; justify-content:center; margin-bottom:11px; }
  .odds-pill { padding:7px 20px; border-radius:30px; font-size:14px; font-weight:900; }
  .odds-yes { background:rgba(74,222,128,0.2); color:#4ade80; border:1px solid rgba(74,222,128,0.45); }
  .odds-no  { background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.4); border:1px solid rgba(255,255,255,0.12); }
  .trade-row { display:flex; align-items:center; gap:12px; justify-content:center; }
  .amount { font-size:30px; font-weight:900; color:#fff; letter-spacing:-0.5px; }
  .outcome-badge { padding:5px 16px; border-radius:20px; font-size:13px; font-weight:800; background:${outcome==='Yes'?'rgba(63,185,80,0.3)':'rgba(248,81,73,0.3)'}; color:${outcome==='Yes'?'#4ade80':'#f87171'}; border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.5)':'rgba(248,113,113,0.5)'}; }
  .whale { font-size:12px; color:rgba(255,255,255,0.35); margin-top:8px; }
  .brand { position:absolute; bottom:10px; right:18px; font-size:11px; color:rgba(255,255,255,0.25); font-weight:800; letter-spacing:1.5px; }
</style></head><body>
<div class="card">
  <div class="players-row">
    <div class="player-side left">${p1Img}<div class="shadow-left"></div><div class="shadow-top"></div></div>
    <div class="player-side right">${p2Img}<div class="shadow-right"></div><div class="shadow-top"></div></div>
  </div>
  <div class="name-left">${p1name}</div>
  <div class="name-right">${p2name}</div>
  <div class="vs-wrap">
    <div class="nba-badge">🏀 NBA · Polymarket</div>
    <div class="vs-text">VS</div>
  </div>
  <div class="bottom-info">
    <div class="gold-line"></div>
    <div class="title">${title.slice(0,85)}${title.length>85?'…':''}</div>
    <div class="odds-row">
      <div class="odds-pill odds-yes">YES ${yesOdds}%</div>
      <div class="odds-pill odds-no">NO ${noOdds}%</div>
    </div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName}</div>
  </div>
  <div class="brand">WHALETRACK.APP</div>
</div>
</body></html>`;
}

// ── NBA SINGLE TEAM CARD (one star player, politics-style layout) ────
function buildNBASingleCard({ title, outcome, amount, price, whaleName, odds, team, playerImage }) {
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;
  const c1 = team?.colors?.team1 || '#1D428A';
  const c2 = team?.colors?.team2 || '#FFC72C';
  const playerName = team?.player || 'Star Player';

  const leftPanel = playerImage
    ? `<div class="player-wrap"><img src="${playerImage}" class="player-img"/><div class="player-shadow"></div></div>`
    : `<div class="player-wrap"><div class="player-placeholder">🏀</div></div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card {
    width:800px; height:418px; position:relative; overflow:hidden;
    background:linear-gradient(140deg, ${c1} 0%, #050a14 100%);
    display:flex; align-items:stretch;
  }
  .stripe-overlay { position:absolute; inset:0; opacity:0.05; background:repeating-linear-gradient(48deg,#fff 0px,#fff 1px,transparent 1px,transparent 22px); }
  .accent-bar { position:absolute; left:0; top:0; bottom:0; width:5px; background:linear-gradient(180deg,${c2},transparent); }
  /* Left — player */
  .left-panel { width:285px; position:relative; display:flex; align-items:flex-end; justify-content:center; overflow:hidden; }
  .left-glow { position:absolute; inset:0; background:radial-gradient(ellipse at 50% 90%, ${c2}33 0%, transparent 65%); }
  .player-wrap { position:relative; z-index:2; width:240px; height:370px; }
  .player-img { width:100%; height:100%; object-fit:cover; object-position:top center; filter:drop-shadow(0 0 28px ${c2}55); }
  .player-shadow { position:absolute; bottom:0; left:0; right:0; height:130px; background:linear-gradient(transparent,#050a14cc); }
  .player-placeholder { width:160px; height:160px; border-radius:50%; background:${c2}22; border:2px solid ${c2}44; display:flex; align-items:center; justify-content:center; font-size:60px; margin-bottom:80px; }
  /* Right — info */
  .right-panel { flex:1; display:flex; flex-direction:column; justify-content:center; padding:30px 34px 30px 18px; position:relative; z-index:2; }
  .team-badge { display:inline-flex; align-items:center; gap:7px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.22); border-radius:20px; padding:5px 14px; font-size:11px; font-weight:800; color:#fff; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:8px; width:fit-content; }
  .player-tag { font-size:13px; color:${c2}; font-weight:800; margin-bottom:14px; text-transform:uppercase; letter-spacing:1px; }
  .title { font-size:23px; font-weight:800; color:#fff; line-height:1.35; margin-bottom:20px; text-shadow:0 2px 12px rgba(0,0,0,0.7); }
  .odds-label { font-size:10px; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:1.5px; margin-bottom:7px; }
  .odds-bar { height:7px; border-radius:4px; background:rgba(255,255,255,0.1); overflow:hidden; margin-bottom:7px; }
  .odds-fill { height:100%; border-radius:4px; background:linear-gradient(90deg,${c2},rgba(255,255,255,0.8)); }
  .odds-nums { display:flex; justify-content:space-between; font-size:13px; font-weight:800; margin-bottom:18px; }
  .yes { color:#fff; } .no { color:rgba(255,255,255,0.3); }
  .trade-row { display:flex; align-items:center; gap:12px; }
  .amount { font-size:32px; font-weight:900; color:#fff; letter-spacing:-0.5px; }
  .outcome-badge { padding:5px 16px; border-radius:20px; font-size:14px; font-weight:800; background:${outcome==='Yes'?'rgba(63,185,80,0.3)':'rgba(248,81,73,0.3)'}; color:${outcome==='Yes'?'#4ade80':'#f87171'}; border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.5)':'rgba(248,113,113,0.5)'}; }
  .whale { font-size:13px; color:rgba(255,255,255,0.4); margin-top:9px; }
  .brand { position:absolute; bottom:16px; right:22px; font-size:12px; color:rgba(255,255,255,0.3); font-weight:800; letter-spacing:1px; }
</style></head><body>
<div class="card">
  <div class="stripe-overlay"></div>
  <div class="accent-bar"></div>
  <div class="left-panel">
    <div class="left-glow"></div>
    ${leftPanel}
  </div>
  <div class="right-panel">
    <div class="team-badge">🏀 NBA · Polymarket</div>
    <div class="player-tag">⭐ ${playerName}</div>
    <div class="title">${title.slice(0,85)}${title.length>85?'…':''}</div>
    <div class="odds-label">Polymarket Odds</div>
    <div class="odds-bar"><div class="odds-fill" style="width:${yesOdds}%"></div></div>
    <div class="odds-nums"><span class="yes">YES ${yesOdds}%</span><span class="no">NO ${noOdds}%</span></div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName}</div>
  </div>
  <div class="brand">WHALETRACK.APP</div>
</div>
</body></html>`;
}

function buildUFCCard({ title, outcome, amount, price, whaleName, odds, fighter1Image, fighter2Image, fighter1Name, fighter2Name }) {
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;

  const f1Img = fighter1Image
    ? `<img src="${fighter1Image}" class="fighter-img f1-img"/>`
    : `<div class="fighter-placeholder">🥊</div>`;
  const f2Img = fighter2Image
    ? `<img src="${fighter2Image}" class="fighter-img f2-img"/>`
    : `<div class="fighter-placeholder">🥊</div>`;

  const f1Label = fighter1Name || 'Fighter 1';
  const f2Label = fighter2Name || 'Fighter 2';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card {
    width:800px; height:418px; position:relative; overflow:hidden;
    background: linear-gradient(180deg, #0a0a0a 0%, #1a0505 50%, #0a0a0a 100%);
    display:flex; flex-direction:column; align-items:center; justify-content:flex-end;
    padding-bottom:28px;
  }
  /* Background fighters */
  .fighters-row {
    position:absolute; top:0; left:0; right:0; bottom:0;
    display:flex; align-items:flex-end;
  }
  .fighter-side {
    flex:1; height:100%; display:flex; align-items:flex-end; justify-content:center;
    overflow:hidden; position:relative;
  }
  .fighter-side.left { background:linear-gradient(90deg, rgba(220,38,38,0.18) 0%, transparent 100%); }
  .fighter-side.right { background:linear-gradient(270deg, rgba(220,38,38,0.18) 0%, transparent 100%); }
  .fighter-img {
    height:95%; width:auto; object-fit:cover; object-position:top center;
    filter:drop-shadow(0 0 30px rgba(220,38,38,0.5));
  }
  .f1-img { transform:scaleX(-1); } /* flip left fighter to face center */
  .fighter-placeholder { font-size:120px; opacity:0.15; padding-bottom:20px; }
  .fighter-shadow-left  { position:absolute; right:0; top:0; bottom:0; width:60%; background:linear-gradient(90deg, transparent, #0a0a0a 90%); }
  .fighter-shadow-right { position:absolute; left:0;  top:0; bottom:0; width:60%; background:linear-gradient(270deg, transparent, #0a0a0a 90%); }
  /* Fighter name tags */
  .name-left  { position:absolute; bottom:112px; left:14px;  font-size:13px; font-weight:900; color:rgba(255,255,255,0.7); text-transform:uppercase; letter-spacing:1px; }
  .name-right { position:absolute; bottom:112px; right:14px; font-size:13px; font-weight:900; color:rgba(255,255,255,0.7); text-transform:uppercase; letter-spacing:1px; }
  /* VS center */
  .vs-wrap {
    position:absolute; left:50%; top:50%; transform:translate(-50%,-60%);
    display:flex; flex-direction:column; align-items:center; z-index:10;
  }
  .ufc-badge { font-size:11px; font-weight:900; color:#D4AF37; text-transform:uppercase; letter-spacing:3px; margin-bottom:6px; }
  .vs-text {
    font-size:72px; font-weight:900; color:#fff; line-height:1;
    text-shadow: 0 0 40px rgba(220,38,38,0.9), 0 0 80px rgba(220,38,38,0.5), 0 4px 20px rgba(0,0,0,0.8);
    letter-spacing:-2px;
  }
  /* Bottom info */
  .bottom-info { position:relative; z-index:20; text-align:center; width:100%; }
  .title { font-size:17px; font-weight:800; color:#e0e0e0; line-height:1.3; margin-bottom:12px; padding:0 20px; text-shadow:0 2px 8px rgba(0,0,0,0.9); }
  .odds-row { display:flex; align-items:center; gap:14px; justify-content:center; margin-bottom:12px; }
  .odds-pill { padding:7px 20px; border-radius:30px; font-size:14px; font-weight:900; }
  .odds-yes { background:rgba(74,222,128,0.2); color:#4ade80; border:1px solid rgba(74,222,128,0.45); }
  .odds-no  { background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.4); border:1px solid rgba(255,255,255,0.12); }
  .trade-row { display:flex; align-items:center; gap:12px; justify-content:center; }
  .amount { font-size:30px; font-weight:900; color:#fff; letter-spacing:-0.5px; }
  .outcome-badge { padding:5px 16px; border-radius:20px; font-size:13px; font-weight:800; background:${outcome==='Yes'?'rgba(63,185,80,0.3)':'rgba(248,81,73,0.3)'}; color:${outcome==='Yes'?'#4ade80':'#f87171'}; border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.5)':'rgba(248,113,113,0.5)'}; }
  .whale { font-size:12px; color:rgba(255,255,255,0.35); margin-top:8px; }
  .brand { position:absolute; bottom:10px; right:18px; font-size:11px; color:rgba(255,255,255,0.25); font-weight:800; letter-spacing:1.5px; }
  /* Gold divider line */
  .gold-line { width:200px; height:1px; background:linear-gradient(90deg, transparent, #D4AF37, transparent); margin:0 auto 12px; }
</style></head><body>
<div class="card">
  <!-- Fighters left & right -->
  <div class="fighters-row">
    <div class="fighter-side left">
      ${f1Img}
      <div class="fighter-shadow-left"></div>
    </div>
    <div class="fighter-side right">
      ${f2Img}
      <div class="fighter-shadow-right"></div>
    </div>
  </div>

  <!-- Fighter name tags -->
  <div class="name-left">${f1Label.split(' ').pop()}</div>
  <div class="name-right">${f2Label.split(' ').pop()}</div>

  <!-- VS center -->
  <div class="vs-wrap">
    <div class="ufc-badge">🥊 UFC · Polymarket</div>
    <div class="vs-text">VS</div>
  </div>

  <!-- Bottom content -->
  <div class="bottom-info">
    <div class="gold-line"></div>
    <div class="title">${title.slice(0,85)}${title.length>85?'…':''}</div>
    <div class="odds-row">
      <div class="odds-pill odds-yes">YES ${yesOdds}%</div>
      <div class="odds-pill odds-no">NO ${noOdds}%</div>
    </div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName}</div>
  </div>
  <div class="brand">WHALETRACK.APP</div>
</div>
</body></html>`;
}

function buildSportsCard({ title, outcome, amount, price, whaleName, odds }) {
  const theme   = getSportsTheme(title);
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;
  // Ensure team colors are visible on dark bg
  const t1 = theme.team1 === '#FFFFFF' ? '#e0e0e0' : theme.team1;
  const t2 = theme.team2 === '#FFFFFF' ? '#e0e0e0' : theme.team2;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card { width:800px; height:418px; position:relative; overflow:hidden; background:#07090f; display:flex; align-items:center; justify-content:center; }
  .split-left {
    position:absolute; left:0; top:0; width:52%; height:100%;
    background:linear-gradient(135deg, ${t1}dd 0%, ${t1}55 100%);
    clip-path: polygon(0 0, 82% 0, 100% 100%, 0 100%);
  }
  .split-right {
    position:absolute; right:0; top:0; width:52%; height:100%;
    background:linear-gradient(225deg, ${t2}dd 0%, ${t2}55 100%);
    clip-path: polygon(18% 0, 100% 0, 100% 100%, 0 100%);
  }
  .dark-overlay { position:absolute; inset:0; background:rgba(7,9,15,0.55); }
  .center-glow {
    position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    width:320px; height:320px; border-radius:50%;
    background:radial-gradient(circle, rgba(255,255,255,0.07) 0%, transparent 70%);
  }
  .content { position:relative; z-index:5; text-align:center; padding:0 48px; }
  .sport-badge { display:inline-block; background:rgba(255,255,255,0.12); backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,0.25); border-radius:20px; padding:5px 18px; font-size:12px; font-weight:800; color:#fff; text-transform:uppercase; letter-spacing:2px; margin-bottom:14px; }
  .vs-emoji { font-size:52px; display:block; margin-bottom:10px; filter:drop-shadow(0 4px 16px rgba(0,0,0,0.7)); }
  .title { font-size:23px; font-weight:800; color:#fff; line-height:1.35; margin:0 auto 22px; text-shadow:0 2px 16px rgba(0,0,0,0.9); max-width:520px; }
  .odds-row { display:flex; align-items:center; gap:16px; justify-content:center; margin-bottom:18px; }
  .odds-pill { padding:9px 24px; border-radius:30px; font-size:15px; font-weight:900; }
  .odds-yes { background:rgba(74,222,128,0.2); color:#4ade80; border:1px solid rgba(74,222,128,0.45); }
  .odds-no  { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.45); border:1px solid rgba(255,255,255,0.15); }
  .trade-row { display:flex; align-items:center; gap:14px; justify-content:center; }
  .amount { font-size:32px; font-weight:900; color:#fff; text-shadow:0 2px 12px rgba(0,0,0,0.7); letter-spacing:-0.5px; }
  .outcome-badge { padding:5px 16px; border-radius:20px; font-size:14px; font-weight:800; background:${outcome==='Yes'?'rgba(63,185,80,0.3)':'rgba(248,81,73,0.3)'}; color:${outcome==='Yes'?'#4ade80':'#f87171'}; border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.5)':'rgba(248,113,113,0.5)'}; }
  .whale { font-size:13px; color:rgba(255,255,255,0.45); margin-top:12px; }
  .brand { position:absolute; bottom:16px; right:22px; font-size:12px; color:rgba(255,255,255,0.35); font-weight:800; letter-spacing:1px; }
</style></head><body>
<div class="card">
  <div class="split-left"></div>
  <div class="split-right"></div>
  <div class="dark-overlay"></div>
  <div class="center-glow"></div>
  <div class="content">
    <div class="sport-badge">${theme.emoji} ${theme.sport} · Polymarket</div>
    <div class="vs-emoji">${theme.emoji}</div>
    <div class="title">${title.slice(0,90)}${title.length>90?'…':''}</div>
    <div class="odds-row">
      <div class="odds-pill odds-yes">YES ${yesOdds}%</div>
      <div class="odds-pill odds-no">NO ${noOdds}%</div>
    </div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName}</div>
  </div>
  <div class="brand">WHALETRACK.APP</div>
</div>
</body></html>`;
}

function buildWhaleCard({ title, outcome, amount, price, whaleName, odds }) {
  const yesOdds = Math.round(parseFloat(odds || price || 0.5) * 100);
  const noOdds  = 100 - yesOdds;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:800px; height:418px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .card {
    width:800px; height:418px; position:relative;
    background: radial-gradient(ellipse at 18% 50%, rgba(88,166,255,0.14) 0%, transparent 52%),
                linear-gradient(135deg, #080e1a 0%, #111827 100%);
    display:flex; align-items:center; padding:44px;
  }
  .whale-bg { position:absolute; right:10px; top:50%; transform:translateY(-50%); font-size:280px; opacity:0.06; line-height:1; filter:blur(1px); }
  .accent-line { position:absolute; left:0; top:0; bottom:0; width:5px; background:linear-gradient(180deg, #58a6ff 0%, #3fb950 100%); border-radius:0 3px 3px 0; }
  .top-dot { position:absolute; left:0; top:50%; transform:translateY(-50%); width:5px; height:60px; background:#58a6ff; border-radius:0 4px 4px 0; filter:blur(2px); opacity:0.6; }
  .content { position:relative; z-index:2; }
  .badge { display:inline-flex; align-items:center; gap:7px; background:rgba(88,166,255,0.13); border:1px solid rgba(88,166,255,0.35); border-radius:20px; padding:5px 16px; font-size:11px; font-weight:800; color:#58a6ff; text-transform:uppercase; letter-spacing:2px; margin-bottom:18px; }
  .title { font-size:27px; font-weight:800; color:#eaf1ff; line-height:1.3; margin-bottom:26px; max-width:580px; }
  .odds-label { font-size:10px; color:#4a5f80; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:9px; }
  .odds-bar { width:480px; height:9px; border-radius:5px; background:#161f2e; overflow:hidden; margin-bottom:9px; }
  .odds-fill { height:100%; border-radius:5px; background:linear-gradient(90deg, #58a6ff, #3fb950); }
  .odds-nums { display:flex; justify-content:space-between; width:480px; font-size:14px; font-weight:800; margin-bottom:22px; }
  .yes { color:#58a6ff; } .no { color:#4a5f80; }
  .trade-row { display:flex; align-items:center; gap:14px; }
  .amount { font-size:36px; font-weight:900; color:#eaf1ff; letter-spacing:-1px; }
  .outcome-badge { padding:6px 18px; border-radius:20px; font-size:14px; font-weight:800; background:${outcome==='Yes'?'rgba(63,185,80,0.2)':'rgba(248,81,73,0.2)'}; color:${outcome==='Yes'?'#4ade80':'#f87171'}; border:1px solid ${outcome==='Yes'?'rgba(74,222,128,0.45)':'rgba(248,113,113,0.45)'}; }
  .whale { font-size:13px; color:#4a5f80; margin-top:11px; }
  .brand { position:absolute; bottom:18px; right:26px; font-size:12px; color:#2d3f5a; font-weight:800; letter-spacing:1.5px; }
  .watermark { position:absolute; top:18px; right:26px; font-size:11px; color:#2d3f5a; font-weight:800; letter-spacing:2px; }
</style></head><body>
<div class="card">
  <div class="accent-line"></div>
  <div class="top-dot"></div>
  <div class="whale-bg">🐋</div>
  <div class="content">
    <div class="badge">🐋 Whale Alert</div>
    <div class="title">${title.slice(0,100)}${title.length>100?'…':''}</div>
    <div class="odds-label">Polymarket Odds</div>
    <div class="odds-bar"><div class="odds-fill" style="width:${yesOdds}%"></div></div>
    <div class="odds-nums"><span class="yes">YES ${yesOdds}¢</span><span class="no">NO ${noOdds}¢</span></div>
    <div class="trade-row">
      <div class="amount">${amount}</div>
      <div class="outcome-badge">${outcome}</div>
    </div>
    <div class="whale">🐋 ${whaleName} · whaletrack.app</div>
  </div>
  <div class="watermark">WHALETRACK.APP</div>
  <div class="brand">whaletrack.app</div>
</div>
</body></html>`;
}

// ── MAIN GENERATE FUNCTION ───────────────────────────────────────────
async function generateCard(options) {
  const { title, outcome, amount, price, whaleName, odds } = options;
  const category = detectCategory(title);

  let html;

  if (category === 'POLITICS') {
    const personName = extractPersonName(title);
    let personImage  = null;
    if (personName) personImage = await fetchWikiImage(personName, POLITICIAN_WIKI);
    html = buildPoliticsCard({ title, outcome, amount, price, whaleName, odds, personImage });
  } else if (category === 'CRYPTO') {
    html = buildCryptoCard({ title, outcome, amount, price, whaleName, odds });
  } else if (category === 'SPORTS') {
    if (isUFCMarket(title)) {
      // UFC fight poster — both fighters facing each other
      const [f1Name, f2Name] = extractFighters(title);
      const [fighter1Image, fighter2Image] = await Promise.all([
        fetchFighterImage(f1Name),
        fetchFighterImage(f2Name),
      ]);
      html = buildUFCCard({ title, outcome, amount, price, whaleName, odds, fighter1Image, fighter2Image, fighter1Name: f1Name, fighter2Name: f2Name });
    } else if (isNBAMarket(title)) {
      const teams = extractNBATeams(title);
      if (teams.length >= 2) {
        // Head-to-head matchup — both star players
        const [playerImg1, playerImg2] = await Promise.all([
          fetchWikiImage(teams[0].player, NBA_PLAYERS),
          fetchWikiImage(teams[1].player, NBA_PLAYERS),
        ]);
        html = buildNBAMatchupCard({ title, outcome, amount, price, whaleName, odds, team1: teams[0], team2: teams[1], player1Image: playerImg1, player2Image: playerImg2 });
      } else {
        // Single team or player mentioned
        const team = teams[0] || null;
        const playerWiki = extractNBAPlayer(title) || team?.player || null;
        const playerImage = playerWiki ? await fetchWikiImage(playerWiki, NBA_PLAYERS) : null;
        html = buildNBASingleCard({ title, outcome, amount, price, whaleName, odds, team, playerImage });
      }
    } else {
      html = buildSportsCard({ title, outcome, amount, price, whaleName, odds });
    }
  } else {
    html = buildWhaleCard({ title, outcome, amount, price, whaleName, odds });
  }

  // Screenshot with Puppeteer
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 60000,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 418, deviceScaleFactor: 2 });
    // 'load' is enough since images are embedded as base64 — no external requests
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    await new Promise(r => setTimeout(r, 300));
    const imgPath = path.join(os.tmpdir(), `wt_card_${Date.now()}.png`);
    await page.screenshot({ path: imgPath, type: 'png' });
    return { imgPath, category };
  } finally {
    await browser.close();
  }
}

module.exports = { generateCard, detectCategory };

// ── CLI TEST MODE ────────────────────────────────────────────────────
if (require.main === module) {
  const tests = [
    { file: 'demo_crypto.png',   title: 'Will Bitcoin hit $200,000 before end of 2026?',          outcome: 'Yes', amount: '$47K', price: 0.62, whaleName: 'somalianKing'      },
    { file: 'demo_politics.png', title: 'Will Trump win the 2028 presidential election?',          outcome: 'Yes', amount: '$31K', price: 0.54, whaleName: 'DEEDDIT'           },
    { file: 'demo_nba_single.png',  title: 'Will the Lakers win the NBA Championship 2026?',        outcome: 'No',  amount: '$18K', price: 0.31, whaleName: 'CandleHammerDrums' },
    { file: 'demo_nba_matchup.png', title: 'Will the Celtics beat the Warriors in the NBA Finals?', outcome: 'Yes', amount: '$41K', price: 0.64, whaleName: 'somalianKing'      },
    { file: 'demo_ufc.png',      title: 'Jon Jones vs Stipe Miocic — who wins at UFC 309?',       outcome: 'Yes', amount: '$28K', price: 0.71, whaleName: 'somalianKing'      },
    { file: 'demo_ufc2.png',     title: 'Will Islam Makhachev beat Dustin Poirier at UFC 302?',   outcome: 'Yes', amount: '$35K', price: 0.78, whaleName: 'DEEDDIT'           },
    { file: 'demo_whale.png',    title: 'Will the US enter a recession before July 2027?',         outcome: 'Yes', amount: '$22K', price: 0.43, whaleName: 'bettguy'            },
  ];

  (async () => {
    for (const t of tests) {
      console.log(`\nGenerating [${t.file}]: ${t.title}`);
      const { imgPath, category } = await generateCard(t);
      fs.copyFileSync(imgPath, t.file);
      fs.unlinkSync(imgPath);
      console.log(`✅ ${category} → ${t.file}`);
    }
    console.log('\n✅ All done! Open the PNG files to preview.');
  })();
}
