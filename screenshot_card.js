const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 700, height: 520, deviceScaleFactor: 2 });
  await page.goto('http://localhost:8766/card.html', { waitUntil: 'networkidle0' });

  // Wait for animation
  await new Promise(r => setTimeout(r, 500));

  const card = await page.$('.card');
  await card.screenshot({
    path: '/Users/manpreetbrar/whaletrack/whale_card.png',
    type: 'png'
  });

  console.log('✅ Saved whale_card.png');
  await browser.close();
})();
