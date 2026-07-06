const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FLEXAI_URL = process.env.FLEXAI_URL || "https://www.flexaioptions.com";
const ADMIN_TOKEN = process.env.ADMIN_UNLOCK || "letmein123";
const fs = require("fs");
const COOLDOWN_FILE = "/tmp/flexai_cooldown.json";

let sentToday = {};
let lastDate = "";
let premarketDone = false;
let marketScanSlots = [];
let cryptoScanDone = false;
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
    cryptoScanDone = false;
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

async function runPremarketScan() {
  if (!isWeekday() || premarketDone) return;
  console.log("Running pre-market scan...");
  try {
    const data = await fetchAlerts();
    const awareness = [
      ...(data.momentumAlerts ?? []).slice(0, 3),
      ...(data.trendBreakAlerts ?? []).slice(0, 2),
    ];
    if (awareness.length > 0) {
      let msg = "FlexAI Pre-Market Awareness\n\nStocks to watch before the bell:\n\n";
      for (const a of awareness) {
        msg += `${a.symbol} $${a.price} — ${a.alertType.replace(/_/g," ")}\n`;
      }
      msg += "\nNot financial advice. Wait for market open before entering.";
      await sendTelegram(msg);
    } else {
      await sendTelegram("FlexAI Pre-Market: No early warnings — market looks clean heading into the open.");
    }
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
      ...(data.callIdeas ?? []).map((a) => ({ ...a, priority: 8 })),
      ...(data.stillTimeIdeas ?? []).map((a) => ({ ...a, priority: 9 })),
      ...(data.wheelIdeas ?? []).map((a) => ({ ...a, priority: 10 })),
      // Warning alerts
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "OVERSOLD_BOUNCE").map((a) => ({ ...a, priority: 11 })),
      ...(data.trendBreakAlerts ?? []).map((a) => ({ ...a, priority: 12 })),
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
// its own per-day cooldown/cap in KV; this just triggers it once a day.
async function runCryptoScan() {
  if (cryptoScanDone) return;
  console.log("Running crypto scan...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/crypto/movers/run?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log("Crypto scan — scanned:", data.scanned ?? 0, "alerts sent:", data.alertsSent ?? 0);
    cryptoScanDone = true;
  } catch(e) { console.error("Crypto scan error:", e.message); }
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
  const dayName = et.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
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
  if (total >= 630 && total < 660 && !cryptoScanDone) {
    await runCryptoScan();
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

  // Pre-market: 9:00am ET (8:00am CT)
  if (total >= 540 && total < 570 && !premarketDone) {
    await runPremarketScan();
    return;
  }

  // Main scan: 10:00am ET (9:00am CT) — after opening noise settles
  if (total >= 600 && total < 630 && !marketScanSlots.includes("10:00")) {
    await runMarketScan("10:00");
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

console.log("FlexAI Stock Monitor v3");
console.log("Pre-market: 9:00am ET | Scans: 10:00am, 1:00pm, 3:30pm ET | Crypto scan: 10:30am ET");
tick();
setInterval(tick, 5 * 60 * 1000);
