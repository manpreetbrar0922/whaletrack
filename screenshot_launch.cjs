#!/usr/bin/env node
// Screenshot the launch announcement card

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const HTML_FILE = path.join(__dirname, 'launch-card.html');
const OUT_FILE  = path.join(__dirname, 'launch-card.png');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 675, deviceScaleFactor: 2 });
  await page.goto(`file://${HTML_FILE}`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));

  await page.screenshot({ path: OUT_FILE, type: 'png' });
  await browser.close();

  console.log('✅ Saved to', OUT_FILE);
})();
