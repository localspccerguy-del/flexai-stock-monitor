const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // subscriber channel — trade alerts only
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID; // 2026-07-13 — personal chat, system messages only
if (!ADMIN_CHAT_ID) {
  console.error("WARNING: TELEGRAM_ADMIN_CHAT_ID env var is not set on Render — admin-destined messages (weekend futures checks) will silently fail to send rather than leaking into the subscriber channel.");
}
const FLEXAI_URL = process.env.FLEXAI_URL || "https://www.flexaioptions.com";
const ADMIN_TOKEN = process.env.ADMIN_UNLOCK;
if (!ADMIN_TOKEN) {
  console.error("FATAL: ADMIN_UNLOCK env var is not set on Render — every flexai-saas call will 401.");
}
const fs = require("fs");
const COOLDOWN_FILE = "/tmp/flexai_cooldown.json";

let sentToday = {};
let lastDate = "";
let premarketDone = false;
let marketScanSlots = [];
let cryptoScanSlots = [];
let openingSignalDone = false;
let orbCaptureDone = false;
let orbBreakoutSlots = [];
let lastOrbBreakoutTotal = null;
let breakingNewsSlots = [];
let sectorSelloffDone = false;
let weekendSlotsSent = [];
let leapScanDone = false;
let dailyScannerDone = false;
let dailyWatchlistBuildDone = false;
let lastIntradayWatchlistBuildTotal = null;

try {
  const saved = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
  sentToday = saved.sentToday ?? {};
  lastDate = saved.date ?? "";
} catch(e) { console.log("Fresh cooldown start"); }

function saveCooldown() {
  try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ date: lastDate, sentToday })); } catch(e) {}
}

function checkReset() {
  const today = new Date().toISOString().split("T")[0];
  if (today !== lastDate) {
    sentToday = {};
    lastDate = today;
    premarketDone = false;
    marketScanSlots = [];
    cryptoScanSlots = [];
    openingSignalDone = false;
    orbCaptureDone = false;
    orbBreakoutSlots = [];
    lastOrbBreakoutTotal = null;
    breakingNewsSlots = [];
    sectorSelloffDone = false;
    weekendSlotsSent = [];
    leapScanDone = false;
    dailyScannerDone = false;
    dailyWatchlistBuildDone = false;
    lastIntradayWatchlistBuildTotal = null;
    saveCooldown();
    console.log("New trading day reset:", today);
  }
}

function getET() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return { hour: et.getHours(), min: et.getMinutes(), day: et.getDay() };
}

function isWeekday() {
  const { day } = getET();
  return day >= 1 && day <= 5;
}

const NYSE_HOLIDAYS_2026 = [
  "2026-1-1",   // New Year's Day
  "2026-1-19",  // MLK Day
  "2026-2-16",  // Presidents Day
  "2026-4-3",   // Good Friday
  "2026-5-25",  // Memorial Day
  "2026-6-19",  // Juneteenth
  "2026-7-3",   // Independence Day (observed — July 4 falls on a Saturday)
  "2026-9-7",   // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
];

function isMarketHoliday() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const key = `${et.getFullYear()}-${et.getMonth() + 1}-${et.getDate()}`;
  return NYSE_HOLIDAYS_2026.includes(key);
}

// destination: "subscribers" (default, for safety — a call site that
// forgets to specify a destination should never accidentally leak a
// system message to paying subscribers) or "admin" (Bill's personal
// chat, system messages only — 2026-07-13). Fails closed if the target
// chat ID isn't configured, rather than falling back to the other chat.
async function sendTelegram(msg, destination = "subscribers") {
  const chatId = destination === "admin" ? ADMIN_CHAT_ID : CHAT_ID;
  if (!chatId) {
    console.error(`Telegram error: no chat ID configured for destination "${destination}" — message not sent.`);
    return;
  }
  try {
    const fetch = (await import("node-fetch")).default;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
    });
  } catch(e) { console.error("Telegram error:", e.message); }
}

