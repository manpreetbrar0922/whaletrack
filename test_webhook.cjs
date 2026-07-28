#!/usr/bin/env node
// Test webhook delivery — run this once MoonSat sends his endpoint URL
// Usage: node test_webhook.cjs <URL>
//   or:  node test_webhook.cjs  (uses URL from webhook_customers.json)

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const CUSTOMERS_FILE = path.join(__dirname, 'webhook_customers.json');

function postTest(url, customerName) {
  const payload = {
    event:     'whale_bet',
    whale:     'somalianKing',
    market:    'Will Bitcoin hit $200,000 in 2026?',
    outcome:   'Yes',
    size_usd:  47000,
    price:     0.62,
    price_pct: 62,
    timestamp: Math.floor(Date.now() / 1000),
    slug:      'will-bitcoin-hit-200000-in-2026',
    source:    'whaletrack.app',
    _test:     true,
  };

  return new Promise((resolve) => {
    try {
      const body   = JSON.stringify(payload);
      const urlObj = new URL(url);
      const opts   = {
        hostname: urlObj.hostname,
        port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-WhaleTrack-Key': 'wt_moonsat_7f3k2x',
          'X-WhaleTrack-Test': 'true',
        },
      };
      const mod = urlObj.protocol === 'https:' ? https : http;
      const req = mod.request(opts, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ ${customerName}: webhook delivered [${res.statusCode}]`);
            console.log(`   Response: ${d.slice(0, 200)}`);
          } else {
            console.log(`❌ ${customerName}: server returned ${res.statusCode}`);
            console.log(`   Response: ${d.slice(0, 200)}`);
          }
          resolve();
        });
      });
      req.setTimeout(10000, () => { req.destroy(); console.log(`❌ ${customerName}: timeout`); resolve(); });
      req.on('error', (e) => { console.log(`❌ ${customerName}: ${e.message}`); resolve(); });
      req.write(body);
      req.end();
    } catch (e) {
      console.log(`❌ ${customerName}: ${e.message}`);
      resolve();
    }
  });
}

async function main() {
  const urlArg = process.argv[2];

  if (urlArg) {
    // Test a specific URL directly
    console.log(`\n🔗 Testing webhook → ${urlArg}\n`);
    await postTest(urlArg, 'MoonSat');
  } else {
    // Test all active customers from config
    let customers = [];
    try { customers = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')); } catch (e) {}
    const active = customers.filter(c => c.url && c.active);
    if (!active.length) {
      console.log('⚠️  No active customers with URLs yet.');
      console.log('   Usage: node test_webhook.cjs <URL>');
      console.log('   Or set active:true and url in webhook_customers.json');
      return;
    }
    console.log(`\n🐋 Testing ${active.length} webhook customer(s)...\n`);
    for (const c of active) await postTest(c.url, c.name);
  }

  console.log('\n📋 Test payload sent:');
  console.log('   whale: somalianKing');
  console.log('   market: Will Bitcoin hit $200,000 in 2026?');
  console.log('   outcome: Yes | size: $47K | price: 62¢');
}

main();
