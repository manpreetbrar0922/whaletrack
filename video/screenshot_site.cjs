const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PAGES = [
  { url: 'https://whaletrack.app', name: 'home', waitFor: 4000 },
  { url: 'https://whaletrack.app/polymarket-leaderboard', name: 'leaderboard', waitFor: 3000 },
  { url: 'https://whaletrack.app/whale/somalianking', name: 'somalianking', waitFor: 3000 },
  { url: 'https://whaletrack.app/whale/deeddit', name: 'deeddit', waitFor: 3000 },
  { url: 'https://whaletrack.app/polymarket-whale-tracker', name: 'whale_tracker', waitFor: 3000 },
  { url: 'https://whaletrack.app/premium', name: 'premium', waitFor: 2000 },
];

async function screenshot() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const outDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const p of PAGES) {
    console.log(`📸 ${p.name}...`);
    try {
      await page.goto(p.url, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, p.waitFor));
      await page.screenshot({ 
        path: path.join(outDir, `${p.name}.png`),
        fullPage: false
      });
      console.log(`  ✓ saved`);
    } catch(e) {
      console.log(`  ✗ failed: ${e.message}`);
    }
  }

  await browser.close();
  console.log('\n✅ Screenshots done!');
}

screenshot().catch(console.error);
