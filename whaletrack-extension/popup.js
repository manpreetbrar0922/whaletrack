// WhaleTrack popup script

const WHALES = {
  '0x91e8a6edec03e7a81c88621123ebd041cb5ef1ab': 'somalianKing',
  '0x09b428f7c2b469786286214aa5c90dd9015f7320': 'DEEDDIT',
  '0x50f0a0fc7364d3c10fc4578b9b1d955368335355': 'bettguy',
  '0x7c1ee865a785de4c00ee90ed86a38489fb8bbab3': 'CandleHammerDrums',
  '0x640de3430e9a05e1b1fe04b42d651da1abe99a4c': 'coldsway',
};

const WHALE_SLUGS = {
  somalianKing:       'somalianking',
  DEEDDIT:            'deeddit',
  bettguy:            'bettguy',
  CandleHammerDrums:  'candlehammerdrums',
  coldsway:           'coldsway',
};

function fmtUSD(n) {
  n = Math.abs(parseFloat(n) || 0);
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)   return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400)return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function renderFeed(trades, lastFetch) {
  const list = document.getElementById('feed-list');
  const lastUpdatedEl = document.getElementById('last-updated');

  if (!trades || !trades.length) {
    list.innerHTML = '<div class="empty-state">No whale trades found yet.<br>Check back in a minute.</div>';
    return;
  }

  const lastSeenTs = parseInt(localStorage.getItem('lastSeenTs') || '0');
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

  list.innerHTML = trades
    .filter(t => t.timestamp > oneHourAgo * 0 || true) // show all
    .slice(0, 25)
    .map(t => {
      const isNew = t.timestamp > lastSeenTs && t.size >= 3000;
      const priceCents = Math.round((parseFloat(t.price) || 0) * 100);
      const outcome = (t.outcome || '').toLowerCase();
      const outcomeClass = outcome === 'yes' ? 'outcome-yes' : 'outcome-no';
      const outcomeLabel = outcome === 'yes' ? '🟢 YES' : '🔴 NO';
      const slug = WHALE_SLUGS[t.whale] || '';
      // Link to whale profile — avoids 404s on resolved/archived Polymarket market pages
      const pmUrl = slug ? `https://whaletrack.app/whale/${slug}` : 'https://whaletrack.app';

      return `<a href="${pmUrl}" target="_blank" class="trade-item${isNew ? ' new' : ''}">
        <div class="trade-top">
          <span class="trade-whale">${t.icon || '🐋'} ${t.whale}</span>
          <span class="trade-time">${timeAgo(t.timestamp)}</span>
        </div>
        <div class="trade-title">${t.title}</div>
        <div class="trade-meta">
          <span class="trade-outcome ${outcomeClass}">${outcomeLabel} @ ${priceCents}¢</span>
          <span class="trade-size">${fmtUSD(t.size)}</span>
        </div>
      </a>`;
    }).join('');

  if (lastFetch) {
    const elapsed = Math.round((Date.now() - lastFetch) / 1000);
    lastUpdatedEl.textContent = `Updated ${elapsed < 10 ? 'just now' : elapsed + 's ago'} · Next in ~${Math.max(0, 120 - elapsed)}s`;
  }
}

async function loadFeed() {
  // Tell background we opened the popup (clears badge)
  try {
    chrome.runtime.sendMessage({ type: 'POPUP_OPENED' });
  } catch (_) {}

  // Try to load from storage first (instant)
  chrome.storage.local.get(['trades', 'lastFetch'], data => {
    if (data.trades && data.trades.length) {
      renderFeed(data.trades, data.lastFetch);
    }
  });

  // Also do a fresh fetch if storage is stale or empty
  try {
    const fresh = await fetchFresh();
    if (fresh && fresh.length) {
      renderFeed(fresh, Date.now());
      chrome.storage.local.set({ trades: fresh, lastFetch: Date.now() });
    }
  } catch (_) {
    // Fall back to cached data
    chrome.storage.local.get(['trades', 'lastFetch'], data => {
      if (data.trades) renderFeed(data.trades, data.lastFetch);
    });
  }
}

async function fetchFresh() {
  const WHALE_ADDRS = Object.keys(WHALES);
  const allTrades = [];

  await Promise.all(WHALE_ADDRS.map(async addr => {
    try {
      const r = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=15`);
      if (!r.ok) return;
      const trades = await r.json();
      if (!Array.isArray(trades)) return;
      for (const t of trades) {
        if (t.side !== 'BUY') continue;
        const whaleName = WHALES[addr];
        allTrades.push({
          whale:     whaleName,
          icon:      { somalianKing:'👑', DEEDDIT:'🔥', bettguy:'🎯', CandleHammerDrums:'🥁', coldsway:'❄️' }[whaleName] || '🐋',
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
  }));

  allTrades.sort((a, b) => b.timestamp - a.timestamp);
  return allTrades.slice(0, 40);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadFeed();

// Record open time
localStorage.setItem('lastSeenTs', String(Math.floor(Date.now() / 1000)));
