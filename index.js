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
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!KV_URL || !KV_TOKEN) {
  console.error("WARNING: KV_REST_API_URL/KV_REST_API_TOKEN not set on Render — weekend futures dedup (futures:last_sent) will be skipped, every scheduled slot will send unconditionally.");
}

// 2026-07-18 — fresh v2 system (SCANNER AGENT + MASTER AGENT), everything
// self-contained in this file, no Mac launchd, no Vercel crons. Calls
// Alpaca/Yahoo/FMP/Finnhub/Anthropic directly rather than proxying through
// a flexai-saas route (unlike everything above this point in the file).
// Render's actual env var names for Alpaca are ALPACA_API_KEY and
// ALPACA_SECRET_KEY — confirmed via the Render API 2026-07-18, NOT
// ALPACA_API_SECRET (flexai-saas's naming convention) — do not "fix" this
// to match flexai-saas, it would break against what's actually set here.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const ALPACA_KEY_ID = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
if (!ANTHROPIC_API_KEY) console.error("WARNING: ANTHROPIC_API_KEY not set on Render — v2 SCANNER AGENT's pre-market scan (Claude-driven) will fail every run.");
if (!FMP_API_KEY) console.error("WARNING: FMP_API_KEY not set on Render — v2 earnings-calendar and FMP news checks will report unavailable, not crash.");
if (!FINNHUB_API_KEY) console.error("WARNING: FINNHUB_API_KEY not set on Render — v2 Finnhub news checks will report unavailable, not crash.");
if (!ALPACA_KEY_ID || !ALPACA_SECRET) console.error("WARNING: ALPACA_API_KEY/ALPACA_SECRET_KEY not set on Render — v2 ORB/200EMA/Master price checks will fail every run.");
const fs = require("fs");
const COOLDOWN_FILE = "/tmp/flexai_cooldown.json";

// Direct Upstash REST access — same pattern the monitoring agents use via curl.
// The worker otherwise never talks to KV directly (it calls flexai-saas routes
// instead), but routing this through a new API route just to dedup one message
// type would be more moving parts than a couple of REST calls.
//
// 2026-07-13 — live testing found futures:last_sent staying null across
// multiple weekend checks even after KV_REST_API_URL/TOKEN were confirmed
// added to Render's dashboard. Root cause: the original kvGet/kvSet never
// checked the HTTP response status — a fetch() call doesn't throw on a
// non-2xx response, only on a network-level failure, so an Upstash auth
// error (401, e.g. from a mistyped/truncated token) would silently look
// IDENTICAL to "key doesn't exist yet" (both return null with no error
// logged). Both now return {ok, value/error} so a failure is distinguishable
// from a genuinely-missing key, and there's a boot-time self-test below that
// surfaces this via admin Telegram instead of requiring Render log access.
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, value: null, error: "KV_REST_API_URL/KV_REST_API_TOKEN not set" };
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const text = await r.text();
    if (!r.ok) { console.error(`kvGet ${key} failed: HTTP ${r.status} ${text}`); return { ok: false, value: null, error: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
    let d;
    try { d = JSON.parse(text); } catch { return { ok: false, value: null, error: "non-JSON response from KV" }; }
    const value = d?.result != null ? JSON.parse(d.result) : null;
    return { ok: true, value, error: null };
  } catch (e) { console.error("kvGet error:", e.message); return { ok: false, value: null, error: e.message }; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, error: "KV_REST_API_URL/KV_REST_API_TOKEN not set" };
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${KV_URL}/set/${key}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    const text = await r.text();
    if (!r.ok) { console.error(`kvSet ${key} failed: HTTP ${r.status} ${text}`); return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
    return { ok: true, error: null };
  } catch (e) { console.error("kvSet error:", e.message); return { ok: false, error: e.message }; }
}

// 2026-07-19 — atomic "set if not exists" for the v2 ORB race-condition
// fix (FIX 8). Upstash's REST SET command accepts an NX query param —
// returns {"result":"OK"} if the key didn't exist and got set (we won the
// lock), {"result":null} if it already existed (someone else already
// claimed it). This is what makes it safe against two overlapping tick()
// runs both reaching the same symbol — plain kvGet-then-kvSet has a gap
// between the check and the write that two concurrent calls can both pass.
// 2026-07-20 — added an optional ttlSeconds param (combined ?NX&EX=<n>,
// verified live against Upstash: sets a real expiring key, second SET on
// the same key still correctly blocked while the TTL is live) for
// CRITICAL FIX 1 — a short-lived lock that expires on its own if the
// caller never confirms success, rather than a permanent claim.
async function kvSetNX(key, value, ttlSeconds) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, acquired: false, error: "KV_REST_API_URL/KV_REST_API_TOKEN not set" };
  try {
    const fetch = (await import("node-fetch")).default;
    const qs = ttlSeconds ? `?NX&EX=${ttlSeconds}` : `?NX`;
    const r = await fetch(`${KV_URL}/set/${key}${qs}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    const text = await r.text();
    if (!r.ok) { console.error(`kvSetNX ${key} failed: HTTP ${r.status} ${text}`); return { ok: false, acquired: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
    let d;
    try { d = JSON.parse(text); } catch { return { ok: false, acquired: false, error: "non-JSON response from KV" }; }
    return { ok: true, acquired: d.result === "OK", error: null };
  } catch (e) { console.error("kvSetNX error:", e.message); return { ok: false, acquired: false, error: e.message }; }
}

// One-time boot self-test — the only way to know KV actually works from
// Render's real runtime without dashboard/log access. Sends an admin
// Telegram alert on failure so this doesn't need Render logs to diagnose.
async function kvSelfTest() {
  if (!KV_URL || !KV_TOKEN) return; // already warned above
  const testKey = "worker:kv_selftest";
  const setResult = await kvSet(testKey, { bootedAt: new Date().toISOString() });
  const getResult = setResult.ok ? await kvGet(testKey) : { ok: false, error: "skipped (set failed)" };
  if (!setResult.ok || !getResult.ok) {
    console.error("KV self-test FAILED at boot:", { setResult, getResult });
    if (TELEGRAM_BOT && ADMIN_CHAT_ID) {
      try {
        const fetch = (await import("node-fetch")).default;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `🚨 KV self-test failed at worker boot — futures dedup (and anything else depending on direct KV access) will silently no-op.\nSET: ${setResult.ok ? "ok" : setResult.error}\nGET: ${getResult.ok ? "ok" : getResult.error}\nCheck KV_REST_API_URL / KV_REST_API_TOKEN in Render's dashboard for typos, truncation, or stray whitespace.`,
          }),
        });
      } catch (e) { console.error("Failed to send KV self-test alert:", e.message); }
    }
  } else {
    console.log("KV self-test passed at boot.");
  }
}
kvSelfTest();

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
let lastEconReleaseCheckTotal = null;
let lastBtcMomentumCheckTotal = null;
let earningsReactionCheckDone = false;
let v2ScannerDone = false;
let v2Ema200Done = false;
let lastNewsWatcherV2Total = null;
let v2MasterSlots = [];

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
    lastEconReleaseCheckTotal = null;
    lastBtcMomentumCheckTotal = null;
    earningsReactionCheckDone = false;
    v2ScannerDone = false;
    v2Ema200Done = false;
    lastNewsWatcherV2Total = null;
    v2MasterSlots = [];
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
// 2026-07-20 — now returns true/false (was void). Every pre-existing
// call site does `await sendTelegram(...)` without using the return
// value, so this is backward-compatible — added because v2 ORB's
// CRITICAL FIX 1 needs to know whether the send actually succeeded
// before writing a permanent "alerted" key.
// ADDITIONAL FIX 3 (2026-07-21) — also checks Telegram's own {ok: true}
// response body, not just HTTP status. Verified live: a genuine
// Telegram-level failure (bad chat_id) returned HTTP 400 with
// {"ok":false,"error_code":400,"description":"Bad Request: chat not
// found"} — already caught by the existing r.ok check for that specific
// case, but Telegram's API can return 2xx with ok:false for other error
// classes, which the old code would have silently treated as success.
async function sendTelegram(msg, destination = "subscribers") {
  const chatId = destination === "admin" ? ADMIN_CHAT_ID : CHAT_ID;
  if (!chatId) {
    console.error(`Telegram error: no chat ID configured for destination "${destination}" — message not sent.`);
    return false;
  }
  try {
    const fetch = (await import("node-fetch")).default;
    // ADDITIONAL FIX 3 (2026-07-21) — parse_mode: "HTML" removed. None of
    // this project's messages are actually built as HTML; a headline or
    // symbol containing a literal <, >, or & (real news headlines do)
    // would be interpreted as broken markup and Telegram rejects the
    // whole message. Every message this codebase sends is plain text —
    // no HTML formatting is lost by removing this.
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error(`Telegram send failed: HTTP ${r.status} ${errText}`);
      return false;
    }
    const data = await r.json();
    if (data.ok !== true) {
      console.error(`Telegram send failed: API returned ok=false —`, JSON.stringify(data));
      return false;
    }
    // 2026-07-22 — logs the real message_id on confirmed success, so a
    // Render log line can be cross-referenced against Telegram's own
    // delivery record for a specific send (which alert, which chat,
    // when) rather than just "a send happened."
    console.log(`Telegram sent successfully — message_id: ${data.result?.message_id}`);
    return true;
  } catch(e) { console.error("Telegram error:", e.message); return false; }
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
        // 2026-07-13 — LEAP's Daily quality check (leap-monitor.md) checks
        // the actual message text for two known regression classes (stop
        // showing a real $ amount vs the old "below today's open" fallback
        // text, RSI mentions including their chart-source label) but this
        // field was never logged, so that check was structurally
        // unperformable from alerts:recent since it shipped. Message text
        // can be long; alerts:recent is capped at 50 entries in KV so this
        // is a bounded, acceptable size increase.
        message: alert.message,
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
// the old scored ORB breakout, and the LEAP/daily scanners below. Fails
// open on a network error, same tolerance as checkAlreadyFiredToday above.
// Deliberately still unsourced/legacy — see the 2026-07-16 comment on
// checkIntradayCapAvailable below for why the consolidated intraday
// scanner alone moved to its own dedicated pool and this one didn't.
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

