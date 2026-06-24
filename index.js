const fs = require("fs");

const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COOLDOWN_FILE = "/tmp/flexai_stock_cooldown.json";

// Per-stock cooldown — same stock max once per day
let sentToday = {};
let lastCooldownDate = "";
try {
  const saved = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
  sentToday = saved.sentToday ?? {};
  lastCooldownDate = saved.date ?? "";
  console.log("Loaded cooldown state:", Object.keys(sentToday).length, "stocks alerted");
} catch(e) { console.log("Starting fresh cooldown"); }

function saveCooldown() {
  try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ date: lastCooldownDate, sentToday })); } catch(e) {}
}

// Reset cooldown at start of each new trading day
function checkResetCooldown() {
  const today = new Date().toISOString().split("T")[0];
  if (today !== lastCooldownDate) {
    sentToday = {};
    lastCooldownDate = today;
    saveCooldown();
    console.log("Cooldown reset for new trading day:", today);
  }
}

// ── MARKET HOURS CHECK
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
  return total >= 570 && total < 960; // 9:30 AM - 4:00 PM ET
}

// ── TELEGRAM
async function sendTelegram(msg) {
  try {
    const fetch = require("node-fetch");
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML" })
    });
  } catch(e) { console.error("Telegram error:", e.message); }
}

// ── FETCH HELPERS
async function fetchJSON(url) {
  const fetch = require("node-fetch");
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  return r.json();
}

async function getDailyBars(symbol) {
  try {
    const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const bars = (result.timestamp ?? []).map((t, i) => ({
      t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i]
    })).filter(b => b.c != null);
    return bars.length >= 50 ? bars : null;
  } catch(e) { return null; }
}

async function getWeeklyBars(symbol) {
  try {
    const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1wk&range=2y`);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const bars = (result.timestamp ?? []).map((t, i) => ({
      t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i]
    })).filter(b => b.c != null);
    return bars.length >= 10 ? bars : null;
  } catch(e) { return null; }
}

async function getLivePrice(symbol) {
  try {
    const data = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`);
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch(e) { return null; }
}

