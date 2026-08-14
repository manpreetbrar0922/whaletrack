const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PAGES = [
  { url: 'https://whaletrack.app', name: 'home', waitFor: 3000 },
  { url: 'https://whaletrack.app/#whales', name: 'whales', waitFor: 3000 },
  { url: 'https://whaletrack.app/whale/somalianking', name: 'somalianking', waitFor: 3000 },
  { url: 'https://whaletrack.app/whale/deeddit', name: 'deeddit', waitFor: 3000 },
  { url: 'https://whaletrack.app/polymarket-leaderboard', name: 'leaderboard', waitFor: 3000 },
  { url: 'https://whaletrack.app/premium', name: 'premium', waitFor: 2000 },
];

async function screenshot() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const outDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  for (const p of PAGES) {
    console.log(`📸 Screenshotting ${p.url}...`);
    try {
      await page.goto(p.url, { waitUntil: 'networkidle2', timeout: 15000 });
      await new Promise(r => setTimeout(r, p.waitFor));
      await page.screenshot({ 
        path: path.join(outDir, `${p.name}.png`),
        fullPage: false
      });
      console.log(`  ✓ ${p.name}.png`);
    } catch(e) {
      console.log(`  ✗ ${p.name} failed: ${e.message}`);
    }
  }

  await browser.close();
  console.log('\n✅ Screenshots done!');
}

screenshot().catch(console.error);