// 2026-07-16 — the consolidated intraday scanner (VWAP_PULLBACK,
// ORB_BREAKOUT/BREAKDOWN, RIDING_THE_9, VWAP_CONTINUATION —
// runIntradayScannerCheck below) now reserves against its own dedicated
// 3/day pool (`alerts:count:intraday:{date}`), separate from MASTER's
// Step 9 Yahoo-STILL_TIME pool (2/day) and the legacy shared 5/day pool
// every other alert path still uses. Real incident that caused this:
// MASTER made one speculative GET to check its own cap and the old
// shared-key design counted that check as a real send, maxing the whole
// day's 5-alert budget by ~1pm off 2 real sends — this scanner and
// MASTER can no longer starve each other. Uses POST (the only action
// that actually reserves a slot on the new source-scoped path — see
// app/api/alerts/cap-check/route.ts), not GET.
async function checkIntradayCapAvailable() {
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/alerts/cap-check?source=intraday&token=${ADMIN_TOKEN}`, { method: "POST", headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    return data.allowed === true;
  } catch (e) {
    console.error("Intraday cap check error:", e.message);
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
      // 2026-07-14 — MOMENTUM_SHIFT disabled entirely (see ideas/route.ts:
      // checkMomentumShift call site, commented out, function left intact).
      // No target1/target2/stop by design (it's a caution on an EXISTING
      // long, not a new-entry signal), and oneLinerReason() below silently
      // degraded it to a bare "momentum shift" label since its message has
      // no newlines to extract a real reason from — 4 fired today, useless
      // to subscribers. data.momentumAlerts will always be empty/absent
      // now that the source is disabled; this line is commented out rather
      // than left calling .map() on an always-empty array.
      // ...(data.momentumAlerts ?? []).map((a) => ({ ...a, priority: 1 })),
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

// 2026-07-17 — ORB-NEW check. Route is self-contained (sends Telegram
// directly, captures the opening range and dedups per symbol per day in
// KV, gates itself to the 9:45am-11:00am ET window internally too), this
// just triggers it every 5 minutes. Separate from every other alert cap
// in this project on purpose — watches only premarket:watchlist:{date},
// not the general intraday watchlist, and is a third, independent ORB
// system (see the route's own header comment for why a third one exists
// alongside the old scored system and the consolidated scanner's
// ORB_BREAKOUT/BREAKDOWN — none of the three touch each other).
async function runOrbNewCheck() {
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/orb-new?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.alerts ?? [];
    if (alerts.length > 0) console.log(`ORB-NEW check — ${alerts.length} alert(s) sent`);
  } catch(e) { console.error("ORB-NEW check error:", e.message); }
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

// Economic release auto-summary — route is self-contained (sends Telegram
// directly, tracks its own dedup in KV per event per day), this just
// triggers it. Checked every ~15 min, 8am-4pm ET, so it's never more than
// ~15 min late catching a release's own 30-minute-after window.
async function runEconReleaseCheck(slotLabel) {
  console.log(`Running economic release check (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/economic-calendar/release-check?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log(data.sent ? `Econ release check — sent ${data.sent.code}` : "Econ release check — nothing to send this run");
  } catch(e) { console.error("Econ release check error:", e.message); }
}

// Earnings reaction check — route is self-contained (sends Telegram
// directly, dedups per symbol per day in KV), this just triggers it. Once
// per day, ~9:50am ET — 15+ min after the 9:30am open, so the route has a
// full first-15-minute window (3 five-min bars) to judge gap-hold vs fade.
async function runEarningsReactionCheck() {
  console.log("Running earnings reaction check...");
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/earnings/reaction-check?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log(`Earnings reaction check — ${data.candidateCount ?? 0} candidate(s), ${(data.fired ?? []).length} fired`);
  } catch(e) { console.error("Earnings reaction check error:", e.message); }
}

// BTC momentum — route is self-contained (sends Telegram directly, dedups
// per 4-hour period in KV), this just triggers it. Every ~30 min during
// market hours, per spec.
async function runBtcMomentumCheck(slotLabel) {
  console.log(`Running BTC momentum check (${slotLabel})...`);
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/crypto/btc-momentum?token=${ADMIN_TOKEN}`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    console.log(data.sent ? `BTC momentum — sent (${data.pct}%)` : `BTC momentum — no alert (${data.pct}%)`);
  } catch(e) { console.error("BTC momentum check error:", e.message); }
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
// `lite=1` (2026-07-13, MASTER fix): this poll only ever reads
// intradayScannerAlerts below, but the same route also runs the
// INTRADAY_STILL_TIME (3/day) and DRAM-reversal (1/day) checks
// unconditionally, and both mark their own KV budget "claimed" the
// instant a real winner is found even if nothing here sends/logs it.
// Since this poll fires ~78x/day (every 5 min, 9:30am-4pm ET) vs.
// runMarketScan's 3x/day fetch of this exact same URL (no `lite` param,
// so unchanged/full behavior there), it was silently exhausting both
// budgets on real winners this function never reads or sends — confirmed
// live 2026-07-13 (stilltime:count hit its 3/day cap with zero matching
// alerts:recent entries all day). `lite=1` skips both checks here.
async function runIntradayScannerCheck() {
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`${FLEXAI_URL}/api/options/intraday?lite=1`, { headers: { "User-Agent": "FlexAI-Monitor/3.0" } });
    const data = await r.json();
    const alerts = data.intradayScannerAlerts ?? [];
    let sent = 0;
    for (const alert of alerts) {
      if (sentToday[alert.symbol]) continue;
      if (!(await checkIntradayCapAvailable())) {
        console.log("Intraday scanner daily cap (3) reached — stopping intraday scanner sends");
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

function formatFuturesMessage(futures, opts = {}) {
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
  if (opts.stale) {
    lines.push(``, `(Weekend — prices reflect Friday's close, updates when futures market reopens Sunday 5pm ET)`);
  }
  lines.push(``, `Next check in 4 hours.`, `⚠️ Not financial advice`);
  return lines.join("\n");
}

// Futures don't trade on weekends, so every 4-hour slot was re-sending the
// exact same Friday-close numbers under a "FUTURES CHECK" header that implied
// fresh data. Now compares against the last-sent prices (futures:last_sent in
// KV) and only sends when at least one symbol moved more than 0.1% — which,
// for genuinely closed weekend futures, should be never, until real Sunday
// 5pm ET reopen data starts flowing.
async function runWeekendFuturesCheck(slotKey) {
  console.log("Running weekend futures check, slot:", slotKey);
  try {
    const futures = await getFuturesData();
    const lastSentResult = await kvGet("futures:last_sent");
    if (!lastSentResult.ok) {
      console.error("Weekend futures check: KV read failed, cannot dedup this run —", lastSentResult.error);
    }
    const lastSent = lastSentResult.ok ? lastSentResult.value : null;

    let meaningfulChange = !lastSent; // no baseline yet, or KV read failed — must send
    if (lastSent) {
      for (const f of futures) {
        if (f.price == null) continue;
        const prevPrice = lastSent[f.symbol];
        if (typeof prevPrice !== "number" || prevPrice === 0) { meaningfulChange = true; break; }
        const pctMoved = Math.abs((f.price - prevPrice) / prevPrice) * 100;
        if (pctMoved > 0.1) { meaningfulChange = true; break; }
      }
    }

    if (!meaningfulChange) {
      console.log("Weekend futures check: no symbol moved >0.1% since last send — skipping, slot:", slotKey);
      weekendSlotsSent.push(slotKey);
      return;
    }

    const { day, hour } = getET();
    const isPreReopen = day === 6 || (day === 0 && hour < 17); // Sat any time, or Sun before 5pm ET reopen
    await sendTelegram(formatFuturesMessage(futures, { stale: isPreReopen }), "admin"); // 2026-07-13 — system/admin content, not a trade alert

    const snapshot = {};
    for (const f of futures) { if (f.price != null) snapshot[f.symbol] = f.price; }
    const setResult = await kvSet("futures:last_sent", snapshot);
    if (!setResult.ok) {
      console.error("Weekend futures check: KV write failed, dedup won't work next run —", setResult.error);
    }

    weekendSlotsSent.push(slotKey);
    console.log("Weekend futures check sent, slot:", slotKey);
  } catch (e) { console.error("Weekend futures check error:", e.message); }
}

// ============================================================
// v2 SYSTEM — 2026-07-18. Fresh build, new system only, all keys prefixed
// v2:. Everything below runs entirely inside this worker on Render — no
// Mac launchd, no Vercel crons. Two agents:
//   AGENT 1 — SCANNER AGENT: TASK 1 (pre-market scan, Claude-driven),
//     TASK 2 (ORB watcher, deterministic), TASK 3 (news watcher,
//     deterministic), TASK 4 (200 EMA watcher, deterministic).
//   AGENT 2 — MASTER AGENT: 4x/day Alpaca-vs-Yahoo price verification +
//     pipeline health log, admin Telegram only.
// ============================================================

function todayETDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function alpacaBarsV2(symbol, timeframe, startISO, limit, sort) {
  const fetch = (await import("node-fetch")).default;
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${encodeURIComponent(startISO)}&limit=${limit}&sort=${sort}`;
  const r = await fetch(url, { headers: { "APCA-API-KEY-ID": ALPACA_KEY_ID, "APCA-API-SECRET-KEY": ALPACA_SECRET } });
  const d = await r.json();
  return d?.bars ?? [];
}

function v2SessionBars(bars, fromMin, toMin, dateStr) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  return bars.filter((b) => {
    const d = new Date(b.t);
    if (d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) !== dateStr) return false;
    const [h, m] = fmt.format(d).split(":").map(Number);
    const mins = h * 60 + m;
    return mins >= fromMin && mins <= toMin;
  });
}

function v2VWAP(bars) {
  if (bars.length === 0) return null;
  let cumPV = 0, cumV = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; cumPV += tp * b.v; cumV += b.v; }
  return cumV > 0 ? cumPV / cumV : null;
}

function v2EMA(bars, period) {
  const closes = bars.map((b) => b.c);
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function v2EMASeries(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const series = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  series[period - 1] = ema;
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); series[i] = ema; }
  return series;
}

// ---- AGENT 1, TASK 1 — pre-market scan (Claude API, direct) ----

async function v2GetAlpacaMovers() {
  const fetch = (await import("node-fetch")).default;
  const r = await fetch("https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50", {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY_ID, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  return r.json();
}

async function v2GetYahooMovers() {
  const fetch = (await import("node-fetch")).default;
  const headers = { "User-Agent": "Mozilla/5.0" };
  const [g, l] = await Promise.all([
    fetch("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50", { headers }).then((r) => r.json()),
    fetch("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_losers&count=50", { headers }).then((r) => r.json()),
  ]);
  return {
    gainers: g?.finance?.result?.[0]?.quotes ?? [],
    losers: l?.finance?.result?.[0]?.quotes ?? [],
  };
}

async function v2GetEarnings() {
  if (!FMP_API_KEY) return { available: false, reason: "FMP_API_KEY not set" };
  const fetch = (await import("node-fetch")).default;
  const today = todayETDate();
  const r = await fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${today}&to=${today}&apikey=${FMP_API_KEY}`);
  const data = await r.json();
  if (data && data["Error Message"]) return { available: false, reason: data["Error Message"] };
  return { available: true, data };
}