// ── CALCULATIONS
function calcEMA(bars, period) {
  const closes = bars.map(b => b.c);
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcSMA(bars, period) {
  const closes = bars.map(b => b.c);
  if (closes.length < period) return closes[closes.length - 1];
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(bars, period = 14) {
  const closes = bars.map(b => b.c);
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(-(period + 1)).slice(1).map((c, i) => c - closes.slice(-(period + 1))[i]);
  const gains = changes.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = changes.filter(c => c < 0).map(Math.abs).reduce((a, b) => a + b, 0) / period;
  return losses === 0 ? 100 : Math.round(100 - 100 / (1 + gains / losses));
}

function calcVolumeSurge(bars) {
  const vols = bars.map(b => b.v).filter(v => v > 0);
  if (vols.length < 21) return 1;
  const avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? Math.round((vols[vols.length - 1] / avg) * 10) / 10 : 1;
}

function findKeyLevels(bars, currentPrice) {
  const lookback = bars.slice(-60);
  const rawLevels = [];
  for (let i = 3; i < lookback.length - 3; i++) {
    const bar = lookback[i];
    const isSwingHigh = [1,2,3].every(d => bar.h >= lookback[i-d].h && bar.h >= lookback[i+d].h);
    if (isSwingHigh) {
      const tol = bar.h * 0.02;
      const touches = lookback.filter(b => Math.abs(b.h - bar.h) < tol || Math.abs(b.l - bar.h) < tol).length;
      if (touches >= 2) rawLevels.push({ price: Math.round(bar.h * 100) / 100, touches, type: bar.h > currentPrice ? "resistance" : "support" });
    }
    const isSwingLow = [1,2,3].every(d => bar.l <= lookback[i-d].l && bar.l <= lookback[i+d].l);
    if (isSwingLow) {
      const tol = bar.l * 0.02;
      const touches = lookback.filter(b => Math.abs(b.l - bar.l) < tol || Math.abs(b.h - bar.l) < tol).length;
      if (touches >= 2) rawLevels.push({ price: Math.round(bar.l * 100) / 100, touches, type: bar.l < currentPrice ? "support" : "resistance" });
    }
  }
  const deduped = [];
  for (const level of rawLevels) {
    const existing = deduped.find(d => Math.abs(d.price - level.price) / level.price < 0.02);
    if (existing) { if (level.touches > existing.touches) { existing.price = level.price; existing.touches = level.touches; } }
    else deduped.push({ ...level });
  }
  // Only return levels within 25% of current price — ignore ancient irrelevant levels
  const nearby = deduped.filter(l => Math.abs(l.price - currentPrice) / currentPrice < 0.25);
  return {
    supports: nearby.filter(l => l.type === "support").sort((a, b) => b.price - a.price),
    resistances: nearby.filter(l => l.type === "resistance").sort((a, b) => a.price - b.price)
  };
}

// ── OPTIONS CALCULATOR — Black-Scholes delta + historical volatility
function getOptionsRecommendation(bars, price, isCall, tradeType) {
  try {
    const closes = bars.map(b => b.c).filter(c => c > 0);
    if (closes.length < 31) return null;

    // 30-day historical volatility annualized
    const returns = [];
    for (let i = closes.length - 30; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i-1]));
    }
    const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
    const variance = returns.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / (returns.length-1);
    const hv = Math.sqrt(variance * 252);

    // Black-Scholes delta
    const T = tradeType === "LEAP" ? 270/365 : 90/365;
    const r = 0.05;

    function normCDF(x) {
      const t = 1 / (1 + 0.2316419 * Math.abs(x));
      const d = 0.3989423 * Math.exp(-x*x/2);
      const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
      return x >= 0 ? 1 - p : p;
    }

    function bsDelta(S, K) {
      if (hv <= 0 || T <= 0) return 0;
      const d1 = (Math.log(S/K) + (r + 0.5*hv*hv)*T) / (hv*Math.sqrt(T));
      return isCall ? normCDF(d1) : normCDF(d1) - 1;
    }

    // Find strike closest to 55-60 delta
    const targetDelta = isCall ? 0.575 : -0.575;
    let bestStrike = price;
    let bestDelta = 0;
    let bestDiff = 999;

    for (let kPct = 70; kPct <= 130; kPct++) {
      const K = Math.round(price * kPct / 100);
      const d = bsDelta(price, K);
      const diff = Math.abs(Math.abs(d) - Math.abs(targetDelta));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestStrike = K;
        bestDelta = d;
      }
    }

    const ivPct = Math.round(hv * 100);
    let ivLabel = "✅ Normal";
    let ivWarning = "";
    if (ivPct > 75) {
      ivLabel = "🚨 Very High";
      ivWarning = "Options expensive — consider waiting for IV to drop";
    } else if (ivPct > 50) {
      ivLabel = "⚠️ Elevated";
      ivWarning = "Options slightly expensive";
    }

    const expDate = new Date(Date.now() + T * 365 * 24*60*60*1000);
    const expiry = expDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });

    return {
      strike: bestStrike,
      delta: Math.round(Math.abs(bestDelta) * 100) / 100,
      iv: ivPct,
      ivLabel,
      ivWarning,
      expiry,
      type: isCall ? "CALL" : "PUT",
    };
  } catch(e) {
    return null;
  }
}

