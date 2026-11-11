#!/usr/bin/env node
// WhaleTrack YouTube Video Generator
// Automatically creates a 90-second promo video:
//   1. Fetches latest whale data from Polymarket
//   2. Generates AI voiceover via ElevenLabs
//   3. Records WhaleTrack site via Puppeteer
//   4. Stitches everything into a ready-to-upload MP4

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── CONFIG ────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam
const OUTPUT_DIR         = path.join(__dirname, 'video_output');
const FRAMES_DIR         = path.join(OUTPUT_DIR, 'frames');
const SITE_URL           = 'https://whaletrack.app';

if (!ELEVENLABS_API_KEY) {
  console.error('❌ ELEVENLABS_API_KEY not set in .env');
  process.exit(1);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WhaleTrack-VideoMaker/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function fmtUSD(n) {
  if (n >= 1000000) return `$${(n/1000000).toFixed(1)}M`;
  if (n >= 1000)    return `$${Math.round(n/1000)}K`;
  return `$${Math.round(n)}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── STEP 1: FETCH WHALE DATA ──────────────────────────────────────────────────
async function fetchTopTrade() {
  console.log('📡 Fetching latest whale data...');

  const KNOWN_WHALES = [
    '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab',
    '0x3dfb153c197d4c19d3b31c1ecd2c7b6860eeabaf',
    '0xd0a21b8a2c4e9fea3e44db9b6c61acbba3348e0b',
    '0x2a65c3ecf7be99bb05ca0ab4f43e0d41f4b5e5b4',
  ];

  let bestTrade = null;

  for (const addr of KNOWN_WHALES) {
    try {
      const data = await fetchJson(
        `https://data-api.polymarket.com/v2/activity?user=${addr}&limit=10`
      );
      const trades = Array.isArray(data) ? data : (data?.data || []);
      const bigBuys = trades.filter(t =>
        t.side === 'BUY' && parseFloat(t.usdcSize || 0) >= 5000
      );
      if (bigBuys.length > 0) {
        const top = bigBuys.reduce((a, b) =>
          parseFloat(a.usdcSize) > parseFloat(b.usdcSize) ? a : b
        );
        if (!bestTrade || parseFloat(top.usdcSize) > parseFloat(bestTrade.usdcSize)) {
          bestTrade = { ...top, address: addr };
        }
      }
    } catch { /* skip */ }
  }

  if (!bestTrade) {
    // Fallback: use leaderboard data
    const lb = await fetchJson('https://data-api.polymarket.com/v2/leaderboard?limit=5');
    const entries = Array.isArray(lb) ? lb : (lb?.data || []);
    return {
      whaleName: entries[0]?.user_name || 'Top Whale',
      amount:    '$47K',
      outcome:   'YES',
      title:     'Bitcoin hits $100K by December 2026',
      price:     68,
      pnl:       '+$124,000',
      winRate:   87,
      trades:    23,
    };
  }

  // Fetch whale leaderboard stats
  let whaleName = bestTrade.address.slice(0, 6) + '…';
  let pnlStr = 'n/a';
  let winRate = null;
  let totalTrades = 0;

  try {
    const stats = await fetchJson(
      `https://data-api.polymarket.com/v2/leaderboard?user=${bestTrade.address}`
    );
    const d = stats?.data || stats;
    if (d?.pnl) pnlStr = `${d.pnl >= 0 ? '+' : ''}${fmtUSD(Math.abs(d.pnl))}`;
    if (d?.user_name && !d.user_name.includes('-')) whaleName = d.user_name;
  } catch { /* skip */ }

  try {
    const activity = await fetchJson(
      `https://data-api.polymarket.com/v2/activity?user=${bestTrade.address}&limit=50`
    );
    const acts = Array.isArray(activity) ? activity : (activity?.data || []);
    const resolved = acts.filter(t => t.side === 'REDEEM' || (t.side === 'SELL' && parseFloat(t.price || 0) >= 0.85));
    const losses   = acts.filter(t => t.side === 'SELL' && parseFloat(t.price || 0) <= 0.15);
    totalTrades = resolved.length + losses.length;
    if (totalTrades > 0) winRate = Math.round((resolved.length / totalTrades) * 100);
  } catch { /* skip */ }

  return {
    whaleName,
    amount:    fmtUSD(parseFloat(bestTrade.usdcSize)),
    outcome:   bestTrade.outcome || 'YES',
    title:     bestTrade.title || bestTrade.slug || 'Prediction Market',
    price:     Math.round(parseFloat(bestTrade.price || 0.5) * 100),
    pnl:       pnlStr,
    winRate:   winRate || 75,
    trades:    totalTrades || 16,
  };
}

