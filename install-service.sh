#!/bin/bash
# Rabbit Music - install as a persistent systemd service (like Jellyfin)
# Run this once with sudo. The server will:
#   - auto-start on boot
#   - never die when the terminal closes
#   - auto-restart if it crashes

set -e

SERVICE="rabbit-music"
FOLDER="/home/mihe/Documents/Default Project/rabbit music"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   🐰 Rabbit Music Service Install     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Stop any manually-run servers on port 3000
echo "  Stopping any running instances..."
fuser -k 3000/tcp 2>/dev/null || true
sleep 1

# Copy the service file to systemd
echo "  Installing systemd service..."
sudo cp "${FOLDER}/rabbit-music.service" "/etc/systemd/system/${SERVICE}.service"

# Make sure node & deps are present
if [ ! -d "${FOLDER}/node_modules" ]; then
  echo "  Installing dependencies..."
  (cd "${FOLDER}" && npm install)
fi

# Make sure yt-dlp is present
if [ ! -f "${FOLDER}/bin/yt-dlp" ]; then
  echo "  Downloading yt-dlp..."
  mkdir -p "${FOLDER}/bin"
  curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${FOLDER}/bin/yt-dlp"
  chmod +x "${FOLDER}/bin/yt-dlp"
fi

# Reload systemd, enable + start
echo "  Enabling service (auto-start on boot)..."
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE}"
sudo systemctl start "${SERVICE}"

sleep 2

# Report status
echo ""
echo "  ──────────────────────────────────────"
if sudo systemctl is-active --quiet "${SERVICE}"; then
  echo "  ✅ Rabbit Music is RUNNING as a service"
  echo "     It will survive terminal close + reboot"
else
  echo "  ❌ Failed to start — check: sudo journalctl -u ${SERVICE} -n 50"
fi
sudo systemctl status "${SERVICE}" --no-pager -l | head -12 || true
echo "  ──────────────────────────────────────"
echo ""
echo "  Useful commands:"
echo "    sudo systemctl status ${SERVICE}    # check status"
echo "    sudo systemctl restart ${SERVICE}   # restart server"
echo "    sudo systemctl stop ${SERVICE}      # stop server"
echo "    sudo journalctl -u ${SERVICE} -f    # live logs"
echo ""