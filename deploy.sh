#!/bin/bash
cd ~/Downloads/flexai-stock-monitor
git init 2>/dev/null || true
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/localspccerguy-del/flexai-stock-monitor.git
git add .
git commit -m "${1:-Deploy stock monitor}"
git push -f origin main
curl -X POST "https://api.render.com/deploy/srv-d8nkk0pkh4rs73fagfe0?key=UAp3MAcjpFc"
echo "Deployed to Render!"