async function v2GetNews() {
  if (!FINNHUB_API_KEY) return { available: false, reason: "FINNHUB_API_KEY not set" };
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
  const data = await r.json();
  return { available: true, data: Array.isArray(data) ? data.slice(0, 40) : data };
}

const V2_TOOLS = [
  { name: "get_alpaca_movers", description: "Get Alpaca's top movers by % and volume.", input_schema: { type: "object", properties: {} } },
  { name: "get_yahoo_movers", description: "Get Yahoo Finance day gainers and day losers.", input_schema: { type: "object", properties: {} } },
  { name: "get_earnings", description: "Get today's earnings calendar (FMP). Stocks reporting today should be included.", input_schema: { type: "object", properties: {} } },
  { name: "get_news", description: "Get general market news (Finnhub). Big news means include the stock regardless of volume.", input_schema: { type: "object", properties: {} } },
  {
    name: "submit_watchlist",
    description: "Submit your final 10 stocks with current prices. Call this exactly once, as your last action.",
    input_schema: {
      type: "object",
      properties: {
        stocks: {
          type: "array",
          items: {
            type: "object",
            properties: { symbol: { type: "string" }, price: { type: "number" } },
            required: ["symbol", "price"],
          },
        },
      },
      required: ["stocks"],
    },
  },
];

const V2_SYSTEM_PROMPT = `You are a pre-market stock scanner. Find the 10 best stocks to watch at market open today.
1. Get Alpaca top movers by % and volume
2. Get Yahoo day gainers and losers
3. Combine lists — remove duplicates
4. Check earnings calendar — stocks reporting today get included
5. Check news — big news means include regardless of volume
6. High volume with no news — include, institutions may know something
7. Pick best 10 — big news first, then high volume
8. Call submit_watchlist with final 10 symbols and current prices`;

