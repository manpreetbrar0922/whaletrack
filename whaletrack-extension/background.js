// WhaleTrack background service worker
// Polls Polymarket API every 2 minutes, updates badge, fires notifications for big bets

const WHALES = {
  '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': { name: 'somalianKing', icon: '👑' },
  '0x09b428f7c2b469786286214aa5c90dd9015f7320': { name: 'DEEDDIT',       icon: '🔥' },
  '0x50f0a0fc7364d3c10fc4578b9b1d955368335355': { name: 'bettguy',        icon: '🎯' },
  '0x7c1ee865a785de4c00ee90ed86a38489fb8bbab3': { name: 'CandleHammerDrums', icon: '🥁' },
  '0x640de3430e9a05e1b1fe04b42d651da1abe99a4c': { name: 'coldsway',       icon: '❄️' },
};

function fmtUSD(n) {
  n = Math.abs(parseFloat(n) || 0);
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

async function fetchAllWhales() {
  const allTrades = [];
  const fetches = Object.entries(WHALES).map(async ([addr, info]) => {
    try {
      const r = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=15`);
      if (!r.ok) return;
      const trades = await r.json();
      if (!Array.isArray(trades)) return;
      for (const t of trades) {
        if (t.side !== 'BUY') continue;
        allTrades.push({
          whale:     info.name,
          icon:      info.icon,
          addr,
          title:     (t.title || 'Unknown Market').slice(0, 80),
          outcome:   t.outcome || '?',
          price:     parseFloat(t.price || 0),
          size:      parseFloat(t.usdcSize || 0),
          timestamp: t.timestamp || 0,
          slug:      t.slug || '',
        });
      }
    } catch (_) {}
  });

  await Promise.all(fetches);
  allTrades.sort((a, b) => b.timestamp - a.timestamp);
  return allTrades.slice(0, 40);
}

async function pollWhales() {
  try {
    const trades = await fetchAllWhales();
    const { lastSeenTs = 0 } = await chrome.storage.local.get('lastSeenTs');

    // Trades newer than lastSeenTs
    const newTrades = trades.filter(t => t.timestamp > lastSeenTs && t.size >= 3000);
    const bigTrades = newTrades.filter(t => t.size >= 15000);

    // Save to storage
    await chrome.storage.local.set({
      trades,
      lastFetch: Date.now(),
      newCount: newTrades.length,
    });

    // Update badge
    if (newTrades.length > 0) {
      await chrome.action.setBadgeText({ text: String(newTrades.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
    }

    // Desktop notification for big bets
    if (bigTrades.length > 0) {
      const t = bigTrades[0];
      chrome.notifications.create(`whale-${t.timestamp}-${t.addr}`, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: `🐋 ${t.whale} just bet ${fmtUSD(t.size)}!`,
        message: `${t.outcome === 'Yes' ? '🟢 YES' : '🔴 NO'} @ ${Math.round(t.price * 100)}¢ on "${t.title}"`,
        priority: 1,
      });
    }
  } catch (_) {}
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('wt-poll', { periodInMinutes: 2 });
  pollWhales();
});

// Wake up on alarm
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'wt-poll') pollWhales();
});

// Message from popup: clear badge + update lastSeenTs
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'POPUP_OPENED') {
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.set({
      lastSeenTs: Math.floor(Date.now() / 1000),
      newCount: 0,
    });
    sendResponse({ ok: true });
  }
  if (msg.type === 'GET_TRADES') {
    chrome.storage.local.get(['trades', 'lastFetch'], data => {
      sendResponse(data);
    });
    return true; // async
  }
});
