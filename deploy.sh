#!/bin/bash
cd ~/Downloads/flexai-stock-monitor
git add .
git commit -m "${1:-Update stock monitor}"
git push origin main
curl -X POST "https://api.render.com/deploy/srv-d8sl5fr6sc1c73ckjqgg?key=QXeKHmLEdZY"
echo "Deployed to Render!"