async function v2CallClaude(messages) {
  const fetch = (await import("node-fetch")).default;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4096, system: V2_SYSTEM_PROMPT, tools: V2_TOOLS, messages }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic API error ${r.status}: ${t}`); }
  return r.json();
}

// 2026-07-23 — direct admin alert on a full-window scanner failure.
// Previously the only thing that surfaced this was MASTER's 10am ET
// slot noticing the watchlist was missing — a ~90 minute blind spot
// after the 8:30-8:40am window actually closed. The call site's window
// is total>=510 && total<520 (two 5-min ticks at most), so total>=515
// reliably identifies the final tick before the window closes,
// regardless of the worker's restart-offset tick grid.
async function v2AlertScannerFailureIfLastTick(date, reason, total) {
  if (total < 515) return;
  await sendTelegram(
    `🚨 PRE-MARKET SCANNER FAILED — ${date}\nNo watchlist was built for today.\nORB and 200 EMA scans will not run.\nv2:scanner:status: ${reason}\nManual intervention needed.`,
    "admin"
  );
}

async function runPreMarketScanV2() {
  if (!isWeekday() || v2ScannerDone) return;
  console.log("=== v2 SCANNER AGENT — TASK 1 pre-market scan starting ===");
  const date = todayETDate();
  const { hour: v2ScanHour, min: v2ScanMin } = getET();
  const total = v2ScanHour * 60 + v2ScanMin;

  try {
    // ADDITIONAL FIX 5 (2026-07-21, corrected same day) — check for an
    // already-computed watchlist FIRST. The original fix (write watchlist,
    // don't mark done until send confirms) meant a retry after a
    // Telegram-only failure still re-ran the ENTIRE Claude tool-loop,
    // which could pick a genuinely different 10 stocks than the first
    // attempt — not just a resend, a different list. Now: if
    // v2:watchlist:{date} already exists, skip the tool-loop entirely
    // and resend that exact list. The tool-loop only runs when no
    // watchlist exists yet for today.
    const existingWatchlistResult = await kvGet(`v2:watchlist:${date}`);
    let stocks;

    if (existingWatchlistResult.ok && Array.isArray(existingWatchlistResult.value) && existingWatchlistResult.value.length > 0) {
      stocks = existingWatchlistResult.value;
      console.log(`v2 pre-market scan: reusing existing v2:watchlist:${date} (${stocks.length} stocks) — Claude tool-loop skipped, this is a retry of a previously-computed list.`);
    } else {
      if (!ANTHROPIC_API_KEY) {
        console.error("v2 pre-market scan: ANTHROPIC_API_KEY not set, aborting.");
        await kvSet("v2:scanner:status", "error:no_anthropic_api_key");
        await kvSet("v2:scanner:last_run", new Date().toISOString());
        await v2AlertScannerFailureIfLastTick(date, "error:no_anthropic_api_key", total);
        // CRITICAL FIX 4 (2026-07-20) — do NOT mark v2ScannerDone here.
        // Leaving it false lets the next tick inside today's 8:30am
        // window retry. restoreV2StateFromKV() only restores
        // v2ScannerDone=true when v2:scanner:status is genuinely "ok".
        return;
      }

      const messages = [{ role: "user", content: `Today's date (ET): ${date}. Run today's pre-market scan and find the 10 best stocks to watch.` }];
      let submitted = null;
      let calledAnyDataTool = false;

      for (let turn = 0; turn < 8; turn++) {
        const response = await v2CallClaude(messages);
        messages.push({ role: "assistant", content: response.content });
        const toolUses = response.content.filter((b) => b.type === "tool_use");

        if (toolUses.length === 0) {
          if (response.stop_reason === "end_turn") {
            messages.push({ role: "user", content: "You must call submit_watchlist to finish. Use the data tools first if you haven't yet." });
            continue;
          }
          break;
        }

        const toolResults = [];
        for (const tu of toolUses) {
          if (tu.name === "submit_watchlist") {
            if (!calledAnyDataTool) {
              toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Rejected: call the data tools first.", is_error: true });
              continue;
            }
            submitted = tu.input;
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Received." });
            continue;
          }
          let result;
          try {
            if (tu.name === "get_alpaca_movers") { result = await v2GetAlpacaMovers(); calledAnyDataTool = true; }
            else if (tu.name === "get_yahoo_movers") { result = await v2GetYahooMovers(); calledAnyDataTool = true; }
            else if (tu.name === "get_earnings") { result = await v2GetEarnings(); calledAnyDataTool = true; }
            else if (tu.name === "get_news") { result = await v2GetNews(); calledAnyDataTool = true; }
            else result = { error: `Unknown tool ${tu.name}` };
          } catch (e) { result = { error: e.message }; }
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 15000) });
        }
        messages.push({ role: "user", content: toolResults });
        if (submitted) break;
      }

      if (!submitted || !Array.isArray(submitted.stocks) || submitted.stocks.length === 0) {
        console.error("v2 pre-market scan: Claude never submitted a valid watchlist.");
        await kvSet("v2:scanner:status", "error:no_submission");
        await kvSet("v2:scanner:last_run", new Date().toISOString());
        await v2AlertScannerFailureIfLastTick(date, "error:no_submission", total);
        // CRITICAL FIX 4 — see note above; not marking done on this failure path either.
        return;
      }

      stocks = submitted.stocks.slice(0, 10).filter((s) => s.symbol && typeof s.price === "number");
      // Written immediately after Claude submits, BEFORE attempting to
      // send — this is what makes the "retry resends the same list"
      // guarantee above actually hold.
      await kvSet(`v2:watchlist:${date}`, stocks);
      await kvSet("v2:scanner:last_run", new Date().toISOString());
    }

    // ADDITIONAL FIX 5 (2026-07-21) — status intentionally NOT set to
    // "ok" yet. It's only written after the subscriber send is
    // confirmed, below — otherwise a restart landing between here and
    // the send would find status="ok" + today's date and
    // restoreV2StateFromKV() (CRITICAL FIX 4) would incorrectly restore
    // v2ScannerDone=true even though the watch list was never actually
    // sent to subscribers.
    const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
    const lines = stocks.map((s) => `${s.symbol} $${s.price}`).join("\n");
    const sent = await sendTelegram(`📊 WATCH LIST — ${dateLabel}\n\n${lines}\n\n⚠️ Not financial advice`, "subscribers");

    if (!sent) {
      console.error("v2 pre-market scan: Telegram send FAILED — watchlist stays in KV as-is, next tick retries the send with the SAME list (no re-run of the Claude tool-loop).");
      await kvSet("v2:scanner:status", "error:telegram_send_failed");
      await v2AlertScannerFailureIfLastTick(date, "error:telegram_send_failed", total);
      return;
    }

    // Only written after a confirmed successful send (ADDITIONAL FIX 5).
    await kvSet("v2:scanner:status", "ok");
    v2ScannerDone = true;
    console.log(`v2 pre-market scan complete — ${stocks.length} stocks, subscriber message sent.`);
  } catch (e) {
    console.error("v2 pre-market scan error:", e.message);
    const scanErrorReason = `error:${e.message}`.slice(0, 200);
    await kvSet("v2:scanner:status", scanErrorReason);
    await kvSet("v2:scanner:last_run", new Date().toISOString());
    await v2AlertScannerFailureIfLastTick(date, scanErrorReason, total);
    // CRITICAL FIX 4 — see note above; not marking done on this failure path either.
  }
}

// ---- AGENT 1, TASK 2 — ORB watcher (deterministic, no AI) ----

// 2026-07-18 — target price levels added to ORB alerts. Real weekly
// resistance/support first (reuses v2FindLevels, the same swing-point
// logic TASK 4's 200 EMA watcher already uses), Fibonacci extension off
// the opening-range width as the fallback only when fewer than 2 real
// weekly levels are found — exact given formula, not a research-backed
// technical level, so used only when the real-data path can't fill both
// targets.
async function v2ComputeOrbTargets(symbol, price, range, isBreakout) {
  const weekStart = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const weeklyBars = await alpacaBarsV2(symbol, "1Week", weekStart, 60, "asc");
  const { resistances, supports } = v2FindLevels(weeklyBars, price);
  const levels = isBreakout ? resistances : supports;
  const orbRange = range.high - range.low;

  // ADDITIONAL FIX 7 (2026-07-20) — explicit validation at the point of
  // use, not just relying on v2FindLevels's own internal price-relative
  // filter: a breakout's targets must be strictly above entry, a
  // breakdown's strictly below. v2FindLevels already filters this way
  // internally (see its own comment), so this is belt-and-suspenders —
  // guarantees it can never silently regress if that function's filter
  // logic changes later, without changing v2FindLevels's own 3% buffer.
  const validLevels = isBreakout ? levels.filter((l) => l > price) : levels.filter((l) => l < price);

  if (validLevels.length >= 2) {
    return { target1: validLevels[0], target2: validLevels[1], source: "weekly_levels" };
  }
  if (isBreakout) {
    return { target1: range.high + orbRange * 1.618, target2: range.high + orbRange * 2.618, source: "fibonacci" };
  }
  return { target1: range.low - orbRange * 1.618, target2: range.low - orbRange * 2.618, source: "fibonacci" };
}

async function runOrbWatcherV2() {
  if (!isWeekday()) return;
  const date = todayETDate();
  const watchlistResult = await kvGet(`v2:watchlist:${date}`);
  const watchlist = watchlistResult.ok && Array.isArray(watchlistResult.value) ? watchlistResult.value : [];
  if (watchlist.length === 0) { console.log("v2 ORB watcher: no watchlist yet, skipping."); return; }

  for (const entry of watchlist) {
    const symbol = entry.symbol;
    if (!symbol) continue;
    try {
      // v2:orb:alerted:{date}:{symbol} is the PERMANENT record — only
      // ever written after a confirmed successful Telegram send (see
      // CRITICAL FIX 1 below). ADDITIONAL FIX 8 (2026-07-20, made
      // explicit): once this key is set, every later tick for the rest
      // of the day hits this check and skips — only the FIRST qualifying
      // candle for a symbol can ever result in a sent alert, all
      // subsequent candles are ignored regardless of how many more
      // 5-min bars keep qualifying between 9:45-10:15am ET.
      const alertedResult = await kvGet(`v2:orb:alerted:${date}:${symbol}`);
      if (alertedResult.ok && alertedResult.value) continue;

      // 2026-07-19 — fetch 5-min bars once, up front, and reuse for both
      // the opening-range volume baseline (FIX 1) and the full session
      // (VWAP/EMA/breakout bar) below. Used to be two separate fetches
      // (1-min bars for range, 5-min bars fetched again later for
      // session), with the range's avgVolume wrongly built from the
      // 1-min set.
      const fiveMinBars = await alpacaBarsV2(symbol, "5Min", `${date}T04:00:00-04:00`, 500, "asc");

      const rangeKey = `v2:orb:range:${date}:${symbol}`;
      const rangeResult = await kvGet(rangeKey);
      let range = rangeResult.ok ? rangeResult.value : null;

      if (!range) {
        const oneMinBars = await alpacaBarsV2(symbol, "1Min", `${date}T04:00:00-04:00`, 500, "asc");
        const opening = v2SessionBars(oneMinBars, 9 * 60 + 30, 9 * 60 + 45, date);
        if (opening.length === 0) continue; // no data yet, try again next tick
        const high = Math.max(...opening.map((b) => b.h));
        const low = Math.min(...opening.map((b) => b.l));

        // FIX 1 (2026-07-19) — average volume must come from the three
        // 5-min bars that make up the 9:30-9:45 opening range, not 1-min
        // bars. A 5-min bar carries roughly 5x a 1-min bar's volume, so
        // comparing a 5-min breakout candle against a 1-min-scaled
        // baseline made the 1.5x threshold trigger far too easily. Upper
        // bound is minute 9:44 (not 9:45) so the 9:45-9:50 bar itself
        // doesn't get pulled into the "opening range" baseline.
        const openingFiveMin = v2SessionBars(fiveMinBars, 9 * 60 + 30, 9 * 60 + 44, date);
        const avgVolume = openingFiveMin.length > 0
          ? openingFiveMin.reduce((s, b) => s + b.v, 0) / openingFiveMin.length
          : opening.reduce((s, b) => s + b.v, 0) / opening.length; // fallback only if 5-min bars aren't available yet for some reason

        range = { high, low, midpoint: (high + low) / 2, avgVolume };
        await kvSet(rangeKey, range);
      }

      // FIX 2 (2026-07-19) — only evaluate fully-closed 5-min candles.
      // session[session.length - 1] could be the currently-forming bar —
      // Alpaca returns an in-progress bar for the period still underway —
      // which would evaluate a breakout/breakdown against incomplete data.
      const session = v2SessionBars(fiveMinBars, 9 * 60 + 30, 16 * 60, date);
      const closedBars = session.filter((b) => new Date(b.t).getTime() + 5 * 60 * 1000 <= Date.now());
      if (closedBars.length === 0) continue;
      const bar = closedBars[closedBars.length - 1];

      const isBreakout = bar.c > range.high && bar.c > bar.o && bar.v > range.avgVolume * 1.5;
      const isBreakdown = bar.c < range.low && bar.c < bar.o && bar.v > range.avgVolume * 1.5;
      if (!isBreakout && !isBreakdown) continue;

      // CRITICAL FIX 1 (2026-07-20) — replaces the old design (which set
      // v2:orb:alerted permanently via NX, BEFORE sending) with a
      // separate SHORT-LIVED lock. The old design's real bug: if
      // sendTelegram failed after the permanent key was already set, the
      // alert was suppressed for the rest of the day with no recovery —
      // a genuine breakout would just silently never reach subscribers.
      // Now: a 60-second expiring lock guards against two overlapping
      // tick() runs reaching this exact point at the same time (the
      // original race the NX pattern was solving); the PERMANENT
      // v2:orb:alerted key is only written after sendTelegram actually
      // confirms success. If the send fails, the lock expires within 60
      // seconds and the very next real tick (5 min later) gets a clean
      // retry — sendTelegram itself now returns true/false so this can
      // be checked (see its own 2026-07-20 comment). Verified live
      // against Upstash: `?NX&EX=60` sets a real 60s-TTL key, and a
      // second SET on that same key while still live is correctly
      // blocked.
      const lockResult = await kvSetNX(`v2:orb:lock:${date}:${symbol}`, true, 60);
      if (!lockResult.ok) {
        console.error(`v2 ORB watcher: lock acquire failed for ${symbol} (KV error) —`, lockResult.error, "— skipping this tick");
        continue;
      }
      if (!lockResult.acquired) {
        console.log(`v2 ORB watcher: ${symbol} already locked by another tick — skipping duplicate`);
        continue;
      }

      const vwap = v2VWAP(session);
      const ema9 = v2EMA(session, 9);
      const ema20 = v2EMA(session, 20);
      const price = bar.c;
      const fmt = (n) => (n != null ? `$${n.toFixed(2)}` : "N/A");

      const { target1, target2, source: targetSource } = await v2ComputeOrbTargets(symbol, price, range, isBreakout);

      const message = isBreakout
        ? `🚨 BREAKOUT — ${symbol} $${price.toFixed(2)}\nAbove opening range $${range.high.toFixed(2)}\nVWAP: ${fmt(vwap)} | 9 EMA: ${fmt(ema9)} | 20 EMA: ${fmt(ema20)}\n🎯 TARGET 1: ${fmt(target1)}\n🎯 TARGET 2: ${fmt(target2)}\n⛔ STOP: $${range.midpoint.toFixed(2)}\n⚠️ Not financial advice`
        : `🔻 BREAKDOWN — ${symbol} $${price.toFixed(2)}\nBelow opening range $${range.low.toFixed(2)}\nVWAP: ${fmt(vwap)} | 9 EMA: ${fmt(ema9)} | 20 EMA: ${fmt(ema20)}\n🎯 TARGET 1: ${fmt(target1)}\n🎯 TARGET 2: ${fmt(target2)}\n⛔ STOP: $${range.midpoint.toFixed(2)}\n⚠️ Not financial advice`;
      console.log(`v2 ORB watcher: targets for ${symbol} from ${targetSource}: $${target1?.toFixed(2)} / $${target2?.toFixed(2)}`);

      const sent = await sendTelegram(message, "subscribers");
      if (!sent) {
        console.error(`v2 ORB watcher: Telegram send FAILED for ${symbol} — permanent alerted key NOT written, lock expires within 60s, next tick will retry.`);
        continue;
      }

      // Only written after a confirmed successful send (CRITICAL FIX 1).
      await kvSet(`v2:orb:alerted:${date}:${symbol}`, true);
      console.log(`v2 ORB watcher: ${isBreakout ? "BREAKOUT" : "BREAKDOWN"} fired for ${symbol}`);
    } catch (e) { console.error(`v2 ORB watcher error for ${symbol}:`, e.message); }
  }
}

// ---- AGENT 1, TASK 3 — news watcher (deterministic, no AI) ----

const V2_NEWS_KEYWORDS = ["earnings", "acquisition", "merger", "fda", "approval", "upgrade", "downgrade", "contract", "beat", "miss"];

function v2MatchesKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return V2_NEWS_KEYWORDS.some((kw) => lower.includes(kw));
}

async function v2GetFinnhubGeneralNews() {
  if (!FINNHUB_API_KEY) return { available: false, reason: "FINNHUB_API_KEY not set" };
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
  const data = await r.json();
  return { available: true, data: Array.isArray(data) ? data : [] };
}

async function v2GetFmpGeneralNews() {
  if (!FMP_API_KEY) return { available: false, reason: "FMP_API_KEY not set" };
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`https://financialmodelingprep.com/stable/news/general-latest?limit=50&apikey=${FMP_API_KEY}`);
  const data = await r.json();
  if (data && data["Error Message"]) return { available: false, reason: data["Error Message"] };
  return { available: true, data: Array.isArray(data) ? data : [] };
}

