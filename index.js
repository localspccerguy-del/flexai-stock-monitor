const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FLEXAI_URL = process.env.FLEXAI_URL || "https://www.flexaioptions.com";
const fs = require("fs");
const COOLDOWN_FILE = "/tmp/flexai_cooldown.json";

let sentToday = {};
let lastDate = "";
let premarketDone = false;
let marketScanDone = false;
let lastScanDate = "";

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
    lastScanDate = today;
    saveCooldown();
    console.log("New trading day reset:", today);
  }
}

function getETHour() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return { hour: et.getHours(), min: et.getMinutes(), day: et.getDay() };
}

function isWeekday() {
  const { day } = getETHour();
  return day >= 1 && day <= 5;
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

async function runPremarketScan() {
  if (!isWeekday() || premarketDone) return;
  console.log("🌅 Running pre-market scan...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/ideas`, { headers: { "User-Agent": "FlexAI-Monitor/2.0" } });
    if (!r.ok) { console.log("API error:", r.status); return; }
    const data = await r.json();
    if (!data.ok) return;

    // Pre-market: send momentum shifts and trend breaks as awareness only
    const awareness = [
      ...(data.momentumAlerts ?? []).slice(0, 3),
      ...(data.trendBreakAlerts ?? []).slice(0, 2),
    ];

    if (awareness.length > 0) {
      let msg = "🌅 <b>FlexAI Pre-Market Awareness</b>\n\n";
      msg += "Stocks to watch before the bell:\n\n";
      for (const a of awareness) {
        msg += `• <b>${a.symbol}</b> $${a.price} — ${a.alertType.replace("_"," ")}\n`;
      }
      msg += "\n⚠️ Not financial advice. Wait for market open before entering.";
      await sendTelegram(msg);
    }

    premarketDone = true;
    console.log("✅ Pre-market scan complete");
  } catch(e) { console.error("Pre-market error:", e.message); }
}

async function runMarketScan() {
  if (!isWeekday() || marketScanDone) return;
  console.log("📊 Running main market scan...");
  checkReset();

  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/ideas`, { headers: { "User-Agent": "FlexAI-Monitor/2.0" } });
    if (!r.ok) { console.log("API error:", r.status); return; }
    const data = await r.json();
    if (!data.ok) return;

    // Main scan: all trade alerts in priority order
    const allAlerts = [
      ...(data.flagAlerts ?? []).filter((a) => a.alertType === "BULL_FLAG").map((a) => ({ ...a, priority: 1 })),
      ...(data.callIdeas ?? []).map((a) => ({ ...a, priority: 2 })),
      ...(data.stillTimeIdeas ?? []).map((a) => ({ ...a, priority: 3 })),
      ...(data.wheelIdeas ?? []).map((a) => ({ ...a, priority: 4 })),
      ...(data.flagAlerts ?? []).filter((a) => a.alertType === "BEAR_FLAG").map((a) => ({ ...a, priority: 5 })),
      ...(data.trendBreakAlerts ?? []).map((a) => ({ ...a, priority: 6 })),
    ].sort((a, b) => a.priority - b.priority);

    let sent = 0;
    const MAX = 5;

    for (const alert of allAlerts) {
      if (sent >= MAX) break;
      const symbol = alert.symbol;
      if (sentToday[symbol]) continue;
      if (!alert.message) continue;

      await sendTelegram(alert.message);
      sentToday[symbol] = { type: alert.alertType, time: Date.now() };
      saveCooldown();
      sent++;
      console.log(`✅ Sent ${alert.alertType} for ${symbol}`);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (sent === 0) {
      await sendTelegram("📊 <b>FlexAI Market Scan Complete</b>\n\nNo high-conviction setups found today. The system found setups that didn\'t meet all conditions — that\'s the filter working as designed.\n\n⚠️ Not financial advice");
    }

    console.log(`Scanned: ${data.scanned ?? 0}, Sent: ${sent}`);
    marketScanDone = true;
  } catch(e) { console.error("Market scan error:", e.message); }
}

async function tick() {
  if (!isWeekday()) { console.log("Weekend — resting"); return; }
  checkReset();

  const { hour, min } = getETHour();
  const total = hour * 60 + min;

  // Pre-market scan: 9:00am ET (8:00am CT)
  if (total >= 540 && total < 570 && !premarketDone) {
    await runPremarketScan();
    return;
  }

  // Main market scan: 10:00am ET (9:00am CT) — after opening noise settles
  if (total >= 600 && total < 630 && !marketScanDone) {
    await runMarketScan();
    return;
  }

  console.log(`[${hour}:${String(min).padStart(2,"0")} ET] Waiting for next scan window...`);
}

console.log("FlexAI Stock Monitor v3 starting...");
console.log("Pre-market scan: 9:00am ET | Main scan: 10:00am ET");
tick();
setInterval(tick, 5 * 60 * 1000); // check every 5 minutes
