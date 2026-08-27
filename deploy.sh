#!/bin/bash
set -e
cd ~/Downloads/flexai-stock-monitor
node --check index.js
node scripts/check-telegram-gateway-usage.js
git add .
git commit -m "${1:-Update stock monitor}"
git push origin main
DEPLOYED_SHA=$(git rev-parse HEAD)
if [ -z "$RENDER_DEPLOY_HOOK_URL" ]; then
  echo "ERROR: RENDER_DEPLOY_HOOK_URL not set"
  exit 1
fi
curl "$RENDER_DEPLOY_HOOK_URL"
echo "Deployed to Render!"

# 2026-08-27 (Codex review, system-watchdog commit verification) -- write
# the just-pushed SHA to KV from OUTSIDE the worker process, independent
# of whatever the worker itself later believes it's running. The watchdog
# (runV3SystemWatchdogJob) compares this against the worker's own
# heartbeat SHA -- a mismatch means Render silently failed to actually
# roll out this deploy, which comparing the worker's env var to its own
# heartbeat could never catch (a stale process is self-consistent about
# itself by construction). Best-effort: a missing/failed write here just
# means the watchdog reports "COMMIT VERIFICATION UNAVAILABLE" instead of
# a false "stale" or a false "match" -- never silently skipped without a
# trace, but also never fatal to the deploy itself.
if [ -f ~/Downloads/flexai-saas/.env.local ]; then
  KV_URL=$(grep '^KV_REST_API_URL=' ~/Downloads/flexai-saas/.env.local | head -1 | cut -d= -f2-)
  KV_TOKEN=$(grep '^KV_REST_API_TOKEN=' ~/Downloads/flexai-saas/.env.local | head -1 | cut -d= -f2-)
  if [ -n "$KV_URL" ] && [ -n "$KV_TOKEN" ]; then
    DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    curl -s -X POST "$KV_URL/set/v3:deploy:expectedCommit" \
      -H "Authorization: Bearer $KV_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"sha\":\"$DEPLOYED_SHA\",\"deployedAt\":\"$DEPLOYED_AT\"}" > /dev/null
    echo "Recorded expected deploy SHA in KV: $DEPLOYED_SHA"
  else
    echo "WARNING: KV_REST_API_URL/KV_REST_API_TOKEN not found in flexai-saas/.env.local -- expected-deploy-SHA record NOT written. The watchdog will report COMMIT VERIFICATION UNAVAILABLE until this succeeds."
  fi
else
  echo "WARNING: flexai-saas/.env.local not found -- expected-deploy-SHA record NOT written."
fi