// ── DETECT SETUPS
function analyzeSetups(bars, weeklyBars, symbol, price) {
  if (price < 2) return [];
  const results = [];
  const ema10 = calcEMA(bars, 10);
  const ema20 = calcEMA(bars, 20);
  const sma50 = calcSMA(bars, 50);
  const sma200 = calcSMA(bars, 200);
  const sma200Earlier = calcSMA(bars.slice(0, -22), 200);
  const rsi = calcRSI(bars);
  const volumeSurge = calcVolumeSurge(bars);
  const { supports, resistances } = findKeyLevels(weeklyBars, price);

  // ── GLOBAL QUALITY GATE — runs before ANY alert fires
  const aboveSMA200 = price > sma200;
  const priceMovingUp = bars.length >= 3 && price > bars[bars.length - 3].c;
  const extremeOversold = rsi < 25;  // Potential reversal UP
  const extremeOverbought = rsi > 75; // Potential reversal DOWN
  const belowAllEMAs = price < ema10 && price < ema20;
  const stillFalling = !priceMovingUp && belowAllEMAs && !extremeOversold;

  if (aboveSMA200) {
    // Above 200 SMA — skip only if RSI in dead zone or falling hard with no volume
    if (rsi < 30 && !extremeOversold) {
      console.log(`${symbol} — skipped (above 200 SMA, RSI ${rsi} too weak)`);
      return [];
    }
    if (stillFalling && volumeSurge < 1.2) {
      console.log(`${symbol} — skipped (above 200 SMA, falling with no volume)`);
      return [];
    }
  } else {
    // Below 200 SMA — skip only if still clearly falling with no reversal signs
    if (stillFalling && !extremeOversold) {
      console.log(`${symbol} — skipped (below 200 SMA, below all EMAs, still falling)`);
      return [];
    }
    // RSI 65-75 below 200 SMA = already ran too far, skip
    if (rsi > 65 && rsi <= 75) {
      console.log(`${symbol} — skipped (below 200 SMA, RSI ${rsi} already overbought for sub-trend)`);
      return [];
    }
  }

  // ── REVERSAL ALERT — extreme oversold or overbought at key S/R level
  if (extremeOversold && supports[0] && Math.abs(price - supports[0].price) / price < 0.05) {
    const fmt = n => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);
    const r1 = resistances[0]?.price;
    const r2 = resistances[1]?.price;
    const s1 = supports[0]?.price;
    const s2 = supports[1]?.price;
    const opts = getOptionsRecommendation(bars, price, true, "SWING");
    results.push({
      alertType: "REVERSAL_UP",
      symbol, price,
      msg: [
        `🔄 <b>${symbol} — Extreme Oversold at Support</b>`,
        ``,
        `RSI: ${rsi} — Extreme oversold ⚠️`,
        `At support: $${fmt(s1)} — tested ${supports[0].touches}x`,
        `Potential bounce — watch for confirmation`,
        ``,
        r1 ? `R1: $${fmt(r1)}` : "",
        r2 ? `R2: $${fmt(r2)}` : "",
        ``,
        s1 ? `S1: $${fmt(s1)} ← YOU ARE HERE` : "",
        s2 ? `S2: $${fmt(s2)}` : "",
        ``,
        `Wait for green candle confirmation before entering`,
        opts ? `📲 ${opts.type} exp ${opts.expiry}` : "",
        opts ? `Strike: $${opts.strike} (delta ${opts.delta})` : "",
        opts ? `IV: ${opts.iv}% ${opts.ivLabel}` : "",
        ``,
        `⚠️ Not financial advice`,
      ].filter(l => l !== "").join("\n")
    });
    return results;
  }

  if (extremeOverbought && resistances[0] && Math.abs(price - resistances[0].price) / price < 0.05) {
    const fmt = n => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);
    const r1 = resistances[0]?.price;
    const r2 = resistances[1]?.price;
    const s1 = supports[0]?.price;
    const s2 = supports[1]?.price;
    const opts = getOptionsRecommendation(bars, price, false, "SWING");
    results.push({
      alertType: "REVERSAL_DOWN",
      symbol, price,
      msg: [
        `🔄 <b>${symbol} — Extreme Overbought at Resistance</b>`,
        ``,
        `RSI: ${rsi} — Extreme overbought ⚠️`,
        `At resistance: $${fmt(r1)} — tested ${resistances[0].touches}x`,
        `Potential reversal down — watch for confirmation`,
        ``,
        r1 ? `R1: $${fmt(r1)} ← YOU ARE HERE` : "",
        r2 ? `R2: $${fmt(r2)}` : "",
        ``,
        s1 ? `S1: $${fmt(s1)}` : "",
        s2 ? `S2: $${fmt(s2)}` : "",
        ``,
        `Wait for red candle confirmation before entering`,
        opts ? `📲 ${opts.type} exp ${opts.expiry}` : "",
        opts ? `Strike: $${opts.strike} (delta ${opts.delta})` : "",
        opts ? `IV: ${opts.iv}% ${opts.ivLabel}` : "",
        ``,
        `⚠️ Not financial advice`,
      ].filter(l => l !== "").join("\n")
    });
    return results;
  }

  const fmt = n => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);

  // 1. CALL/PUT confluence — trend-confirmed above 200 SMA
  const stage2 = price > sma200 && price > sma50 && sma200 > sma200Earlier;
  const greenLight = price > ema10;
  const bouncingEMA = [ema10, ema20, sma50].some(e => Math.abs(price - e) / price < 0.04);
  const nearestSR = [...supports, ...resistances].find(l => Math.abs(l.price - price) / price < 0.05);
  if (stage2 && greenLight && bouncingEMA && nearestSR && rsi > 40 && rsi < 70 && volumeSurge >= 0.8) {
    const r1 = resistances[0]?.price;
    const s1 = supports[0]?.price;

    const entryLabel = Math.abs(price - ema10)/price < 0.04 ? "⚡ MOMENTUM ENTRY — holding above 10 EMA" :
                       Math.abs(price - ema20)/price < 0.04 ? "📈 SWING ENTRY — bouncing off 20 EMA" :
                       Math.abs(price - sma50)/price < 0.04 ? "📊 LONG-TERM ENTRY — bouncing off 50 SMA" : "📈 SWING ENTRY";
    const tradeTypeLabel = Math.abs(price - sma50)/price < 0.04 ? "LEAP" : "SWING";
    const opts = getOptionsRecommendation(bars, price, true, tradeTypeLabel);

    results.push({
      alertType: "CONFLUENCE",
      symbol, price, rsi, volumeSurge,
      msg: [
        `🚀 <b>${symbol} — Uptrend Confirmed</b>`,
        ``,
        `✅ Above 200 SMA — confirmed uptrend`,
        `${entryLabel}`,
        ``,
        r1 ? `R1: $${fmt(r1)}` : "",
        resistances[1] ? `R2: $${fmt(resistances[1].price)}` : "",
        ``,
        s1 ? `S1: $${fmt(s1)}` : "",
        supports[1] ? `S2: $${fmt(supports[1].price)}` : "",
        ``,
        `✅ ${[stage2, bouncingEMA, nearestSR, volumeSurge >= 1.2, rsi > 45].filter(Boolean).length} signals confirmed`,
        opts ? `📲 ${opts.type} exp ${opts.expiry}` : `📲 CALL exp soon`,
        opts ? `Strike: $${opts.strike} (delta ${opts.delta})` : `Strike: 55-60 delta`,
        opts ? `IV: ${opts.iv}% ${opts.ivLabel}` : "",
        opts?.ivWarning ? `⚠️ ${opts.ivWarning}` : "",
        ``,
        `⚠️ Not financial advice`,
      ].filter(l => l !== "").join("\n")
    });
  }

  // 2. 200 SMA cross — ONLY fires after 4 PM ET using confirmed daily closes
  // Never uses live intraday price — compares last two confirmed daily candles only
  const etNow = new Date(new Date().toLocaleString("en-US", {timeZone: "America/New_York"}));
  const etHour = etNow.getHours();
  const afterClose = etHour >= 16;
  if (bars.length >= 202 && afterClose) {
    const lastClose = bars[bars.length - 1].c;
    const prevClose2 = bars[bars.length - 2].c;
    const sma200Today = calcSMA(bars, 200);
    const sma200Prev = calcSMA(bars.slice(0, -1), 200);
    const crossedUp = prevClose2 <= sma200Prev && lastClose > sma200Today;
    const crossedDown = prevClose2 >= sma200Prev && lastClose < sma200Today;
    if (crossedUp || crossedDown) {
      results.push({
        alertType: "CROSS",
        symbol, price,
        msg: [
          `${crossedUp ? "🟢" : "🔴"} <b>${symbol} — 200 SMA Cross</b>`,
          ``,
          `${crossedUp ? "Just crossed ABOVE its 200 SMA ✅" : "Just crossed BELOW its 200 SMA ⚠️"}`,
          `200 SMA: $${fmt(sma200)}`,
          ``,
          `📍 Regime change — worth watching`,
          `⚠️ Not financial advice`,
        ].join("\n")
      });
    }
  }

  // 3. Sub-trend continuation — below 200 SMA but bouncing off support + 10/20 EMA
  if (price < sma200 && price > ema10 && price > ema20) {
    const ema10Earlier = calcEMA(bars.slice(0, -5), 10);
    const ema20Earlier = calcEMA(bars.slice(0, -5), 20);
    const shortTermUp = ema10 > ema10Earlier && ema20 > ema20Earlier;
    const bouncingEMA2 = Math.abs(price - ema10) / price < 0.03 || Math.abs(price - ema20) / price < 0.04;
    const supportConfluence = supports[0] && Math.abs(price - supports[0].price) / price < 0.05 && supports[0].touches >= 2;
    if (shortTermUp && bouncingEMA2 && supportConfluence && rsi > 35 && rsi < 65 && volumeSurge >= 0.8) {
      const target = resistances[0]?.price ?? Math.round(price * 1.15 * 100) / 100;
      const stop = Math.round(supports[0].price * 0.97 * 100) / 100;
      const subOpts = getOptionsRecommendation(bars, price, true, "SWING");
      results.push({
        alertType: "SUBTREND",
        symbol, price,
        msg: [
          `🔵 <b>${symbol} — Short-Term Bounce</b>`,
          ``,
          `⚠️ Below 200 SMA — NOT a trend reversal`,
          `Short-term bounce off historical support`,
          ``,
          `Support: $${fmt(supports[0].price)} — tested ${supports[0].touches}x`,
          `Target: $${fmt(target)}`,
          `Stop: $${fmt(stop)}`,
          `RSI: ${rsi} | Volume: ${volumeSurge}x`,
          ``,
          subOpts ? `📲 ${subOpts.type} exp ${subOpts.expiry}` : `📲 CALL — tight expiry`,
          subOpts ? `Strike: $${subOpts.strike} (delta ${subOpts.delta})` : "",
          subOpts ? `IV: ${subOpts.iv}% ${subOpts.ivLabel}` : "",
          subOpts?.ivWarning ? `⚠️ ${subOpts.ivWarning}` : "",
          ``,
          `⚠️ Not financial advice`,
        ].filter(l => l !== "").join("\n")
      });
    }
  }

  // 4. Sub-trend resistance watch
  // MACD for resistance watch check
  const closes4Watch = bars.map(b => b.c);
  const calcMACD4Watch = (v) => {
    const ema = (vals, p) => { const k=2/(p+1); let e=vals.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<vals.length;i++) e=vals[i]*k+e*(1-k); return e; };
    const m = ema(v,12) - ema(v,26);
    const sig = ema(v.slice(-35).map((_,i,arr) => ema(arr.slice(0,i+1),12) - ema(arr.slice(0,i+1),26)).slice(-9),9);
    return { macdLine: m, histogram: m - sig };
  };
  const macd4Watch = calcMACD4Watch(closes4Watch);
  const rsi4Watch = calcRSI(bars);
  // Only fire resistance watch if MACD is not deeply negative and RSI is not falling hard
  const watchConditionsOk = macd4Watch.macdLine > -0.5 * Math.abs(price * 0.01) && rsi4Watch > 40;
  if (price < sma200 && resistances[0] && Math.abs(price - resistances[0].price) / price < 0.03 && resistances[0].touches >= 2 && watchConditionsOk) {
    results.push({
      alertType: "SUBTREND_WATCH",
      symbol, price,
      msg: [
        `👀 <b>${symbol} — At Key Resistance</b>`,
        ``,
        `Resistance: $${fmt(resistances[0].price)} — tested ${resistances[0].touches}x`,
        `Still below 200 SMA — watch for breakout or rejection`,
        `⚠️ Not financial advice`,
      ].join("\n")
    });
  }

  return results;
}