async function runNewsWatcherV2() {
  if (!isWeekday()) return;
  const date = todayETDate();
  try {
    const [finnhub, fmp] = await Promise.all([v2GetFinnhubGeneralNews(), v2GetFmpGeneralNews()]);
    const articles = [];
    if (finnhub.available) {
      for (const item of finnhub.data) {
        const symbols = (item.related || "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const symbol of symbols) articles.push({ symbol, headline: item.headline, source: "finnhub" });
      }
    } else {
      console.log("v2 news watcher: Finnhub unavailable —", finnhub.reason);
    }
    if (fmp.available) {
      for (const item of fmp.data) {
        const symbol = item.symbol || (Array.isArray(item.tickers) && item.tickers[0]) || null;
        if (symbol) articles.push({ symbol, headline: item.title || item.text, source: "fmp" });
      }
    } else {
      console.log("v2 news watcher: FMP unavailable —", fmp.reason);
    }

    for (const a of articles) {
      if (!a.symbol || !v2MatchesKeyword(a.headline)) continue;

      // BLOCKING FIX 1 (2026-07-21) — replaces the permanent-NX-before-
      // send pattern (2026-07-20) with the same split ORB already uses:
      // a short-lived lock claimed first, the PERMANENT v2:news:sent key
      // only written after sendTelegram confirms success. The
      // 2026-07-20 version had the same real bug ORB had before its own
      // fix — if Telegram failed after the permanent key was already
      // set, the alert was gone for the rest of the day with no
      // recovery. 5-min TTL (longer than ORB's 60s — this watcher only
      // runs every ~30 min, so a 60s lock would expire long before the
      // next real run anyway and provide no protection against that
      // next run retrying cleanly).
      const alreadySentResult = await kvGet(`v2:news:sent:${date}:${a.symbol}`);
      if (alreadySentResult.ok && alreadySentResult.value) continue; // cheap pre-filter

      const lockResult = await kvSetNX(`v2:news:lock:${date}:${a.symbol}`, true, 300);
      if (!lockResult.ok) {
        console.error(`v2 news watcher: lock acquire failed for ${a.symbol} (KV error) —`, lockResult.error, "— skipping this run");
        continue;
      }
      if (!lockResult.acquired) {
        console.log(`v2 news watcher: ${a.symbol} already locked by another run — skipping duplicate`);
        continue;
      }

      const sent = await sendTelegram(`📰 BREAKING — ${a.symbol}\n${a.headline}\n⚠️ Not financial advice`, "subscribers");
      if (!sent) {
        console.error(`v2 news watcher: Telegram send FAILED for ${a.symbol} — permanent sent key NOT written, lock expires within 5min, next run will retry.`);
        continue;
      }

      // Only written after a confirmed successful send (BLOCKING FIX 1).
      await kvSet(`v2:news:sent:${date}:${a.symbol}`, true);
      console.log(`v2 news watcher: fired for ${a.symbol} (${a.source})`);
    }
  } catch (e) { console.error("v2 news watcher error:", e.message); }
}

// ---- AGENT 1, TASK 4 — 200 EMA watcher (deterministic, no AI) ----

function v2FindLevels(weeklyBars, price) {
  // Swing high/low pivots, filtered to at least 3% from current price —
  // matches this project's established findKeyLevels/findSupportsResistances
  // fix (a level a single bar away isn't a real target). This 3% filter
  // is also what satisfies ADDITIONAL FIX 7 (2026-07-20) at the source:
  // resistances (b.h > price*1.03) are always strictly above `price`,
  // supports (b.l < price*0.97) always strictly below — a breakout can
  // never receive a target below entry, a breakdown never above.
  // v2ComputeOrbTargets adds its own explicit re-check on top of this as
  // defense-in-depth, not because this filter is known to be wrong.
  const resistances = [];
  const supports = [];
  for (let i = 2; i < weeklyBars.length - 2; i++) {
    const b = weeklyBars[i];
    const isSwingHigh = b.h > weeklyBars[i - 1].h && b.h > weeklyBars[i - 2].h && b.h > weeklyBars[i + 1].h && b.h > weeklyBars[i + 2].h;
    const isSwingLow = b.l < weeklyBars[i - 1].l && b.l < weeklyBars[i - 2].l && b.l < weeklyBars[i + 1].l && b.l < weeklyBars[i + 2].l;
    if (isSwingHigh && b.h > price * 1.03) resistances.push(b.h);
    if (isSwingLow && b.l < price * 0.97) supports.push(b.l);
  }
  resistances.sort((a, b) => a - b);
  supports.sort((a, b) => b - a);
  return { resistances: resistances.slice(0, 2), supports: supports.slice(0, 2) };
}

// TASK 4 reads the SAME v2:watchlist:{date} the other tasks use — the spec
// said "current dynamic watchlist" without defining a separate list for
// this fresh v2 system, and the old lib/dynamicWatchlist.ts build
// (watchlist:intraday:{date}) is no longer being rebuilt (disabled in the
// prior stop-everything pass) — using that would silently go stale.
// Disclosed interpretation, not silently assumed.
async function runEma200WatcherV2() {
  if (!isWeekday() || v2Ema200Done) return;
  console.log("=== v2 SCANNER AGENT — TASK 4 200 EMA watcher starting ===");
  const date = todayETDate();
  const watchlistResult = await kvGet(`v2:watchlist:${date}`);
  const watchlist = watchlistResult.ok && Array.isArray(watchlistResult.value) ? watchlistResult.value : [];
  // FIX 4 (2026-07-19) — do NOT mark v2Ema200Done here. The old code set
  // it true even when the watchlist simply hadn't been written yet (e.g.
  // TASK 1 running late, or KV read hiccup), permanently skipping this
  // watcher for the rest of the day with no retry. Log and return,
  // leaving the flag false so the next tick (still inside the 10am
  // window per tick()'s own gate) tries again.
  if (watchlist.length === 0) { console.log("v2 EMA200 watcher: no watchlist yet, skipping — will retry next tick."); return; }

  // BLOCKING FIX 2 (2026-07-21) — tracks whether any qualifying symbol
  // this pass didn't actually get a confirmed send. The old code wrote
  // v2:ema200:done:{date} / v2Ema200Done=true unconditionally after the
  // loop, even if a qualifying alert failed to acquire its lock or its
  // Telegram send failed — permanently skipping that symbol for the
  // rest of the day (and across a restart, via restoreV2StateFromKV)
  // with no retry. Now: any lock-acquire failure or send failure on a
  // symbol that actually qualified sets pendingRetry=true, and the done
  // flag is only written if nothing was left pending.
  let pendingRetry = false;

  for (const entry of watchlist) {
    const symbol = entry.symbol;
    if (!symbol) continue;
    try {
      // Cheap pre-filter only, avoids the Alpaca daily/weekly bar fetches
      // below for a symbol already done — the atomic NX claim right
      // before sending (2026-07-20) is the real dedup gate.
      const alertedResult = await kvGet(`v2:ema200:alerted:${date}:${symbol}`);
      if (alertedResult.ok && alertedResult.value) continue;

      // ADDITIONAL FIX 6 (2026-07-20) — 400 calendar days back (was 300),
      // to safely clear 200 trading bars with real margin. 300 calendar
      // days is only ~210 trading days after weekends/holidays (CLAUDE.md
      // Common Problem #4's ~30% attrition rule), leaving very little
      // slack before the `< 202` check below starts skipping symbols
      // that should genuinely qualify. limit bumped to match.
      const start = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const dailyBarsRaw = await alpacaBarsV2(symbol, "1Day", start, 400, "asc");

      // FIX 3 (2026-07-19) — exclude today's still-forming daily bar. This
      // watcher runs at 10am ET, hours before the close, and Alpaca
      // returns a partial bar for today once the session is underway —
      // treating that as a "confirmed" candle in the 2-day-close check
      // was wrong. Only the last two fully COMPLETED daily bars may be
      // used, so `dailyBars`'s most recent entry is yesterday, not today.
      // Below, the variable names priceToday/emaToday etc. now mean "the
      // most recent COMPLETED trading day" (yesterday, ET) — kept as-is
      // rather than renamed throughout, to keep this fix minimal.
      const dailyBars = dailyBarsRaw.filter((b) => new Date(b.t).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) !== date);
      if (dailyBars.length < 202) continue; // not enough history for a 200 EMA + 2-day confirm

      const closes = dailyBars.map((b) => b.c);
      const emaSeries = v2EMASeries(closes, 200);
      const last = dailyBars.length - 1;
      if (emaSeries[last] == null || emaSeries[last - 1] == null || emaSeries[last - 2] == null) continue;

      const priceToday = closes[last];
      const priceYesterday = closes[last - 1];
      const emaToday = emaSeries[last];
      const emaYesterday = emaSeries[last - 1];
      const emaTwoDaysAgo = emaSeries[last - 2];
      const priceTwoDaysAgo = closes[last - 2];

      const bothAboveConfirmed = priceToday > emaToday && priceYesterday > emaYesterday && priceTwoDaysAgo <= emaTwoDaysAgo;
      const bothBelowConfirmed = priceToday < emaToday && priceYesterday < emaYesterday && priceTwoDaysAgo >= emaTwoDaysAgo;
      if (!bothAboveConfirmed && !bothBelowConfirmed) continue;

      const weekStart = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const weeklyBars = await alpacaBarsV2(symbol, "1Week", weekStart, 60, "asc");
      const { resistances, supports } = v2FindLevels(weeklyBars, priceToday);
      const fmt = (n) => (n != null ? `$${n.toFixed(2)}` : "N/A");

      const message = bothAboveConfirmed
        ? `📈 200 EMA CROSS — ${symbol}\nCrossed ABOVE 200 EMA — confirmed ✅\nTwo daily candles closed above ✅\nWeekly resistance:\n🎯 LEVEL 1: ${fmt(resistances[0])}\n🎯 LEVEL 2: ${fmt(resistances[1])}\n⛔ STOP: below 200 EMA $${emaToday.toFixed(2)}\n⚠️ Not financial advice`
        : `📉 200 EMA CROSS — ${symbol}\nCrossed BELOW 200 EMA — confirmed ✅\nTwo daily candles closed below ✅\nWeekly support:\n🎯 LEVEL 1: ${fmt(supports[0])}\n🎯 LEVEL 2: ${fmt(supports[1])}\n⛔ STOP: above 200 EMA $${emaToday.toFixed(2)}\n⚠️ Not financial advice`;

      // BLOCKING FIX 1 (2026-07-21) — replaces the permanent-NX-before-
      // send pattern (2026-07-20) with the same split ORB already uses:
      // a short-lived lock claimed first, the PERMANENT v2:ema200:alerted
      // key only written after sendTelegram confirms success. Same real
      // bug as the news watcher above — a Telegram failure after the
      // permanent key was set meant no recovery for the rest of the day.
      // The early alertedResult check near the top of this loop stays as
      // a cheap pre-filter (skips the Alpaca daily/weekly bar fetches for
      // symbols already done); this lock is the real, race-safe gate.
      const lockResult = await kvSetNX(`v2:ema200:lock:${date}:${symbol}`, true, 300);
      if (!lockResult.ok) {
        console.error(`v2 200 EMA watcher: lock acquire failed for ${symbol} (KV error) —`, lockResult.error, "— skipping this run");
        pendingRetry = true; // BLOCKING FIX 2
        continue;
      }
      if (!lockResult.acquired) {
        console.log(`v2 200 EMA watcher: ${symbol} already locked by another run — skipping duplicate`);
        pendingRetry = true; // BLOCKING FIX 2 — status genuinely unresolved from this run's perspective
        continue;
      }

      const sent = await sendTelegram(message, "subscribers");
      if (!sent) {
        console.error(`v2 200 EMA watcher: Telegram send FAILED for ${symbol} — permanent alerted key NOT written, lock expires within 5min, next run will retry.`);
        pendingRetry = true; // BLOCKING FIX 2
        continue;
      }

      // Only written after a confirmed successful send (BLOCKING FIX 1).
      await kvSet(`v2:ema200:alerted:${date}:${symbol}`, true);
      console.log(`v2 200 EMA watcher: fired for ${symbol}`);
    } catch (e) { console.error(`v2 200 EMA watcher error for ${symbol}:`, e.message); }
  }
  // FIX 7 (2026-07-19) — persist completion to KV, not just the in-memory
  // flag, so a Render restart mid-window doesn't forget this already ran
  // today and start scanning every symbol again from scratch. Read back
  // at boot by restoreV2StateFromKV() below.
  // BLOCKING FIX 2 (2026-07-21) — only write the completion markers if
  // nothing was left pending this pass. If pendingRetry is true, both
  // this KV write and the in-memory flag are skipped entirely, so the
  // next tick still inside today's 10am window (tick()'s own gate) —
  // or, after a restart, restoreV2StateFromKV() finding no
  // v2:ema200:done:{date} key — retries the symbols that didn't get a
  // confirmed send.
  if (!pendingRetry) {
    await kvSet(`v2:ema200:done:${date}`, true);
    v2Ema200Done = true;
  } else {
    console.log("v2 200 EMA watcher: at least one qualifying symbol did not get a confirmed send this pass — done flag NOT written, will retry.");
  }
}

