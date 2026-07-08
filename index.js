const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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
let vwapCheckSlots = [];
let sectorSelloffDone = false;
let weekendSlotsSent = [];

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
    vwapCheckSlots = [];
    sectorSelloffDone = false;
    weekendSlotsSent = [];
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

async function sendTelegram(msg) {
  try {
    const fetch = (await import("node-fetch")).default;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML" }),
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

async function runMarketScan(slotLabel) {
  if (!isWeekday() || marketScanSlots.includes(slotLabel)) return;
  console.log(`Running market scan (${slotLabel})...`);
  checkReset();
  try {
    const data = await fetchAlerts();
    const allAlerts = [
      // Intraday alerts — highest priority, most time-sensitive
      ...(data.flagAlerts1H ?? []).map((a) => ({ ...a, priority: 1 })),
      ...(data.swingCalls ?? []).map((a) => ({ ...a, priority: 2 })),
      ...(data.breakouts ?? []).map((a) => ({ ...a, priority: 3 })),
      ...(data.intradayMoves ?? []).filter(a => a.alertType === "INTRADAY_STILL_TIME").map((a) => ({ ...a, priority: 4 })),
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "CHEAPER_LEAP").map((a) => ({ ...a, priority: 5 })),
      ...(data.intradayMoves ?? []).filter(a => a.alertType === "INTRADAY_BREAKDOWN").map((a) => ({ ...a, priority: 6 })),
      // Daily alerts — LEAP, Wheel, Still Time, flags
      ...(data.flagAlerts ?? []).filter((a) => a.alertType === "BULL_FLAG").map((a) => ({ ...a, priority: 7 })),
      ...(data.weeklyBounces ?? []).map((a) => ({ ...a, priority: 8 })),
      ...(data.callIdeas ?? []).map((a) => ({ ...a, priority: 9 })),
      ...(data.stillTimeIdeas ?? []).map((a) => ({ ...a, priority: 10 })),
      ...(data.wheelIdeas ?? []).map((a) => ({ ...a, priority: 11 })),
      // Warning alerts
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "OVERSOLD_BOUNCE").map((a) => ({ ...a, priority: 12 })),
      ...(data.trendBreakAlerts ?? []).map((a) => ({ ...a, priority: 13 })),
    ].sort((a, b) => a.priority - b.priority);

    let sent = 0;
    const MAX = 5;
    for (const alert of allAlerts) {
      if (sent >= MAX) break;
      if (sentToday[alert.symbol]) continue;
      if (!alert.message) continue;
      await sendTelegram(alert.message);
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      console.log("Sent", alert.alertType, "for", alert.symbol);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (sent === 0) {
      await sendTelegram("FlexAI Market Scan Complete\n\nNo high-conviction setups found today. The filter is working — no forced alerts.\n\nNot financial advice.");
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
// of each watchlist symbol's first 60-minute candle for the day.
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

// Scored ORB breakout check — replaces the old orb/check (simple 3/day-cap)
// system entirely, 2026-07-08. The route handles both fakeout-confirmation
// (candidates detected on the prior 15-min-spaced call) and new-candidate
// detection in one call; sends whatever confirmed, scored alerts it
// returns. No per-day cap — every qualifying breakout gets an alert.
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

// VWAP pullback check — vwapAlerts come back as part of the same
// /api/options/intraday response used by the main scan (the route itself
// tracks "first pullback today" per symbol in KV), but sent on their own
// schedule/priority here rather than folded into runMarketScan's 5-alert
// cap, same as ORB gets its own dedicated checks.
async function runVwapCheck(slotLabel) {
  if (vwapCheckSlots.includes(slotLabel)) return;
  console.log(`Running VWAP pullback check (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/intraday`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.vwapAlerts ?? [];
    let sent = 0;
    for (const alert of alerts) {
      if (sentToday[alert.symbol]) continue;
      await sendTelegram(alert.message);
      sentToday[alert.symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      await logAlert(alert);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`VWAP check — ${alerts.length} found, ${sent} sent`);
    vwapCheckSlots.push(slotLabel);
  } catch(e) { console.error("VWAP check error:", e.message); }
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
    await sendTelegram(formatFuturesMessage(futures));
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

  // Pre-market watchlist: 8:20am ET (7:20am CT) — moved from 9:00am 2026-07-08
  // to give more lead time before the 9:30am open.
  if (total >= 500 && total < 510 && !premarketDone) {
    await runPremarketScan();
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

  // ORB range capture: 10:30am ET — records each watchlist symbol's
  // opening 60-minute candle high/low right as it closes.
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

  // VWAP pullback checks: 11:00am, 1:00pm, 2:00pm, 3:30pm ET
  if (total >= 660 && total < 670 && !vwapCheckSlots.includes("11:00")) {
    await runVwapCheck("11:00");
    return;
  }

  // Scored ORB breakout check: every 15 minutes, 10:30am-2:00pm ET —
  // replaces the old 11am/1pm/2pm orb/check windows entirely (2026-07-08).
  if (total >= 630 && total <= 840 && total % 15 === 0 && !orbBreakoutSlots.includes(String(total))) {
    await runOrbBreakoutCheck(String(total));
    return;
  }

  // Afternoon scan: 1:00pm ET — catches moves that develop after the
  // 10am window, which the old two-scan-a-day schedule always missed.
  if (total >= 780 && total < 810 && !marketScanSlots.includes("13:00")) {
    await runMarketScan("13:00");
    return;
  }

  if (total >= 780 && total < 790 && !vwapCheckSlots.includes("13:00")) {
    await runVwapCheck("13:00");
    return;
  }

  if (total >= 840 && total < 850 && !vwapCheckSlots.includes("14:00")) {
    await runVwapCheck("14:00");
    return;
  }

  // Late-afternoon scan: 3:30pm ET — last chance before the 4pm close.
  if (total >= 930 && total < 960 && !marketScanSlots.includes("15:30")) {
    await runMarketScan("15:30");
    return;
  }

  if (total >= 930 && total < 940 && !vwapCheckSlots.includes("15:30")) {
    await runVwapCheck("15:30");
    return;
  }

  const { hour: h, min: m } = getET();
  console.log(`[${h}:${String(m).padStart(2,"0")} ET] Waiting for next scan window...`);
}

console.log("FlexAI Stock Monitor v3");
console.log("Pre-market watchlist: 9:00am ET | Scans: 10:00am, 1:00pm, 3:30pm ET | Crypto: 10:00am/4:00pm ET | ORB: 10:30am capture, scored breakout check every 15min 10:30am-2:00pm | VWAP: 11am/1pm/2pm/3:30pm");
tick();
setInterval(tick, 5 * 60 * 1000);
