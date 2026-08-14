# How I Added a Premium Telegram Alert Bot to My Polymarket Whale Tracker — And Why Speed Is the Product

I built [WhaleTrack](https://whaletrack.app) a few weeks ago — a live dashboard that tracks the biggest wallets on Polymarket. Got some good traction, a few hundred users, and a free Twitter bot posting whale alerts automatically.

Then someone asked me: *"Why would I pay for this when you're posting the same data for free on Twitter?"*

Fair question. It made me rethink what the product actually was.

---

## The Problem With Twitter Alerts

The Twitter bot works fine. It detects a whale trade and posts within the next 5-minute polling cycle. But here's the thing — by the time it posts, the window is already closing.

Polymarket is liquid. If a whale drops $50K on a market and moves the price, people who see the tweet 20 minutes later are buying into an already-shifted market.

**Speed is the product. Not the data.**

Free users get the data. Premium users get it first.

---

## The Architecture

Zero npm dependencies — same as the first article. Pure Node.js with the built-in `https` and `crypto` modules.

The bot uses **long polling** instead of webhooks:

```js
async function poll() {
  while (true) {
    try {
      const data = await fetchJson(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`
      );
      for (const u of (data.result || [])) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (msg?.text?.startsWith('/')) {
          handleCommand(msg.chat.id, msg.text);
        }
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
```

Long polling holds the connection open for 30 seconds waiting for updates, then immediately reconnects. No webhooks needed, no server config, works fine from a Mac running 24/7.

---

## Two Alert Tiers

Every whale trade fires two alerts — premium first, free after.

**Free alert:**
```
🐋 Whale Alert!

somalianKing just bought
🟢 Yes $47K @ 62¢

📊 Will Argentina win the World Cup?

🔓 Get win rate + instant alerts → upgrade to Premium
🌐 whaletrack.app
```

**Premium alert (fires first):**
```
⚡ PREMIUM Whale Alert

somalianKing just bet $47,000
🟢 Yes @ 62¢

📊 Will Argentina win the World Cup?

🐋 This whale's track record:
• Rank: #3 on Polymarket
• Total P&L: +$284K
• Win rate: 71% (34 resolved trades)

🎯 Copy this bet on Polymarket →
⏱ You're seeing this 10+ min before Twitter
```

The premium alert has three things free doesn't: win rate, P&L context, and a direct affiliate link to copy the bet.

---

## The Win Rate Calculation

This was the interesting part. Polymarket doesn't give you a clean "won/lost" field on activity records — you have to infer it from sell prices.

The logic:
- Fetch last 50 trades for a wallet
- Filter for SELL transactions only
- Sold at **≥ 0.85** = win (exited near $1 resolution)
- Sold at **≤ 0.15** = loss (exited near $0 resolution)
- Everything in between = position still live or unclear

```js
async function fetchWinRate(address) {
  const activity = await fetchActivity(address, 50);
  const sells = activity.filter(t => t.side === 'SELL' && parseFloat(t.price || 0) > 0);

  let wins = 0, losses = 0;
  for (const t of sells) {
    const price = parseFloat(t.price || 0);
    if (price >= 0.85)      wins++;
    else if (price <= 0.15) losses++;
  }

  const total = wins + losses;
  return total > 0 ? Math.round((wins / total) * 100) : null;
}
```

I cache the result for 30 minutes per wallet since it's an expensive-ish call (50 activity records per whale).

---

## Premium Subscriber Management

Kept it dead simple — a JSON file on disk.

```js
let premiumSubs = loadJson(PREMIUM_SUBS_FILE, []); // [chatId, chatId, ...]
```

When someone pays (manually verified for now), I run `/addpremium <chatId>` in my own chat with the bot. It adds them to the array, saves the file, and sends them a welcome message.

No Stripe, no database, no webhook. Works fine at this scale.

---

## The Speed Advantage in Practice

The polling cycle runs every 5 minutes. Premium fires at the top of the cycle. Free fires at the bottom — after premium has already been delivered.

In practice this means premium users see alerts 5–10 minutes before the Twitter bot posts, and 10–20 minutes before anyone on Twitter actually sees it and acts on it.

On a fast-moving market, that gap matters.

---

## What I Learned

**1. Speed is a real value prop.** Not "more features" — just faster. Simple to understand, easy to sell.

**2. Long polling is underrated.** Webhooks need a server with a public URL and SSL. Long polling works from anywhere. For a side project, that simplicity is worth it.

**3. Keep the free tier genuinely useful.** The free alert is still real value. Premium isn't a paywall on the core product — it's an upgrade on timing and context. That distinction matters for trust.

**4. Manual premium management is fine at the start.** Don't build Stripe until you have 10 paying customers. A JSON file is enough to validate demand.

---

## What's Next

- Proper payment flow (Stripe or Gumroad)
- Filter premium alerts by whale win rate threshold (only fire if whale is 60%+ win rate)
- Web dashboard showing premium-only whale analytics

Bot is live at [@WhaleTrackBot](https://t.me/WhaleTrackPolybot) on Telegram. Free tier available, premium is $9/month.

Live site: [whaletrack.app](https://whaletrack.app)

Happy to answer questions about the Telegram API, win rate logic, or the alert architecture.