// ---- AGENT 2 — MASTER AGENT (admin-only, never subscribers) ----

// CRITICAL FIX 5 (2026-07-20) — replaces the old "closest 1-min bar to
// 30 minutes ago" approximation. That design deliberately compared
// stale (30-min-old) snapshots from both sources with no timestamp
// validation at all, and the admin message hardcoded "Time checked: 30
// min ago" regardless of what was actually fetched — a real risk if the
// approximation ever landed on a different bar than intended. Now
// fetches each source's actual latest trade/price and returns its real
// timestamp, so the caller can enforce a genuine freshness check and
// report the real time in the message.
async function v2GetAlpacaLatestPrice(symbol) {
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/trades/latest`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY_ID, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  const d = await r.json();
  const trade = d?.trade;
  if (!trade || typeof trade.p !== "number" || !trade.t) return null;
  return { price: trade.p, timestamp: new Date(trade.t).getTime() };
}

async function v2GetYahooLatestPrice(symbol) {
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result) return null;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (closes[i] != null) return { price: closes[i], timestamp: timestamps[i] * 1000 };
  }
  return null;
}

// CRITICAL FIX 3 (2026-07-20) — now returns true on genuine completion,
// false on failure. tick() only persists the slot as done (both the
// in-memory array and v2:master:slots:{date}) when this returns true —
// the old code marked the slot complete BEFORE calling this function at
// all, so a failure (thrown exception, etc.) still left the slot
// permanently marked done and a restart would never retry it.
async function runMasterAgentV2(slotLabel) {
  if (!isWeekday()) return false;
  console.log(`=== v2 MASTER AGENT running, slot: ${slotLabel} ===`);
  const date = todayETDate();
  const log = { slot: slotLabel, time: new Date().toISOString(), checks: [] };

  try {
    const watchlistResult = await kvGet(`v2:watchlist:${date}`);
    const watchlist = watchlistResult.ok && Array.isArray(watchlistResult.value) ? watchlistResult.value : [];

    if (watchlist.length === 0) {
      log.checks.push({ check: "watchlist_exists", result: "FAIL", detail: `v2:watchlist:${date} missing or empty` });
      await sendTelegram(`⚠️ v2:watchlist:${date} is missing or empty at the ${slotLabel} check — SCANNER AGENT's pre-market scan may not have run.`, "admin");
    } else {
      log.checks.push({ check: "watchlist_exists", result: "OK", detail: `${watchlist.length} stocks` });
    }

    // CRITICAL FIX 5 (2026-07-20) — regular market hours only (9:30am-
    // 4:00pm ET). MASTER's own fixed schedule (10am/12pm/2pm/4pm ET)
    // already guarantees this in practice, but this is a real, explicit
    // gate rather than an assumption — never compares a pre/post-market
    // print against a regular-hours one.
    // BLOCKING FIX 2 (2026-07-21, corrected same day) — the upper bound
    // was `<= 960`, but the 4pm slot in tick() fires on the full
    // `total >= 960 && total < 970` window (ticks land wherever the
    // worker's last restart offset put them, not necessarily aligned to
    // :00/:05). First pass widened this to `< 965`, which still excluded
    // 965-969 — part of that same real firing range. Now `< 970`,
    // matching the slot's actual window exactly.
    const { hour: nowHour, min: nowMin } = getET();
    const nowTotal = nowHour * 60 + nowMin;
    const isRegularMarketHours = nowTotal >= 570 && nowTotal < 970;
    const FIVE_MIN_MS = 5 * 60 * 1000;

    let mismatches = 0;
    let unverified = 0; // SKIP, ERROR, stale, or outside market hours — no real fresh comparable price obtained
    for (const entry of watchlist) {
      const symbol = entry.symbol;
      if (!symbol) continue;
      try {
        if (!isRegularMarketHours) {
          unverified++;
          log.checks.push({ check: "price_verify", symbol, result: "SKIP", detail: "outside regular market hours" });
          continue;
        }

        const [alpacaResult, yahooResult] = await Promise.all([v2GetAlpacaLatestPrice(symbol), v2GetYahooLatestPrice(symbol)]);
        if (!alpacaResult || !yahooResult) {
          unverified++;
          log.checks.push({ check: "price_verify", symbol, result: "SKIP", detail: "missing data from one source" });
          continue;
        }

        // CRITICAL FIX 5 — reject stale prices rather than silently
        // comparing them. The old code had no timestamp validation at
        // all; its admin message hardcoded "Time checked: 30 min ago"
        // regardless of what was actually fetched.
        const now = Date.now();
        const alpacaAge = now - alpacaResult.timestamp;
        const yahooAge = now - yahooResult.timestamp;
        if (alpacaAge > FIVE_MIN_MS || yahooAge > FIVE_MIN_MS) {
          unverified++;
          log.checks.push({ check: "price_verify", symbol, result: "SKIP", detail: `stale price (Alpaca ${Math.round(alpacaAge / 1000)}s old, Yahoo ${Math.round(yahooAge / 1000)}s old)` });
          continue;
        }

        // ADDITIONAL FIX 4 (2026-07-21) — both prices can each individually
        // pass the 5-min freshness check above while still being minutes
        // apart FROM EACH OTHER (e.g. Alpaca ticked 10s ago, Yahoo's last
        // print was 3 minutes ago). On a fast-moving stock that gap alone
        // can produce a >1% "mismatch" that isn't really a data problem —
        // just two sources sampled at different moments. Skew >90s is
        // treated as SKIP (not comparable right now), not MISMATCH.
        const skewMs = Math.abs(alpacaResult.timestamp - yahooResult.timestamp);
        if (skewMs > 90000) {
          unverified++;
          log.checks.push({ check: "price_verify", symbol, result: "SKIP", detail: `timestamp skew too large (${Math.round(skewMs / 1000)}s apart)` });
          continue;
        }

        const alpacaPrice = alpacaResult.price;
        const yahooPrice = yahooResult.price;
        const pctDiff = Math.abs((alpacaPrice - yahooPrice) / yahooPrice) * 100;
        const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });

        if (pctDiff > 1) {
          mismatches++;
          log.checks.push({ check: "price_verify", symbol, result: "MISMATCH", alpacaPrice, yahooPrice, pctDiff });
          // 2026-07-22 — found during a Monday-readiness review: this was
          // the one remaining place with the exact bug class already
          // fixed for ORB/News/EMA200 (2026-07-20/21) — a PERMANENT NX
          // claim (no TTL) was written BEFORE sendTelegram, and its
          // return value was never checked. If that admin send failed,
          // this mismatch was gone for the rest of the day with no
          // retry — nobody would ever learn about a real data-integrity
          // problem MASTER exists specifically to catch. Now uses the
          // same short-lived-lock-then-permanent-key-after-confirm split
          // as the other three, 300s TTL (matches News/EMA200's window,
          // MASTER's own slots are 2+ hours apart so a short lock still
          // fully protects against the real concurrent-run race).
          const mismatchLock = await kvSetNX(`v2:master:mismatch:lock:${date}:${symbol}`, true, 300);
          if (!mismatchLock.ok) {
            console.error(`v2 MASTER AGENT: mismatch lock acquire failed for ${symbol} (KV error) —`, mismatchLock.error, "— not sending to avoid an unprotected duplicate");
          } else if (!mismatchLock.acquired) {
            console.log(`v2 MASTER AGENT: mismatch for ${symbol} already locked by another run — skipping duplicate admin ping`);
          } else {
            // CRITICAL FIX 5 — real timestamps in the message, not a
            // hardcoded "30 min ago".
            const mismatchSent = await sendTelegram(`⚠️ DATA MISMATCH — ${symbol}\nAlpaca: $${alpacaPrice.toFixed(2)} (${fmtTime(alpacaResult.timestamp)} ET)\nYahoo: $${yahooPrice.toFixed(2)} (${fmtTime(yahooResult.timestamp)} ET)\nTime checked: ${fmtTime(now)} ET\nInvestigating...`, "admin");
            if (mismatchSent) {
              // Only written after a confirmed successful send.
              await kvSet(`v2:master:mismatch:${date}:${symbol}`, true);
            } else {
              console.error(`v2 MASTER AGENT: mismatch admin send FAILED for ${symbol} — permanent key NOT written, lock expires within 5min, next slot will retry.`);
            }
          }
        } else {
          log.checks.push({ check: "price_verify", symbol, result: "OK", alpacaPrice, yahooPrice, pctDiff });
        }
      } catch (e) {
        unverified++;
        log.checks.push({ check: "price_verify", symbol, result: "ERROR", detail: e.message });
      }
    }
    // A SKIP/ERROR/stale/off-hours result used to be silently ignored by
    // this check, so "verified" could come back true even when some
    // symbols were never actually compared. Also require a non-empty
    // watchlist — "all zero symbols matched" isn't a real verification.
    await kvSet(`v2:master:verified:${date}`, mismatches === 0 && unverified === 0 && watchlist.length > 0);

    const orbFired = [];
    for (const entry of watchlist) {
      if (!entry.symbol) continue;
      const alerted = await kvGet(`v2:orb:alerted:${date}:${entry.symbol}`);
      if (alerted.ok && alerted.value) orbFired.push(entry.symbol);
    }
    log.checks.push({ check: "orb_alerts_fired", result: orbFired.length > 0 ? "OK" : "NONE", symbols: orbFired });

    let newsCount = 0;
    for (const entry of watchlist) {
      if (!entry.symbol) continue;
      const sent = await kvGet(`v2:news:sent:${date}:${entry.symbol}`);
      if (sent.ok && sent.value) newsCount++;
    }
    log.checks.push({ check: "news_watcher_activity", result: "LOGGED", watchlistSymbolsWithNews: newsCount });

    const existingLogResult = await kvGet(`v2:master:log:${date}`);
    const existingLog = existingLogResult.ok && Array.isArray(existingLogResult.value) ? existingLogResult.value : [];
    existingLog.push(log);
    await kvSet(`v2:master:log:${date}`, existingLog);

    await kvSet("v2:master:last_check", new Date().toISOString());
    await kvSet("v2:master:status", "ok");

    console.log(`v2 MASTER AGENT (${slotLabel}) complete — ${mismatches} mismatches, ${orbFired.length} ORB alerts, ${newsCount} news alerts logged.`);
    return true;
  } catch (e) {
    console.error("v2 MASTER AGENT error:", e.message);
    await kvSet("v2:master:status", `error:${e.message}`.slice(0, 200));
    await kvSet("v2:master:last_check", new Date().toISOString());
    await sendTelegram(`🚨 v2 MASTER AGENT error (${slotLabel}): ${e.message}`, "admin");
    return false;
  }
}

