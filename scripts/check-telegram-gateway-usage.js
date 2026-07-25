#!/usr/bin/env node
// Staged CI enforcement (2026-07-25) for the Telegram delivery gateway
// migration. This repo is a single file (index.js), so growth is
// tracked by call-site COUNT against a baseline rather than a per-file
// allowlist (see telegram-direct-send-baseline.json for the full
// reasoning). Fails the deploy if the count of direct
// sendTelegram/sendTelegramWithId calls exceeds the recorded maximum --
// migration should only ever move this number down, never up.
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(REPO_ROOT, "index.js");
const BASELINE_PATH = path.join(__dirname, "telegram-direct-send-baseline.json");

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
  const content = fs.readFileSync(INDEX_PATH, "utf-8");
  const matches = content.match(/\bawait\s+sendTelegram(?:WithId)?\s*\(/g) || [];
  const count = matches.length;

  if (count > baseline.maxDirectSendCallSites) {
    console.error("\n❌ Telegram gateway policy check FAILED.\n");
    console.error(`index.js now has ${count} direct sendTelegram/sendTelegramWithId call sites,`);
    console.error(`exceeding the recorded baseline of ${baseline.maxDirectSendCallSites}.\n`);
    console.error("New Telegram sends should go through gatewaySendTelegram (the delivery");
    console.error("gateway client) instead of calling sendTelegram/sendTelegramWithId directly.");
    console.error("If this increase is a deliberately-reviewed exception (e.g. the one narrow");
    console.error("notifyGatewayUnreachableOnce ops-notification case), update");
    console.error("scripts/telegram-direct-send-baseline.json explicitly in the same commit --");
    console.error("do not bump it just to silence this check without review.\n");
    process.exit(1);
  }

  console.log(`✅ Telegram gateway policy check passed (${count} direct call sites, baseline ${baseline.maxDirectSendCallSites}).`);
  if (count < baseline.maxDirectSendCallSites) {
    console.log(`   Note: count is below baseline -- if this reflects real migration progress, lower the baseline to lock in the improvement.`);
  }
}

main();