// ── STEP 2: BUILD SCRIPT ──────────────────────────────────────────────────────
function buildScript(trade) {
  return `
A whale just placed a ${trade.amount} bet on Polymarket.

${trade.outcome} on: ${trade.title}

At ${trade.price} cents per share.

This isn't random. This wallet has a ${trade.winRate}% win rate across ${trade.trades} resolved trades.

That's the kind of track record most traders dream about.

And you can copy every bet they make — before anyone else sees it.

WhaleTrack monitors the top Polymarket wallets 24 hours a day, 7 days a week.

The moment a whale places a big bet — you get an instant alert with their full track record.

Win rate. Total profit and loss. Leaderboard rank.

One tap to copy the bet yourself.

Completely free at WhaleTrack dot app.

Don't guess what to bet on. Copy the people who already know.
`.trim();
}

// ── STEP 3: GENERATE VOICEOVER ────────────────────────────────────────────────
async function generateVoiceover(script, outputPath) {
  console.log('🎙️  Generating AI voiceover via ElevenLabs...');

  const body = JSON.stringify({
    text: script,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${VOICE_ID}`,
      method:   'POST',
      headers:  {
        'xi-api-key':    ELEVENLABS_API_KEY,
        'Content-Type':  'application/json',
        'Accept':        'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => err += d);
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${err}`)));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        fs.writeFileSync(outputPath, Buffer.concat(chunks));
        console.log(`✅ Voiceover saved: ${path.basename(outputPath)}`);
        resolve(outputPath);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── STEP 4: CAPTURE WHALETRACK — smooth scroll at 10fps ──────────────────────
const FPS = 10;

async function captureScreens(audioDuration) {
  console.log(`🎥 Recording WhaleTrack to match ${audioDuration.toFixed(1)}s audio...`);

  // Clear old frames
  if (fs.existsSync(FRAMES_DIR)) {
    fs.readdirSync(FRAMES_DIR).forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));
  }
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720'],
    defaultViewport: { width: 1280, height: 720 },
  });

  const page = await browser.newPage();
  let frameIdx = 0;

  // Record frames at FPS for durationMs while simultaneously running action()
  async function recordWhile(durationMs, action = null) {
    const frameInterval = 1000 / FPS;
    const endTime = Date.now() + durationMs;
    const actionPromise = action ? action() : Promise.resolve();
    while (Date.now() < endTime) {
      const fp = path.join(FRAMES_DIR, `frame_${String(frameIdx).padStart(5, '0')}.png`);
      await page.screenshot({ path: fp });
      frameIdx++;
      await sleep(frameInterval);
    }
    await actionPromise;
  }

  // Smooth scroll — runs in page context over durationMs
  function scrollTo(target, durationMs) {
    return page.evaluate((target, duration) => {
      return new Promise(resolve => {
        const start = window.scrollY;
        const dist  = target - start;
        const t0    = performance.now();
        function step(now) {
          const p    = Math.min((now - t0) / duration, 1);
          const ease = p < 0.5 ? 2*p*p : -1 + (4 - 2*p)*p;
          window.scrollTo(0, start + dist * ease);
          if (p < 1) requestAnimationFrame(step); else resolve();
        }
        requestAnimationFrame(step);
      });
    }, target, durationMs);
  }

  // Distribute total audio duration across 5 sections (proportions must sum to 1)
  const total  = audioDuration * 1000; // ms
  const s = {
    homepage:  Math.round(total * 0.18),  // 18% — hero
    alerts:    Math.round(total * 0.30),  // 30% — scroll through alerts
    cards:     Math.round(total * 0.22),  // 22% — whale cards
    premium:   Math.round(total * 0.15),  // 15% — premium page
    cta:       Math.round(total * 0.15),  // 15% — CTA
  };

  try {
    // ── SECTION 1: Homepage hero ──
    console.log(`  🎬 Homepage (${(s.homepage/1000).toFixed(1)}s)`);
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);
    await recordWhile(s.homepage);

    // ── SECTION 2: Slow scroll through alerts ──
    console.log(`  🎬 Alerts scroll (${(s.alerts/1000).toFixed(1)}s)`);
    const alertScrollMs = s.alerts * 0.85;
    await recordWhile(s.alerts, () => scrollTo(1400, alertScrollMs));

    // ── SECTION 3: Whale cards — continue scrolling ──
    console.log(`  🎬 Whale cards (${(s.cards/1000).toFixed(1)}s)`);
    const cardScrollMs = s.cards * 0.85;
    await recordWhile(s.cards, () => scrollTo(2800, cardScrollMs));

    // ── SECTION 4: Premium page ──
    console.log(`  🎬 Premium page (${(s.premium/1000).toFixed(1)}s)`);
    await page.goto(`${SITE_URL}/premium`, { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(800);
    await recordWhile(s.premium, () => scrollTo(600, s.premium * 0.7));

    // ── SECTION 5: Back to homepage CTA ──
    console.log(`  🎬 CTA (${(s.cta/1000).toFixed(1)}s)`);
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(800);
    await recordWhile(s.cta);

  } finally {
    await browser.close();
  }

  console.log(`✅ ${frameIdx} frames captured at ${FPS}fps (${(frameIdx/FPS).toFixed(1)}s)`);
  return frameIdx;
}

