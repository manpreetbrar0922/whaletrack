// WhaleTrack content script — injected on polymarket.com
// Shows a floating 🐋 button with live whale feed panel

(function () {
  'use strict';

  // Don't inject twice
  if (document.getElementById('wt-launcher')) return;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtUSD(n) {
    n = Math.abs(parseFloat(n) || 0);
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(0);
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // ── Build UI ───────────────────────────────────────────────────────────────
  const launcher = document.createElement('div');
  launcher.id = 'wt-launcher';
  launcher.innerHTML = `
    <div id="wt-panel">
      <div id="wt-panel-header">
        <span id="wt-panel-title">🐋 WhaleTrack — Live Feed</span>
        <button id="wt-panel-close">✕</button>
      </div>
      <div id="wt-feed">
        <div class="wt-loading">Loading whale trades…</div>
      </div>
      <div id="wt-footer">
        <a href="https://whaletrack.app" target="_blank">View full tracker + copy-trade links →</a>
      </div>
    </div>
    <button id="wt-btn" title="WhaleTrack — Live Whale Feed">
      🐋
      <span id="wt-badge"></span>
    </button>
  `;
  document.body.appendChild(launcher);

  // ── Wire up events ─────────────────────────────────────────────────────────
  const btn   = document.getElementById('wt-btn');
  const panel = document.getElementById('wt-panel');
  const close = document.getElementById('wt-panel-close');
  const feed  = document.getElementById('wt-feed');
  const badge = document.getElementById('wt-badge');

  let isOpen = false;

  btn.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen) {
      badge.style.display = 'none';
      loadFeed();
    }
  });

  close.addEventListener('click', () => {
    isOpen = false;
    panel.classList.remove('open');
  });

  // ── Load feed from extension storage ──────────────────────────────────────
  function renderTrades(trades) {
    if (!trades || !trades.length) {
      feed.innerHTML = '<div class="wt-loading">No recent whale trades found.</div>';
      return;
    }

    feed.innerHTML = trades.slice(0, 20).map(t => {
      const priceCents = Math.round((parseFloat(t.price) || 0) * 100);
      const outcome = (t.outcome || '').toLowerCase();
      const cls = outcome === 'yes' ? 'wt-yes' : 'wt-no';
      const label = outcome === 'yes' ? '🟢 YES' : '🔴 NO';
      const SLUGS = { somalianKing:'somalianking', DEEDDIT:'deeddit', bettguy:'bettguy', CandleHammerDrums:'candlehammerdrums', coldsway:'coldsway' };
      const wSlug = SLUGS[t.whale] || '';
      const pmUrl = wSlug ? `https://whaletrack.app/whale/${wSlug}` : 'https://whaletrack.app';

      return `<a href="${pmUrl}" target="_blank" class="wt-trade">
        <div class="wt-trade-top">
          <span class="wt-whale">${t.icon || '🐋'} ${t.whale}</span>
          <span class="wt-time">${timeAgo(t.timestamp)}</span>
        </div>
        <div class="wt-title">${t.title}</div>
        <div class="wt-meta">
          <span class="wt-outcome ${cls}">${label} @ ${priceCents}¢</span>
          <span class="wt-size">${fmtUSD(t.size)}</span>
        </div>
      </a>`;
    }).join('');
  }

  function loadFeed() {
    // Read from extension storage (populated by background.js)
    try {
      chrome.storage.local.get(['trades', 'newCount'], data => {
        renderTrades(data.trades || []);
      });
    } catch (e) {
      feed.innerHTML = '<div class="wt-loading">Could not load. Open the extension popup.</div>';
    }
  }

  // Check for new whale count on load to update badge
  try {
    chrome.storage.local.get(['newCount'], data => {
      const count = data.newCount || 0;
      if (count > 0) {
        badge.textContent = count > 9 ? '9+' : String(count);
        badge.style.display = 'flex';
      }
    });
  } catch (_) {}

  // Listen for storage changes (new whale bets come in while page is open)
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.trades && isOpen) {
        renderTrades(changes.trades.newValue || []);
      }
      if (changes.newCount) {
        const count = changes.newCount.newValue || 0;
        if (count > 0 && !isOpen) {
          badge.textContent = count > 9 ? '9+' : String(count);
          badge.style.display = 'flex';
        }
      }
    });
  } catch (_) {}

})();