// FIX 7 (2026-07-19) — v2ScannerDone/v2Ema200Done/v2MasterSlots are
// plain in-memory state, wiped on every Render restart (every deploy).
// Without this, a restart mid-window would forget a task already ran
// today and re-run it from scratch — the pre-market scan sending a
// second real "WATCH LIST" message, or the 200 EMA watcher re-scanning
// every symbol. Called once at boot, before the first tick(), so these
// flags reflect reality even if the process just restarted mid-day.
async function restoreV2StateFromKV() {
  const date = todayETDate();
  try {
    const lastRunResult = await kvGet("v2:scanner:last_run");
    const statusResult = await kvGet("v2:scanner:status");
    if (lastRunResult.ok && lastRunResult.value) {
      const lastRunDate = new Date(lastRunResult.value).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      // CRITICAL FIX 4 (2026-07-20) — only restore v2ScannerDone=true if
      // today's run actually SUCCEEDED (status === "ok"), not just that
      // an attempt happened. Ties this restore logic to the same-day
      // in-memory-only fix in runPreMarketScanV2 — a failed attempt must
      // stay retryable across a restart too, not just within one boot.
      if (lastRunDate === date && statusResult.ok && statusResult.value === "ok") {
        v2ScannerDone = true;
        console.log("v2 restore: pre-market scan already succeeded today — v2ScannerDone=true");
      }
    }
  } catch (e) { console.error("v2 restore (scanner) failed:", e.message); }

  try {
    const ema200DoneResult = await kvGet(`v2:ema200:done:${date}`);
    if (ema200DoneResult.ok && ema200DoneResult.value) {
      v2Ema200Done = true;
      console.log("v2 restore: 200 EMA watcher already ran today — v2Ema200Done=true");
    }
  } catch (e) { console.error("v2 restore (200 EMA) failed:", e.message); }

  try {
    const masterSlotsResult = await kvGet(`v2:master:slots:${date}`);
    if (masterSlotsResult.ok && Array.isArray(masterSlotsResult.value)) {
      v2MasterSlots = masterSlotsResult.value;
      console.log("v2 restore: MASTER AGENT slots restored from KV:", v2MasterSlots);
    }
  } catch (e) { console.error("v2 restore (master slots) failed:", e.message); }
}

