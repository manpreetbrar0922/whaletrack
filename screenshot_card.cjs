const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 600, height: 600, deviceScaleFactor: 2 });
  await page.goto('http://localhost:8766/card2.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500)); // wait for bg image

  await page.screenshot({
    path: '/Users/manpreetbrar/whaletrack/whale_card.png',
    type: 'png',
    clip: { x: 0, y: 0, width: 600, height: 600 }
  });

  console.log('Saved whale_card.png');
  await browser.close();
})();
