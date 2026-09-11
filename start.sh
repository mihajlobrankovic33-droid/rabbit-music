#!/bin/bash
# Rabbit Music - Startup Script
# Run this to start your music server + internet tunnel

cd "$(dirname "$0")"
source ./tunnel.sh

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║     🐇 Rabbit Music Server       ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
  echo ""
fi

# Generate icons
node create-icons.js 2>/dev/null

# Ensure yt-dlp is present (bundled binary for reliable streaming)
if [ ! -f "bin/yt-dlp" ]; then
  echo "  Downloading yt-dlp..."
  mkdir -p bin
  curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
  chmod +x bin/yt-dlp
  echo ""
fi

# Ensure cloudflared is present (tunnel for mobile data access)
if [ ! -f "bin/cloudflared" ]; then
  echo "  Downloading cloudflared..."
  mkdir -p bin
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o bin/cloudflared
  chmod +x bin/cloudflared
  echo ""
fi

# Start the Node server
node server.js &
SERVER_PID=$!

# Start cloudflared with restart watchdog
start_tunnel_watchdog

# Wait for the tunnel URL (up to ~60s), then print the box
wait_for_tunnel_url 60
TUNNEL_URL=$(tunnel_url)

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "  ╔══════════════════════════════════════════════════════════════════╗"
echo "  ║                    🎵 Rabbit Music is running                       ║"
echo "  ╠═══════════════════════════════════════════════════════════════════╣"
echo "  ║  On this laptop:      http://localhost:3000                        ║"
[ -n "$LOCAL_IP" ] && echo "  ║  Same Wi-Fi:           http://${LOCAL_IP}:3000                       ║"
echo "  ║                                                                     ║"
if [ -n "$TUNNEL_URL" ]; then
  echo "  ║  📱 ANYWHERE (mobile data):                                          ║"
  echo "  ║  → ${TUNNEL_URL}  ║"
  echo "  ║                                                                     ║"
  echo "  ║  Open the https://... trycloudflare.com URL on your phone.           ║"
  echo "  ║  Note: this URL changes each time the server restarts.               ║"
else
  echo "  ║  ⚠ Tunnel not ready yet (rate-limited?) — server still works        ║"
  echo "  ║  on this Wi-Fi. Watch /tmp/rabbit-music-tunnel.log.                 ║"
fi
echo "  ╚════════════════════════════════════════════════════════════════════╝"
echo ""

trap 'cleanup; trap - TERM; kill $SERVER_PID $TUNNEL_LOOP_PID 2>/dev/null' INT TERM

wait $SERVER_PID
cleanup