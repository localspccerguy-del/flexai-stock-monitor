#!/usr/bin/env node
// Staged CI enforcement (2026-07-25, refined in second review pass) for
// the Telegram delivery gateway migration. This repo is a single file
// (index.js), so growth is tracked two ways:
//   1. LEGACY call sites (pending migration): a simple count against a
//      baseline that should only ever go DOWN as senders migrate.
//   2. NAMED EXCEPTIONS (permanent, architecturally-required direct
//      sends, e.g. the gateway-issue-notification meta-alert): each must
//      be marked in index.js with `// TELEGRAM-DIRECT-SEND-EXCEPTION: <name>`
//      on the line immediately before (within a couple lines of) the
//      actual sendTelegram call, and <name> must have an exact 1:1
//      match against telegram-direct-send-exceptions.json.
//
// Real bug found while building this: a naive whole-file regex scan for
// the marker string also matched this file's own PROSE explanation of
// the marker convention (which necessarily contains the same text),
// double-counting one real exception as two. Fixed by requiring
// PROXIMITY -- a marker only counts if an actual `await sendTelegram(`
// call appears within the next few lines, not just anywhere the marker
// text appears in a comment.
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(REPO_ROOT, "index.js");
const BASELINE_PATH = path.join(__dirname, "telegram-direct-send-baseline.json");
const EXCEPTIONS_PATH = path.join(__dirname, "telegram-direct-send-exceptions.json");

const CALL_PATTERN = /\bawait\s+sendTelegram(?:WithId)?\s*\(/;
const MARKER_LINE_PATTERN = /^\s*\/\/\s*TELEGRAM-DIRECT-SEND-EXCEPTION:\s*([a-z0-9-]+)\s*$/i;
const PROXIMITY_LINES = 3;

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
  const exceptions = JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, "utf-8"));
  const approvedNames = new Set(exceptions.approvedExceptions.map((e) => e.name));

  const lines = fs.readFileSync(INDEX_PATH, "utf-8").split("\n");

  const totalCallSites = lines.filter((l) => CALL_PATTERN.test(l)).length;

  const markersFound = [];
  const markerLineIndexes = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_LINE_PATTERN);
    if (!m) continue;
    const name = m[1];
    const hasNearbyCall = lines.slice(i, i + 1 + PROXIMITY_LINES).some((l) => CALL_PATTERN.test(l));
    if (hasNearbyCall) {
      markersFound.push(name);
      markerLineIndexes.add(i);
    }
  }

  const errors = [];

  for (const name of markersFound) {
    if (!approvedNames.has(name)) {
      errors.push(`Found marker "// TELEGRAM-DIRECT-SEND-EXCEPTION: ${name}" next to a real sendTelegram call in index.js, but "${name}" is not in the approved registry (${path.relative(REPO_ROOT, EXCEPTIONS_PATH)}). Add it there explicitly if this is a deliberately-reviewed exception, or remove the marker if it isn't.`);
    }
  }
  for (const name of approvedNames) {
    if (!markersFound.includes(name)) {
      errors.push(`Registry entry "${name}" in ${path.relative(REPO_ROOT, EXCEPTIONS_PATH)} has no matching "// TELEGRAM-DIRECT-SEND-EXCEPTION: ${name}" marker next to a real sendTelegram call in index.js. Remove the stale registry entry, or restore the marker.`);
    }
  }

  const legacyCount = totalCallSites - markersFound.length;

  if (legacyCount > baseline.maxDirectSendCallSites) {
    errors.push(`index.js now has ${legacyCount} LEGACY direct sendTelegram/sendTelegramWithId call sites (${totalCallSites} total minus ${markersFound.length} named exceptions), exceeding the recorded baseline of ${baseline.maxDirectSendCallSites}. New Telegram sends should go through gatewaySendTelegram instead of calling sendTelegram/sendTelegramWithId directly. A genuinely new, architecturally-required exception must be added to the named-exceptions registry explicitly, not folded into this baseline.`);
  }

  if (errors.length > 0) {
    console.error("\n❌ Telegram gateway policy check FAILED.\n");
    for (const e of errors) console.error(`  - ${e}\n`);
    process.exit(1);
  }

  console.log(`✅ Telegram gateway policy check passed (${legacyCount} legacy call sites [baseline ${baseline.maxDirectSendCallSites}], ${markersFound.length} named exception(s) matched 1:1 against the registry).`);
  if (legacyCount < baseline.maxDirectSendCallSites) {
    console.log(`   Note: legacy count is below baseline -- if this reflects real migration progress, lower the baseline to lock in the improvement.`);
  }
}

main();