async function tick() {
  checkReset();
  const { hour, min, day } = getET();
  const total = hour * 60 + min;

  // Crypto trades 24/7 — this must run independent of the stock-market
  // weekday/holiday gate below, or it silently never fires on weekends.
  // Two fixed daily slots: 10:00am and 4:00pm ET.
  // 2026-07-18 — ALL CRYPTO ALERTS DISABLED per explicit instruction.
  // Comment out to re-enable, do not delete. runCryptoScan() itself is
  // left completely intact, only this call site is disabled.
  // if (total >= 600 && total < 610 && !cryptoScanSlots.includes("10:00")) {
  //   await runCryptoScan("10:00");
  // }
  // if (total >= 960 && total < 970 && !cryptoScanSlots.includes("16:00")) {
  //   await runCryptoScan("16:00");
  // }

  // Weekend futures monitor — Sat/Sun only, every 4 hours (8a/12p/4p/8p
  // ET). Fires unconditionally regardless of movement, so it also runs
  // independent of the weekday gate below.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runWeekendFuturesCheck() itself is left completely intact.
  // const isWeekendDay = day === 0 || day === 6;
  // if (isWeekendDay) {
  //   for (const slotHour of WEEKEND_FUTURES_SLOTS) {
  //     const slotKey = String(slotHour);
  //     const slotStart = slotHour * 60;
  //     if (total >= slotStart && total < slotStart + 30 && !weekendSlotsSent.includes(slotKey)) {
  //       await runWeekendFuturesCheck(slotKey);
  //     }
  //   }
  // }

  if (isMarketHoliday()) { console.log("Market holiday — stock scans resting"); return; }
  if (!isWeekday()) { console.log("Weekend — stock scans resting"); return; }

  // ============================================================
  // v2 SYSTEM — 2026-07-18. Fresh build, the only thing actively running
  // besides breaking news. All non-returning (same reasoning as the
  // intraday scanner/ORB-NEW below — must not get starved by the
  // mutually-exclusive return-based chain further down, which is now
  // fully disabled anyway but kept non-returning for consistency).
  // ============================================================

  // TASK 1 — pre-market scan (Claude API): once at 8:30am ET.
  if (total >= 510 && total < 520 && !v2ScannerDone) {
    await runPreMarketScanV2();
  }

  // TASK 2 — ORB watcher: every 5 min, 9:45am-10:15am ET only (per spec,
  // a tighter window than the older, separate orb-new system this
  // supersedes for the fresh v2 pipeline).
  // 2026-07-23 — confirmed intentional (Codex review question): fires on
  // the FIRST QUALIFYING candle anywhere in this 9:45-10:15 window, not
  // restricted to the 9:45-9:50 candle only. Every tick in this window
  // re-evaluates only the latest closed 5-min bar (see runOrbWatcherV2's
  // closedBars logic); once a symbol fires, v2:orb:alerted:{date}:{symbol}
  // locks out any further candles for that symbol for the rest of the day.
  if (total >= 585 && total <= 615) {
    await runOrbWatcherV2();
  }

  // TASK 3 — news watcher: every ~30 min, 9:30am-4pm ET.
  if (total >= 570 && total <= 960 && (lastNewsWatcherV2Total === null || total - lastNewsWatcherV2Total >= 30)) {
    lastNewsWatcherV2Total = total;
    await runNewsWatcherV2();
  }

  // TASK 4 — 200 EMA watcher: once at 10am ET.
  if (total >= 600 && total < 610 && !v2Ema200Done) {
    await runEma200WatcherV2();
  }

  // AGENT 2 — MASTER AGENT: 9am/11am/1pm/3pm CT = 10am/12pm/2pm/4pm ET
  // (CT+1=ET, same convention this project uses everywhere else) —
  // explicitly given in CT in the spec, unlike every other v2 time above.
  // BLOCKING FIX 1 (2026-07-21) — 4th slot moved from et:960 (4:00pm ET,
  // the market close) to et:955 (3:55pm ET). At the literal close,
  // prices are already stale relative to the 5-min freshness check by
  // the time this slot's price fetches actually run — 3:55pm ET runs
  // while the market is still open, so prices are genuinely fresh.
  // Label kept as "3pm CT" (unchanged) since that's the KV/log key
  // identifying this slot, not a literal display of its ET time.
  const V2_MASTER_SLOTS_ET = [
    { et: 600, label: "9am CT" },
    { et: 720, label: "11am CT" },
    { et: 840, label: "1pm CT" },
    { et: 955, label: "3pm CT" },
  ];
  for (const slot of V2_MASTER_SLOTS_ET) {
    if (total >= slot.et && total < slot.et + 10 && !v2MasterSlots.includes(slot.label)) {
      // CRITICAL FIX 3 (2026-07-20) — used to push/persist the slot as
      // done BEFORE calling runMasterAgentV2 at all. If the call then
      // failed, the slot was still permanently marked complete — a
      // restart (or just the in-memory flag) would never retry it.
      // Now only marked done after a confirmed successful return.
      const success = await runMasterAgentV2(slot.label);
      if (success) {
        v2MasterSlots.push(slot.label);
        // Persist to KV, not just the in-memory array, so a Render
        // restart between slots doesn't forget an earlier slot already
        // completed today. Read back at boot by restoreV2StateFromKV().
        await kvSet(`v2:master:slots:${todayETDate()}`, v2MasterSlots);
      } else {
        console.error(`v2 MASTER AGENT (${slot.label}) did not complete successfully — not marking done, will retry next tick within this window`);
      }
    }
  }

  // INTRADAY SCANNER — 2026-07-12 scanner split. Runs unconditionally
  // every tick, 9:30am-4pm ET (total 570-960), no slot/window restriction
  // — literally every 5 minutes, independent of whatever else fires below.
  // Deliberately does NOT `return` after running, so the rest of the
  // (mutually-exclusive, one-thing-per-tick) chain below can still also
  // act on the same tick.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runIntradayScannerCheck() itself is left completely intact.
  // if (total >= 570 && total <= 960) {
  //   await runIntradayScannerCheck();
  // }

  // ORB-NEW — 2026-07-17. Every 5 minutes, 9:45am-11:00am ET only
  // (total 585-660). Non-returning, same reasoning as the intraday
  // scanner above — must not get starved by the mutually-exclusive
  // return-based chain further down.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Not in the original named list (this function
  // didn't exist yet when that list was written 2026-07-17) but it's a
  // scheduled function call, so it's included here too — flagging this
  // explicitly since it wasn't named. runOrbNewCheck() itself is left
  // completely intact.
  // if (total >= 585 && total <= 660) {
  //   await runOrbNewCheck();
  // }

  // Economic release auto-summary — every ~15 min, 8am-4pm ET, covers both
  // the 8:30am (CPI/NFP/GDP) and 2pm (FOMC) release windows. Elapsed-time
  // tracking, not modulo — same reasoning as the intraday watchlist build
  // below (a Render restart at an arbitrary offset shouldn't silently skip
  // this for the rest of the day). Non-returning, same as the intraday
  // scanner above, so it never gets starved by the mutually-exclusive
  // return-based chain further down.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runEconReleaseCheck() itself is left completely intact.
  // if (total >= 480 && total <= 960 && (lastEconReleaseCheckTotal === null || total - lastEconReleaseCheckTotal >= 15)) {
  //   lastEconReleaseCheckTotal = total;
  //   await runEconReleaseCheck(String(total));
  // }

  // Earnings reaction check — once/day, ~9:50am ET (590 = 9:50am, safely
  // past 9:45 = 15 min post-open, within the worker's 5-min tick grid).
  // Non-returning, same reasoning as the intraday scanner/econ-release
  // checks above.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runEarningsReactionCheck() itself is left completely intact.
  // if (total >= 590 && !earningsReactionCheckDone) {
  //   earningsReactionCheckDone = true;
  //   await runEarningsReactionCheck();
  // }

  // BTC momentum — every ~30 min during market hours (9:30am-4pm ET), per spec.
  // 2026-07-18 — ALL CRYPTO ALERTS DISABLED per explicit instruction.
  // Comment out to re-enable, do not delete. runBtcMomentumCheck() itself
  // is left completely intact, only this call site is disabled.
  // if (total >= 570 && total <= 960 && (lastBtcMomentumCheckTotal === null || total - lastBtcMomentumCheckTotal >= 30)) {
  //   lastBtcMomentumCheckTotal = total;
  //   await runBtcMomentumCheck(String(total));
  // }

  // Pre-market watchlist: 8:20am ET (7:20am CT) — moved from 9:00am 2026-07-08
  // to give more lead time before the 9:30am open.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Not in the original named list, and worth being
  // explicit about the distinction: this is the WORKER's own pre-market
  // message, a completely different system from the Vercel-cron
  // morning-brief that stays running (CLAUDE.md Common Problems #7 warns
  // about conflating these two) — "keep morning-brief" does not mean keep
  // this. runPremarketScan() itself is left completely intact.
  // if (total >= 500 && total < 510 && !premarketDone) {
  //   await runPremarketScan();
  //   return;
  // }

  // Daily watchlist (List 2) build — 9:00am ET, once, well before the
  // 10am daily scanner needs it.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Not in the original named list (it sends no
  // Telegram itself, just builds/caches a KV watchlist) but it's a
  // scheduled function call, so disabled here too for completeness —
  // harmless to disable since nothing downstream will read it while
  // every scanner that consumes it is also disabled. runDailyWatchlistBuild()
  // itself is left completely intact.
  // if (total >= 540 && total < 550 && !dailyWatchlistBuildDone) {
  //   await runDailyWatchlistBuild();
  //   return;
  // }

  // Intraday watchlist (List 1) build — every ~30 min, 9:30am-4pm ET,
  // matching the intraday scanner's own window. Elapsed-time tracking
  // (not modulo — see the scored ORB breakout check further down for why
  // modulo-based scheduling silently breaks across an arbitrary Render
  // restart offset).
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Same reasoning as the daily watchlist build
  // above — not in the original named list, no Telegram of its own, but
  // disabled here too for completeness. runIntradayWatchlistBuild() itself
  // is left completely intact.
  // if (total >= 570 && total <= 960 && (lastIntradayWatchlistBuildTotal === null || total - lastIntradayWatchlistBuildTotal >= 30)) {
  //   lastIntradayWatchlistBuildTotal = total;
  //   await runIntradayWatchlistBuild(String(total));
  //   return;
  // }

  // Breaking news check: every 15 minutes, 8:00am-4:00pm ET (tightened from
  // 30 min 2026-07-13 so time-sensitive headlines don't sit for half an hour).
  if (total >= 480 && total <= 960 && total % 15 === 0 && !breakingNewsSlots.includes(String(total))) {
    await runBreakingNewsCheck(String(total));
    return;
  }

  // Main scan: 10:00am ET (9:00am CT) — after opening noise settles
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runMarketScan() itself is left completely intact.
  // if (total >= 600 && total < 630 && !marketScanSlots.includes("10:00")) {
  //   await runMarketScan("10:00");
  //   return;
  // }

  // 2026-07-17 — sector selloff alerts disabled entirely (call site
  // commented out, runSectorSelloffCheck() left intact). "Sector alerts"
  // don't exist as a distinct type inside intraday/route.ts or
  // ideas/route.ts (only contextual sector-strength lines woven into
  // other alert types' messages) — the real sender is this worker-side
  // call to the separate /api/options/sector-selloff route.
  // if (total >= 600 && total < 630 && !sectorSelloffDone) {
  //   await runSectorSelloffCheck();
  //   return;
  // }

  // LEAP scan check — 10am ET, once/day. Daily-bar 20 EMA pullback scanner.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runLeapScanCheck() itself is left completely intact.
  // if (total >= 600 && total < 630 && !leapScanDone) {
  //   await runLeapScanCheck();
  //   return;
  // }

  // DAILY SCANNER — 2026-07-12 scanner split. Once at the 10am ET window,
  // same slot as sector selloff/LEAP scan above.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runDailyScannerCheck() itself is left completely intact.
  // if (total >= 600 && total < 630 && !dailyScannerDone) {
  //   await runDailyScannerCheck();
  //   return;
  // }

  // ORB range capture: 10:30am ET — records each watchlist symbol's
  // opening 60-minute candle high/low right as it closes. OLD 60-min
  // scored ORB system, untouched by the scanner split.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runOrbCapture() itself is left completely intact.
  // if (total >= 630 && total < 640 && !orbCaptureDone) {
  //   await runOrbCapture();
  //   return;
  // }

  // Opening Hour Signal: 10:35am ET — right after the first 60-minute
  // candle (9:30-10:30am) closes.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runOpeningSignalCheck() itself is left completely intact.
  // if (total >= 635 && total < 660 && !openingSignalDone) {
  //   await runOpeningSignalCheck();
  //   return;
  // }

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
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runOrbBreakoutCheck() itself is left completely intact.
  // if (total >= 630 && total <= 840 && (lastOrbBreakoutTotal === null || total - lastOrbBreakoutTotal >= 15)) {
  //   lastOrbBreakoutTotal = total;
  //   await runOrbBreakoutCheck(String(total));
  //   return;
  // }

  // Afternoon scan: 1:00pm ET — catches moves that develop after the
  // 10am window, which the old two-scan-a-day schedule always missed.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runMarketScan() itself is left completely intact.
  // if (total >= 780 && total < 810 && !marketScanSlots.includes("13:00")) {
  //   await runMarketScan("13:00");
  //   return;
  // }

  // Late-afternoon scan: 3:30pm ET — last chance before the 4pm close.
  // 2026-07-18 — STOP EVERYTHING except breaking news + morning-brief per
  // explicit instruction. Comment out to re-enable, do not delete.
  // runMarketScan() itself is left completely intact.
  // if (total >= 930 && total < 960 && !marketScanSlots.includes("15:30")) {
  //   await runMarketScan("15:30");
  //   return;
  // }

  const { hour: h, min: m } = getET();
  console.log(`[${h}:${String(m).padStart(2,"0")} ET] Waiting for next scan window...`);
}

console.log("FlexAI Stock Monitor v5 — fully dynamic watchlists 2026-07-14");
console.log("2026-07-18: STOPPED EVERYTHING except breaking news check (every 15min, 8am-4pm ET) per explicit instruction. Every other scheduled call site in tick() is commented out — all underlying functions left intact for re-enabling later.");
// FIX 7 (2026-07-19) — restore v2 in-memory state from KV before the
// first tick() runs, so a mid-window restart doesn't re-run a task that
// already completed earlier today. setInterval still starts on the same
// 5-min cadence as before, just after this one-time restore resolves.
(async () => {
  await restoreV2StateFromKV();
  tick();
  setInterval(tick, 5 * 60 * 1000);
})();