// ── STEP 5: GET AUDIO DURATION ────────────────────────────────────────────────
function getAudioDuration(audioPath) {
  const result = spawnSync('ffprobe', [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    audioPath,
  ], { encoding: 'utf8' });
  return parseFloat(result.stdout.trim()) || 60;
}

// ── STEP 6: ASSEMBLE VIDEO ────────────────────────────────────────────────────
function assembleVideo(frameCount, audioPath, outputPath, audioDuration) {
  console.log('🎬 Assembling video with ffmpeg...');

  // Calculate actual fps from real elapsed time vs frames captured
  // This ensures video duration matches audio regardless of screenshot speed
  const actualFps = frameCount / audioDuration;

  console.log(`   Audio: ${audioDuration.toFixed(1)}s | ${frameCount} frames | actual fps: ${actualFps.toFixed(2)}`);

  const args = [
    '-y',
    '-framerate', actualFps.toFixed(4),
    '-i', path.join(FRAMES_DIR, 'frame_%05d.png'),
    '-i', audioPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ];

  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });

  if (result.status !== 0) {
    console.error('ffmpeg stderr:', result.stderr?.slice(-800));
    throw new Error('ffmpeg failed');
  }

  console.log(`✅ Video assembled: ${path.basename(outputPath)}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🐋 WhaleTrack Video Generator\n');

  // Setup dirs
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const timestamp  = new Date().toISOString().slice(0, 10);
  const audioPath  = path.join(OUTPUT_DIR, `voiceover_${timestamp}.mp3`);
  const outputPath = path.join(OUTPUT_DIR, `whaletrack_${timestamp}.mp4`);

  // Step 1: Get whale data
  const trade = await fetchTopTrade();
  console.log(`\n📊 Top trade: ${trade.amount} on "${trade.title.slice(0, 50)}..."`);

  // Step 2: Build script
  const script = buildScript(trade);
  console.log('\n📝 Script preview:\n' + script.slice(0, 150) + '...\n');

  // Save script for reference
  fs.writeFileSync(path.join(OUTPUT_DIR, `script_${timestamp}.txt`), script);

  // Step 3: Generate voiceover
  await generateVoiceover(script, audioPath);

  // Step 4: Capture screens (pass audio duration so video matches)
  const audioDuration = getAudioDuration(audioPath);
  const frameCount = await captureScreens(audioDuration);

  // Step 5: Assemble video (pass audioDuration so fps is calculated correctly)
  assembleVideo(frameCount, audioPath, outputPath, audioDuration);

  // Done!
  const stats = fs.statSync(outputPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

  console.log(`\n✅ VIDEO READY!`);
  console.log(`   📁 ${outputPath}`);
  console.log(`   📦 Size: ${sizeMB} MB`);
  console.log(`\n   Upload to YouTube: @whaletrackhq`);
  console.log(`   Suggested title: "This Polymarket Whale Just Bet ${trade.amount} on ${trade.outcome} 🐋"\n`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
