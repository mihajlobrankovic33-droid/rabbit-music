#!/bin/bash
# Deploy the updated Rabbit Music service (server + internet tunnel)
cd "/home/mihe/Documents/Default Project/rabbit music"
cp -f rabbit-music.service /etc/systemd/system/rabbit-music.service
systemctl daemon-reload
pkill -f "cloudflared tunnel --url" 2>/dev/null
pkill -f "bash run.sh" 2>/dev/null
sleep 1
systemctl restart rabbit-music
systemctl daemon-reload
echo "deployed ok"