// Logs a sent alert to flexai-saas so the local video-render poller
// (flexai-video/poll-and-render.js) knows what fired and can render a
// video for it — this worker never touches video rendering itself.
async function logAlert(alert) {
  try {
    const fetch = (await import("node-fetch")).default;
    await fetch(`${FLEXAI_URL}/api/alerts/log?token=${ADMIN_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "stock",
        symbol: alert.symbol,
        alertType: alert.alertType,
        price: alert.price,
        target1: alert.target1,
        target2: alert.target2,
        stop: alert.stop,
        rsi: alert.rsi,
        ema9: alert.ema9,
      }),
    });
  } catch (e) { console.error("Log alert error:", e.message); }
}

// Cross-restart-durable same-symbol-same-day dedup — added 2026-07-08.
// sentToday alone isn't enough: it's wiped on every Render restart (every
// deploy), which is what let NET/META/LLY each fire twice on 2026-07-07
// (a mid-window restart lost the dedup state between scans). This checks
// (and atomically marks, if not already fired) a KV key that survives
// restarts. Fails open on a network error — same tolerance the rest of
// this worker has for a single bad HTTP call, better to risk a rare
// duplicate than to block all alerts on a dedup-check outage.
async function checkAlreadyFiredToday(symbol) {
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/alerts/dedup-check?token=${ADMIN_TOKEN}&symbol=${encodeURIComponent(symbol)}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    return data.alreadyFired === true;
  } catch (e) {
    console.error("Dedup check error:", e.message);
    return false;
  }
}

// Global cross-route daily alert cap (Task 1b, 5/day) — atomically reserves
// a slot before every actual Telegram send, across the main scan digest,
// ORB breakout, and the two new scanners below. Fails open on a network
// error, same tolerance as checkAlreadyFiredToday above.
async function checkDailyCapAvailable() {
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/alerts/cap-check?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    return data.allowed === true;
  } catch (e) {
    console.error("Cap check error:", e.message);
    return true;
  }
}

// Bearish (put-side) alert types — everything else in the main-scan digest
// is bucketed as a bullish/call watch item. MOMENTUM_SHIFT isn't a put
// trade signal, but it's a caution on an existing long (not a new call
// entry either) — bucketed here to match its existing treatment in
// runPremarketScan's premarketWeaknessWhy(), which already classifies it
// as "weakness", not a call to watch.
const BEARISH_ALERT_TYPES = new Set([
  "INTRADAY_BREAKDOWN", "BEAR_FLAG", "TREND_BREAK", "HEAD_AND_SHOULDERS",
  "RISING_WEDGE_BREAKDOWN", "DEATH_CROSS", "ASCENDING_CHANNEL_BREAKDOWN",
  "MOMENTUM_SHIFT", "ORB_BREAKDOWN",
]);

// Short one-line reason for the digest — pulled from the alert's own
// canonical card (line 2, the oneLiner formatBullishCard/formatBearishCard
// build), trimmed to its first sentence so the digest stays scannable.
function oneLinerReason(alert) {
  if (alert.message) {
    const lines = alert.message.split("\n").filter(Boolean);
    if (lines.length >= 2) {
      const firstSentence = lines[1].split(". ")[0];
      if (firstSentence) return firstSentence.length > 100 ? firstSentence.slice(0, 97) + "..." : firstSentence;
    }
  }
  return alert.alertType.replace(/_/g, " ").toLowerCase();
}

async function fetchAlerts() {
  const fetch = (await import("node-fetch")).default;
  const [daily, intraday] = await Promise.all([
    fetch(`${FLEXAI_URL}/api/options/ideas`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } }).then(r => r.json()),
    fetch(`${FLEXAI_URL}/api/options/intraday`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } }).then(r => r.json()),
  ]);
  return { ...daily, ...intraday, scanned: (daily.scanned ?? 0) + (intraday.scanned ?? 0) };
}

// Plain-English translations of the real underlying signal — tied to the
// actual gate each alertType fires on (see checkMomentumShift/checkTrendBreak
// in ideas/route.ts, checkStillTimeSetup for the bullish side), not generic
// filler text.
function premarketWeaknessWhy(a) {
  if (a.alertType === "MOMENTUM_SHIFT") {
    return "buyers stepping back, volume declining on the way up — warning sign";
  }
  if (a.alertType === "TREND_BREAK") {
    return "broke below a key price level it had been holding — trend may be turning";
  }
  return a.alertType.replace(/_/g, " ").toLowerCase();
}
function premarketStrengthWhy(a) {
  if (a.alertType === "STILL_TIME") {
    const gain = a.gainPct != null ? `${a.gainPct}%` : "recently";
    return `up ${gain} with no signs of slowing — RSI still healthy, volume still strong`;
  }
  return a.alertType.replace(/_/g, " ").toLowerCase();
}

async function runPremarketScan() {
  if (!isWeekday() || premarketDone) return;
  console.log("Running pre-market scan...");
  try {
    const data = await fetchAlerts();

    // De-dupe by symbol across both weakness sources, then keep strength
    // entries out of the weakness set too — a stock never appears twice.
    const seen = new Set();
    const weakness = [];
    for (const a of [...(data.trendBreakAlerts ?? []), ...(data.momentumAlerts ?? [])]) {
      if (seen.has(a.symbol)) continue;
      seen.add(a.symbol);
      weakness.push(a);
      if (weakness.length >= 5) break;
    }
    const strength = [];
    for (const a of (data.stillTimeIdeas ?? [])) {
      if (seen.has(a.symbol)) continue;
      seen.add(a.symbol);
      strength.push(a);
      if (strength.length >= 5) break;
    }

    const disclaimer = "These are pre-market observations only — do NOT enter yet.\nWait for the opening range to confirm direction after 10:30am.\n⚠️ Not financial advice";

    if (weakness.length === 0 && strength.length === 0) {
      await sendTelegram(`👀 STOCKS TO WATCH TODAY\n\nNo early warnings — market looks clean heading into the open.\n\n${disclaimer}`);
      premarketDone = true;
      console.log("Pre-market scan complete");
      return;
    }

    let msg = "👀 STOCKS TO WATCH TODAY\n\n";
    if (weakness.length > 0) {
      msg += "⚠️ STOCKS SHOWING WEAKNESS:\n";
      for (const a of weakness) {
        msg += `${a.symbol} $${a.price} — ${premarketWeaknessWhy(a)}\n`;
      }
      msg += "→ Avoid new call entries on these. Watch for put setups if they open weak.\n\n";
    }
    if (strength.length > 0) {
      msg += "💪 STOCKS SHOWING STRENGTH:\n";
      for (const a of strength) {
        msg += `${a.symbol} $${a.price} — ${premarketStrengthWhy(a)}\n`;
      }
      msg += "→ Watch for entry on any pullback after open.\n\n";
    }
    msg += disclaimer;
    await sendTelegram(msg);
    premarketDone = true;
    console.log("Pre-market scan complete");
  } catch(e) { console.error("Pre-market error:", e.message); }
}

// Main scan digest — 2026-07-12 scanner split: SWING_CALL, WEEKLY_BOUNCE,
// COMPRESSION_BREAKOUT, BULL_FLAG, BEAR_FLAG, STILL_TIME (daily), and
// TREND_BREAK are now exclusively handled by runDailyScannerCheck below
// (own 2/day cap, 10am-only, 200 EMA directional zone) — removed from
// this priority list to avoid double-firing through both paths. Everything
// remaining here is an "unlisted, left alone" type per that same split:
// unchanged conditions, unchanged watchlist, unchanged schedule.
async function runMarketScan(slotLabel) {
  if (!isWeekday() || marketScanSlots.includes(slotLabel)) return;
  console.log(`Running market scan (${slotLabel})...`);
  checkReset();
  try {
    const data = await fetchAlerts();
    const allAlerts = [
      ...(data.momentumAlerts ?? []).map((a) => ({ ...a, priority: 1 })),
      ...(data.breakouts ?? []).map((a) => ({ ...a, priority: 2 })),
      ...(data.intradayMoves ?? []).filter(a => a.alertType === "INTRADAY_STILL_TIME").map((a) => ({ ...a, priority: 3 })),
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "CHEAPER_LEAP").map((a) => ({ ...a, priority: 4 })),
      ...(data.dramAlerts ?? []).map((a) => ({ ...a, priority: 4.5 })),
      ...(data.intradayMoves ?? []).filter(a => a.alertType === "INTRADAY_BREAKDOWN").map((a) => ({ ...a, priority: 5 })),
      // Chart patterns bucket now only ever contains Golden/Death Cross
      // and Inverse Head & Shoulders — every other pattern type moved to
      // the daily scanner (see comment above).
      ...(data.patternAlerts ?? []).map((a) => ({ ...a, priority: 6 })),
      ...(data.callIdeas ?? []).map((a) => ({ ...a, priority: 7 })),
      ...(data.wheelIdeas ?? []).map((a) => ({ ...a, priority: 8 })),
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "OVERSOLD_BOUNCE").map((a) => ({ ...a, priority: 9 })),
    ].sort((a, b) => a.priority - b.priority);

    // Task 1a — collect up to 5 qualifying alerts and send ONE digest
    // Telegram per scan window instead of up to 5 separate messages.
    // Each alert is still individually deduped/logged/capped exactly as
    // before; only the actual Telegram send is batched.
    let sent = 0;
    const MAX = 5;
    const calls = [];
    const puts = [];
    for (const alert of allAlerts) {
      if (sent >= MAX) break;
      if (sentToday[alert.symbol]) continue;
      if (!alert.message) continue;
      // KV-backed dedup, durable across worker restarts — checked in
      // addition to (not instead of) the in-memory sentToday check above,
      // which stays as a fast local pre-filter within a single process
      // lifetime.
      if (await checkAlreadyFiredToday(alert.symbol)) {
        sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
        continue;
      }
      if (!(await checkDailyCapAvailable())) {
        console.log("Daily alert cap (5) reached — stopping scan collection");
        break;
      }
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      (BEARISH_ALERT_TYPES.has(alert.alertType) ? puts : calls).push(alert);
      console.log("Queued", alert.alertType, "for", alert.symbol);
    }

    if (sent === 0) {
      await sendTelegram("FlexAI Market Scan Complete\n\nNo high-conviction setups found today. The filter is working — no forced alerts.\n\nNot financial advice.");
    } else {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      let h = et.getHours();
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12; if (h === 0) h = 12;
      const timeLabel = `${h}:${String(et.getMinutes()).padStart(2, "0")} ${ampm}`;
      const dateLabel = now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
      let msg = `📊 FLEXAI SCAN — ${timeLabel} ET — ${dateLabel}\n\n`;
      if (calls.length > 0) {
        msg += "🚀 CALLS TO WATCH:\n";
        for (const a of calls) msg += `${a.symbol} $${a.price} — ${oneLinerReason(a)}\n`;
        msg += "\n";
      }
      if (puts.length > 0) {
        msg += "⚠️ WEAKNESS — PUTS IN PLAY:\n";
        for (const a of puts) msg += `${a.symbol} $${a.price} — ${oneLinerReason(a)}\n`;
        msg += "\n";
      }
      msg += "⚠️ NOT FINANCIAL ADVICE";
      await sendTelegram(msg);
    }

    console.log("Scanned:", data.scanned ?? 0, "Sent:", sent);
    marketScanSlots.push(slotLabel);
  } catch(e) { console.error("Market scan error:", e.message); }
}

// Crypto big-mover scan — separate cap (max 3/day) from the 5 stock
// alerts above. The route itself sends the Telegram messages and tracks
// its own per-day cooldown/cap in KV (10%+ move threshold, unchanged);
// this just triggers it at each of its two daily slots.
async function runCryptoScan(slotLabel) {
  if (cryptoScanSlots.includes(slotLabel)) return;
  console.log(`Running crypto scan (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/crypto/movers/run?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log("Crypto scan — scanned:", data.scanned ?? 0, "alerts sent:", data.alertsSent ?? 0);
    cryptoScanSlots.push(slotLabel);
  } catch(e) { console.error("Crypto scan error:", e.message); }
}

// Opening Hour Signal — 10:35am ET, after SPY/QQQ's first hourly candle
// closes. The route itself computes the candle color, 9 EMA, and sends
// the Telegram message; this just triggers it once a day.
async function runOpeningSignalCheck() {
  if (openingSignalDone) return;
  console.log("Running opening hour signal check...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/opening-signal?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log("Opening signal —", data.ok ? "sent" : `failed: ${data.error}`);
    openingSignalDone = true;
  } catch(e) { console.error("Opening signal error:", e.message); }
}

// ORB (Opening Range Breakout) capture — 10:30am ET, records the high/low
// of each watchlist symbol's first 60-minute candle for the day. Part of
// the OLD 60-minute scored ORB system — deliberately untouched by the
// 2026-07-12 scanner split (that split's ORB_BREAKOUT uses the newer
// 15-min system, folded directly into the intraday scanner instead).
async function runOrbCapture() {
  if (orbCaptureDone) return;
  console.log("Running ORB range capture...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/orb/capture?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log("ORB capture — captured:", data.captured ?? 0, "of", data.watchlistSize ?? 0);
    orbCaptureDone = true;
  } catch(e) { console.error("ORB capture error:", e.message); }
}

// Scored ORB breakout check — the OLD 60-minute-range system, untouched
// by the 2026-07-12 scanner split (see runOrbCapture comment above). No
// per-day cap — every qualifying breakout gets an alert.
async function runOrbBreakoutCheck(slotLabel) {
  if (orbBreakoutSlots.includes(slotLabel)) return;
  console.log(`Running ORB breakout check (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/orb/breakout?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.alerts ?? [];
    let sent = 0;
    for (const alert of alerts) {
      if (!(await checkDailyCapAvailable())) {
        console.log("Daily alert cap (5) reached — stopping ORB sends");
        break;
      }
      await sendTelegram(alert.message);
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`ORB breakout check — ${data.newlyPending ?? 0} newly pending, ${alerts.length} confirmed, ${sent} sent`);
    orbBreakoutSlots.push(slotLabel);
  } catch(e) { console.error("ORB breakout check error:", e.message); }
}

// Breaking news check — the route is self-contained (sends Telegram
// directly and tracks its own 3/day cap in KV), this just triggers it.
// Separate from runMarketScan's 5-alert cap on purpose — breaking news is
// urgent and shouldn't compete with or wait behind other alert types.
async function runBreakingNewsCheck(slotLabel) {
  if (breakingNewsSlots.includes(slotLabel)) return;
  console.log(`Running breaking news check (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/news/breaking?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log("Breaking news check —", data.reason === "daily_cap_reached" ? "daily cap already reached" : `${(data.sent ?? []).length} sent, ${data.sentToday ?? 0}/3 today`);
    breakingNewsSlots.push(slotLabel);
  } catch(e) { console.error("Breaking news check error:", e.message); }
}

// LEAP scan check — daily-bar 20 EMA pullback-in-uptrend scanner, once/day.
// Unlisted in the 2026-07-12 scanner split — left alone, unchanged.
async function runLeapScanCheck() {
  if (leapScanDone) return;
  console.log("Running LEAP scan check...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/leap-scan?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.alerts ?? [];
    let sent = 0;
    for (const alert of alerts) {
      if (sentToday[alert.symbol]) continue;
      if (!(await checkDailyCapAvailable())) {
        console.log("Daily alert cap (5) reached — stopping LEAP scan sends");
        break;
      }
      await sendTelegram(alert.message);
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`LEAP scan check — ${alerts.length} found, ${sent} sent`);
    leapScanDone = true;
  } catch(e) { console.error("LEAP scan check error:", e.message); }
}

// ============================================================
// 2026-07-12 SCANNER SPLIT — two new consolidated scanners, replacing
// runVwapCheck/runShortTermCheck/runOrb15Check (all removed; their logic
// is now folded directly into app/api/options/intraday/route.ts).
// ============================================================

// INTRADAY SCANNER — VWAP_PULLBACK, ORB_BREAKOUT/ORB_BREAKDOWN,
// RIDING_THE_9, VWAP_CONTINUATION. No slot/window restriction at all —
// called unconditionally every tick during market hours by tick() below;
// the route itself owns the 3/day cap and one-per-symbol-per-day dedup,
// so there's nothing for the worker to locally gate.
async function runIntradayScannerCheck() {
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/intraday`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.intradayScannerAlerts ?? [];
    let sent = 0;
    for (const alert of alerts) {
      if (sentToday[alert.symbol]) continue;
      if (!(await checkDailyCapAvailable())) {
        console.log("Daily alert cap (5) reached — stopping intraday scanner sends");
        break;
      }
      await sendTelegram(alert.message);
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    if (sent > 0) console.log(`Intraday scanner — ${alerts.length} found, ${sent} sent`);
  } catch(e) { console.error("Intraday scanner error:", e.message); }
}

// DAILY SCANNER — COMPRESSION_BREAKOUT, STILL_TIME, SWING_CALL, BULL_FLAG,
// BEAR_FLAG, WEEKLY_BOUNCE, 200_EMA_BOUNCE, TREND_BREAK, HEAD_AND_SHOULDERS,
// wedge patterns, channel patterns. Runs ONCE at the 10am ET window — the
// route itself self-gates dailyScannerAlerts to empty outside that window
// AND owns the 2/day cap + one-per-symbol dedup; dailyScannerDone here is
// just the worker's own once-per-day guard against calling it again this
// same window before the day resets.
async function runDailyScannerCheck() {
  if (dailyScannerDone) return;
  console.log("Running daily scanner check...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/ideas`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.dailyScannerAlerts ?? [];
    let sent = 0;
    for (const alert of alerts) {
      if (sentToday[alert.symbol]) continue;
      if (!(await checkDailyCapAvailable())) {
        console.log("Daily alert cap (5) reached — stopping daily scanner sends");
        break;
      }
      await sendTelegram(alert.message);
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`Daily scanner check — ${alerts.length} found, ${sent} sent`);
    dailyScannerDone = true;
  } catch(e) { console.error("Daily scanner check error:", e.message); }
}

// ============================================================
// 2026-07-14 — fully dynamic watchlists (no hardcoded stocks anywhere).
// These trigger flexai-saas's lib/dynamicWatchlist.ts build functions via
// their API routes; both scanners self-heal on a KV cache miss, so these
// triggers are about keeping the lists FRESH, not a hard prerequisite.
// ============================================================

// Daily watchlist (List 2) — built once at 9am ET, well before the 10am
// daily scanner needs it.
async function runDailyWatchlistBuild() {
  if (dailyWatchlistBuildDone) return;
  console.log("Building daily watchlist...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/watchlist/daily-refresh?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log(`Daily watchlist built — ${data.count ?? 0} symbols`);
    dailyWatchlistBuildDone = true;
  } catch(e) { console.error("Daily watchlist build error:", e.message); }
}

// Intraday watchlist (List 1) — rebuilt every ~30 min during market hours,
// same elapsed-time-tracking pattern as the ORB checks (not modulo —
// robust to an arbitrary Render-restart offset).
async function runIntradayWatchlistBuild(slotLabel) {
  console.log(`Building intraday watchlist (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/watchlist/intraday-refresh?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log(`Intraday watchlist built — ${data.count ?? 0} symbols`);
  } catch(e) { console.error("Intraday watchlist build error:", e.message); }
}

// Sector selloff check — 10am scan only. The route itself sends any
// per-sector Telegram alerts and tracks its own per-sector daily cap in
// KV; this just triggers it once during the 10am window.
async function runSectorSelloffCheck() {
  if (sectorSelloffDone) return;
  console.log("Running sector selloff check...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/sector-selloff?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log("Sector selloff —", data.ok ? `sectors alerted: ${(data.alertsFired ?? []).join(", ") || "none"}` : `failed: ${data.error}`);
    sectorSelloffDone = true;
  } catch(e) { console.error("Sector selloff error:", e.message); }
}

// Weekend futures monitor — Alpaca doesn't support futures symbols
// (confirmed: ES=F returns "invalid symbol", no /futures endpoint exists
// on this account), so this uses Yahoo Finance, same as the site's old
// pre-FMP-migration futures fetcher.
const FUTURES = [
  { symbol: "ES=F", label: "S&P 500" },
  { symbol: "NQ=F", label: "Nasdaq" },
  { symbol: "YM=F", label: "Dow" },
];

const WEEKEND_FUTURES_SLOTS = [8, 12, 16, 20]; // hour-of-day, ET

async function getFuturesData() {
  const fetch = (await import("node-fetch")).default;
  const results = [];
  for (const f of FUTURES) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(f.symbol)}?interval=1m&range=1d`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prevClose = meta?.chartPreviousClose;
      if (typeof price !== "number" || typeof prevClose !== "number" || prevClose === 0) {
        results.push({ ...f, price: null, change: null });
      } else {
        results.push({ ...f, price, change: ((price - prevClose) / prevClose) * 100 });
      }
    } catch (e) {
      results.push({ ...f, price: null, change: null });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

function formatFuturesMessage(futures) {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  // Apply the ET timezone directly to `now`, not to `et` — `et` is already a
  // wall-clock-shifted Date via the round-trip-through-string trick used for
  // getHours()/getMinutes() below, so re-applying timeZone on top of it risks
  // double-converting and landing on the wrong day near midnight ET.
  const dayName = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  let h = et.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  const timeLabel = `${h}:00 ${ampm}`;

  const lines = [`📊 FUTURES CHECK — ${dayName} ${timeLabel} ET`, ``];
  for (const f of futures) {
    if (f.price == null) {
      lines.push(`${f.symbol} ${f.label}: data unavailable`);
      continue;
    }
    const arrow = f.change >= 0 ? "▲" : "▼";
    const sign = f.change >= 0 ? "+" : "";
    lines.push(`${f.symbol} ${f.label}: $${Math.round(f.price).toLocaleString("en-US")} ${sign}${f.change.toFixed(1)}% ${arrow}`);
  }
  lines.push(``, `Next check in 4 hours.`, `⚠️ Not financial advice`);
  return lines.join("\n");
}

async function runWeekendFuturesCheck(slotKey) {
  console.log("Running weekend futures check, slot:", slotKey);
  try {
    const futures = await getFuturesData();
    await sendTelegram(formatFuturesMessage(futures), "admin"); // 2026-07-13 — system/admin content, not a trade alert
    weekendSlotsSent.push(slotKey);
    console.log("Weekend futures check sent, slot:", slotKey);
  } catch (e) { console.error("Weekend futures check error:", e.message); }
}

async function tick() {
  checkReset();
  const { hour, min, day } = getET();
  const total = hour * 60 + min;

  // Crypto trades 24/7 — this must run independent of the stock-market
  // weekday/holiday gate below, or it silently never fires on weekends.
  // Two fixed daily slots: 10:00am and 4:00pm ET.
  if (total >= 600 && total < 610 && !cryptoScanSlots.includes("10:00")) {
    await runCryptoScan("10:00");
  }
  if (total >= 960 && total < 970 && !cryptoScanSlots.includes("16:00")) {
    await runCryptoScan("16:00");
  }

  // Weekend futures monitor — Sat/Sun only, every 4 hours (8a/12p/4p/8p
  // ET). Fires unconditionally regardless of movement, so it also runs
  // independent of the weekday gate below.
  const isWeekendDay = day === 0 || day === 6;
  if (isWeekendDay) {
    for (const slotHour of WEEKEND_FUTURES_SLOTS) {
      const slotKey = String(slotHour);
      const slotStart = slotHour * 60;
      if (total >= slotStart && total < slotStart + 30 && !weekendSlotsSent.includes(slotKey)) {
        await runWeekendFuturesCheck(slotKey);
      }
    }
  }

  if (isMarketHoliday()) { console.log("Market holiday — stock scans resting"); return; }
  if (!isWeekday()) { console.log("Weekend — stock scans resting"); return; }

  // INTRADAY SCANNER — 2026-07-12 scanner split. Runs unconditionally
  // every tick, 9:30am-4pm ET (total 570-960), no slot/window restriction
  // — literally every 5 minutes, independent of whatever else fires below.
  // Deliberately does NOT `return` after running, so the rest of the
  // (mutually-exclusive, one-thing-per-tick) chain below can still also
  // act on the same tick.
  if (total >= 570 && total <= 960) {
    await runIntradayScannerCheck();
  }

  // Pre-market watchlist: 8:20am ET (7:20am CT) — moved from 9:00am 2026-07-08
  // to give more lead time before the 9:30am open.
  if (total >= 500 && total < 510 && !premarketDone) {
    await runPremarketScan();
    return;
  }

  // Daily watchlist (List 2) build — 9:00am ET, once, well before the
  // 10am daily scanner needs it.
  if (total >= 540 && total < 550 && !dailyWatchlistBuildDone) {
    await runDailyWatchlistBuild();
    return;
  }

  // Intraday watchlist (List 1) build — every ~30 min, 9:30am-4pm ET,
  // matching the intraday scanner's own window. Elapsed-time tracking
  // (not modulo — see the scored ORB breakout check further down for why
  // modulo-based scheduling silently breaks across an arbitrary Render
  // restart offset).
  if (total >= 570 && total <= 960 && (lastIntradayWatchlistBuildTotal === null || total - lastIntradayWatchlistBuildTotal >= 30)) {
    lastIntradayWatchlistBuildTotal = total;
    await runIntradayWatchlistBuild(String(total));
    return;
  }

  // Breaking news check: every 30 minutes, 8:00am-4:00pm ET.
  if (total >= 480 && total <= 960 && total % 30 === 0 && !breakingNewsSlots.includes(String(total))) {
    await runBreakingNewsCheck(String(total));
    return;
  }

  // Main scan: 10:00am ET (9:00am CT) — after opening noise settles
  if (total >= 600 && total < 630 && !marketScanSlots.includes("10:00")) {
    await runMarketScan("10:00");
    return;
  }

  // Sector selloff check — 10am scan only.
  if (total >= 600 && total < 630 && !sectorSelloffDone) {
    await runSectorSelloffCheck();
    return;
  }

  // LEAP scan check — 10am ET, once/day. Daily-bar 20 EMA pullback scanner.
  if (total >= 600 && total < 630 && !leapScanDone) {
    await runLeapScanCheck();
    return;
  }

  // DAILY SCANNER — 2026-07-12 scanner split. Once at the 10am ET window,
  // same slot as sector selloff/LEAP scan above.
  if (total >= 600 && total < 630 && !dailyScannerDone) {
    await runDailyScannerCheck();
    return;
  }

  // ORB range capture: 10:30am ET — records each watchlist symbol's
  // opening 60-minute candle high/low right as it closes. OLD 60-min
  // scored ORB system, untouched by the scanner split.
  if (total >= 630 && total < 640 && !orbCaptureDone) {
    await runOrbCapture();
    return;
  }

  // Opening Hour Signal: 10:35am ET — right after the first 60-minute
  // candle (9:30-10:30am) closes.
  if (total >= 635 && total < 660 && !openingSignalDone) {
    await runOpeningSignalCheck();
    return;
  }

  // Scored ORB breakout check: roughly every 15 minutes, 10:30am-2:00pm ET.
  // OLD 60-min scored system, untouched by the scanner split — kept
  // running independently alongside the new ORB_BREAKOUT in the intraday
  // scanner above. Root-caused 2026-07-10: this used to require
  // `total % 15 === 0` — but tick() fires every 5 minutes starting from
  // whenever this process last started (an arbitrary Render restart
  // time, not aligned to any clock boundary), so `total` only ever lands
  // on an exact multiple of 15 if that restart happened to occur at a
  // minute-of-day itself divisible by 5 — roughly a 1-in-5 chance per
  // deploy. Fixed with elapsed-time tracking, robust to any restart offset.
  if (total >= 630 && total <= 840 && (lastOrbBreakoutTotal === null || total - lastOrbBreakoutTotal >= 15)) {
    lastOrbBreakoutTotal = total;
    await runOrbBreakoutCheck(String(total));
    return;
  }

  // Afternoon scan: 1:00pm ET — catches moves that develop after the
  // 10am window, which the old two-scan-a-day schedule always missed.
  if (total >= 780 && total < 810 && !marketScanSlots.includes("13:00")) {
    await runMarketScan("13:00");
    return;
  }

  // Late-afternoon scan: 3:30pm ET — last chance before the 4pm close.
  if (total >= 930 && total < 960 && !marketScanSlots.includes("15:30")) {
    await runMarketScan("15:30");
    return;
  }

  const { hour: h, min: m } = getET();
  console.log(`[${h}:${String(m).padStart(2,"0")} ET] Waiting for next scan window...`);
}

console.log("FlexAI Stock Monitor v5 — fully dynamic watchlists 2026-07-14");
console.log("Watchlists: DAILY (List 2, ~200-300) built 9:00am ET once | INTRADAY (List 1, ~100-150) rebuilt every ~30min 9:30am-4pm ET | No hardcoded stocks anywhere.");
console.log("Pre-market watchlist: 8:20am ET | INTRADAY SCANNER (VWAP_PULLBACK/ORB_BREAKOUT/RIDING_THE_9/VWAP_CONTINUATION): every 5min 9:30am-4pm ET, max 3/day | DAILY SCANNER (COMPRESSION_BREAKOUT/STILL_TIME/SWING_CALL/BULL_FLAG/BEAR_FLAG/WEEKLY_BOUNCE/200_EMA_BOUNCE/TREND_BREAK/HEAD_AND_SHOULDERS/wedges/channels): once at 10am ET, max 2/day | Legacy scans: 10:00am/1:00pm/3:30pm ET | Crypto: 10:00am/4:00pm ET | OLD 60-min scored ORB: 10:30am capture, breakout check ~every 15min 10:30am-2:00pm | LEAP scan: 10am");
tick();
setInterval(tick, 5 * 60 * 1000);
