const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FLEXAI_URL = process.env.FLEXAI_URL || "https://www.flexaioptions.com";
const ADMIN_TOKEN = process.env.ADMIN_UNLOCK || "letmein123";
const fs = require("fs");
const COOLDOWN_FILE = "/tmp/flexai_cooldown.json";

let sentToday = {};
let lastDate = "";
let premarketDone = false;
let marketScanDone = false;
let cryptoScanDone = false;

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
    marketScanDone = false;
    cryptoScanDone = false;
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

async function runMarketScan() {
  if (!isWeekday() || marketScanDone) return;
  console.log("Running main market scan...");
  checkReset();
  try {
    const data = await fetchAlerts();
    const allAlerts = [
      // Intraday alerts — highest priority, most time-sensitive
      ...(data.flagAlerts1H ?? []).map((a) => ({ ...a, priority: 1 })),
      ...(data.swingCalls ?? []).map((a) => ({ ...a, priority: 2 })),
      ...(data.intradayMoves ?? []).filter(a => a.alertType === "INTRADAY_STILL_TIME").map((a) => ({ ...a, priority: 3 })),
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "CHEAPER_LEAP").map((a) => ({ ...a, priority: 4 })),
      ...(data.intradayMoves ?? []).filter(a => a.alertType === "INTRADAY_BREAKDOWN").map((a) => ({ ...a, priority: 5 })),
      // Daily alerts — LEAP, Wheel, Still Time, flags
      ...(data.flagAlerts ?? []).filter((a) => a.alertType === "BULL_FLAG").map((a) => ({ ...a, priority: 6 })),
      ...(data.callIdeas ?? []).map((a) => ({ ...a, priority: 7 })),
      ...(data.stillTimeIdeas ?? []).map((a) => ({ ...a, priority: 8 })),
      ...(data.wheelIdeas ?? []).map((a) => ({ ...a, priority: 9 })),
      // Warning alerts
      ...(data.oversoldAlerts ?? []).filter(a => a.alertType === "OVERSOLD_BOUNCE").map((a) => ({ ...a, priority: 10 })),
      ...(data.trendBreakAlerts ?? []).map((a) => ({ ...a, priority: 11 })),
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
    marketScanDone = true;
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

async function tick() {
  checkReset();
  const { hour, min } = getET();
  const total = hour * 60 + min;

  // Crypto trades 24/7 — this must run independent of the stock-market
  // weekday/holiday gate below, or it silently never fires on weekends.
  if (total >= 630 && total < 660 && !cryptoScanDone) {
    await runCryptoScan();
  }

  if (isMarketHoliday()) { console.log("Market holiday — stock scans resting"); return; }
  if (!isWeekday()) { console.log("Weekend — stock scans resting"); return; }

  // Pre-market: 9:00am ET (8:00am CT)
  if (total >= 540 && total < 570 && !premarketDone) {
    await runPremarketScan();
    return;
  }

  // Main scan: 10:00am ET (9:00am CT) — after opening noise settles
  if (total >= 600 && total < 630 && !marketScanDone) {
    await runMarketScan();
    return;
  }

  const { hour: h, min: m } = getET();
  console.log(`[${h}:${String(m).padStart(2,"0")} ET] Waiting for next scan window...`);
}

console.log("FlexAI Stock Monitor v3");
console.log("Pre-market: 9:00am ET | Main scan: 10:00am ET | Crypto scan: 10:30am ET");
tick();
setInterval(tick, 5 * 60 * 1000);
