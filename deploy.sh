#!/bin/bash
set -e
cd ~/Downloads/flexai-stock-monitor
node --check index.js
node scripts/check-telegram-gateway-usage.js
git add .
git commit -m "${1:-Update stock monitor}"
git push origin main
if [ -z "$RENDER_DEPLOY_HOOK_URL" ]; then
  echo "ERROR: RENDER_DEPLOY_HOOK_URL not set"
  exit 1
fi
curl "$RENDER_DEPLOY_HOOK_URL"
echo "Deployed to Render!"
