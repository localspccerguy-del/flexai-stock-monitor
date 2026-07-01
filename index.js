const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FLEXAI_URL = process.env.FLEXAI_URL || "https://www.flexaioptions.com";
const fs = require("fs");
const COOLDOWN_FILE = "/tmp/flexai_cooldown.json";

let sentToday = {};
let lastDate = "";

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
    saveCooldown();
    console.log("Cooldown reset for", today);
  }
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const hour = et.getHours();
  const min = et.getMinutes();
  const month = et.getMonth() + 1;
  const date = et.getDate();
  const holidays = ["1-1","1-19","2-16","4-3","5-25","6-19","7-4","9-7","11-26","12-25"];
  if (day === 0 || day === 6) return false;
  if (holidays.includes(`${month}-${date}`)) return false;
  const total = hour * 60 + min;
  return total >= 570 && total < 960;
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

async function runScan() {
  if (!isMarketOpen()) {
    console.log("Market closed — skipping");
    return;
  }
  checkReset();
  console.log(`[${new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York"})} ET] Checking FlexAI for alerts...`);

  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/ideas`, { headers: { "User-Agent": "FlexAI-Monitor/2.0" } });
    if (!r.ok) { console.log("API returned", r.status); return; }
    const data = await r.json();
    if (!data.ok) { console.log("API error:", data.error); return; }

    const allAlerts = [
      ...(data.callIdeas ?? []).map((a) => ({ ...a, priority: 1 })),
      ...(data.stillTimeIdeas ?? []).map((a) => ({ ...a, priority: 2 })),
      ...(data.wheelIdeas ?? []).map((a) => ({ ...a, priority: 3 })),
      ...(data.momentumAlerts ?? []).map((a) => ({ ...a, priority: 4 })),
      ...(data.trendBreakAlerts ?? []).map((a) => ({ ...a, priority: 5 })),
      ...(data.flagAlerts ?? []).map((a) => ({ ...a, priority: 2 })),
    ].sort((a, b) => a.priority - b.priority);

    let sent = 0;
    const MAX = 3;

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

    if (sent === 0) console.log("No new alerts to send");
    console.log(`Scanned: ${data.scanned ?? 0}, Sent: ${sent}`);

  } catch(e) {
    console.error("Scan error:", e.message);
  }
}

console.log("FlexAI Stock Monitor v2 starting...");
runScan();
setInterval(runScan, 15 * 60 * 1000);