// ── WATCHLIST
const WATCHLIST = [
  "AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","AMD","PLTR","COIN",
  "SMCI","IONQ","RGTI","SKYT","ICCM","CRWV","WULF","POET","EOSE","RIOT",
  "MRVL","INTC","MU","ARM","NOW","SNOW","CRML","ZETA","GSAT","RDW",
  "ASTS","RKLB","LUNR","JOBY","ACHR","HOOD","SOFI","UPST","AFRM","NU",
  "MSTR","CLSK","CIFR","BTBT","HUT","HIVE","MARA","RIOT","CORZ","WULF",
  "SOUN","BBAI","RNXT","BTAI","APGE","IOVA","FATE","BEAM","CRSP","EDIT",
  "SQ","PYPL","SHOP","TTD","DDOG","NET","MNDY","GTLB","BILL","ZS",
  "ONDO","HBAR","LINK","AVAX","DOT","ADA","UNI","AAVE","LDO","FIL",
];

// ── MAIN SCAN LOOP
async function scanStocks() {
  if (!isMarketOpen()) {
    console.log("Market closed — skipping scan");
    return;
  }
  checkResetCooldown();
  console.log(`\n[${new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York"})} ET] Scanning ${WATCHLIST.length} stocks...`);

  let scanned = 0;
  let alerted = 0;
  const MAX_ALERTS_PER_SCAN = 3;

  for (const symbol of WATCHLIST) {
    if (alerted >= MAX_ALERTS_PER_SCAN) { break; }
    if (sentToday[symbol]) { continue; }
    try {
      const [bars, weeklyBars, livePrice] = await Promise.all([
        getDailyBars(symbol),
        getWeeklyBars(symbol),
        getLivePrice(symbol),
      ]);
      if (!bars || !weeklyBars || !livePrice) continue;
      scanned++;

      const setups = analyzeSetups(bars, weeklyBars, symbol, livePrice);
      for (const setup of setups) {
        console.log(`✅ ${setup.alertType} — ${symbol} @ $${livePrice}`);
        await sendTelegram(setup.msg);
        sentToday[symbol] = { alertType: setup.alertType, time: Date.now() };
        saveCooldown();
        alerted++;
        await new Promise(r => setTimeout(r, 1000));
        break; // one alert per stock per scan
      }
      if (!setups.length) console.log(`— ${symbol} @ $${livePrice} — no setup`);
    } catch(e) {
      console.error(`Error scanning ${symbol}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Scan complete — scanned: ${scanned}, alerted: ${alerted}`);
}

// ── RUN EVERY 15 MINUTES
console.log("FlexAI Stock Monitor starting...");
scanStocks(); // run immediately on startup
setInterval(scanStocks, 15 * 60 * 1000); // then every 15 minutes
