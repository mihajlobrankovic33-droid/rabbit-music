#!/bin/bash
# Rabbit Music — shared tunnel logic (sourced by start.sh and run.sh)
# Quick tunnels have no uptime guarantee, so we restart cloudflared with backoff.

TUNNEL_LOG=/tmp/rabbit-music-tunnel.log
TUNNEL_URL_FILE="$(dirname "$0")/tunnel_url.log"
TUNNEL_LOOP_PID=""

tunnel_url() {
  head -1 "$TUNNEL_URL_FILE" 2>/dev/null
}

_tunnel_url_from_log() {
  grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null \
    | grep -v "api\.trycloudflare\.com" | tail -1
}

# Start cloudflared and keep it running (restart with backoff if it dies)
start_tunnel_watchdog() {
  (
    while true; do
      : > "$TUNNEL_LOG"
      START_TS=$(date +%s)
      bin/cloudflared tunnel --url http://localhost:3000 --no-autoupdate >> "$TUNNEL_LOG" 2>&1 &
      TUNNEL_PID=$!

      # Wait for the quick tunnel URL (up to ~60s)
      FOUND=""
      for i in $(seq 1 60); do
        U=$(_tunnel_url_from_log)
        if [ -n "$U" ]; then
          FOUND="$U"
          break
        fi
        kill -0 "$TUNNEL_PID" 2>/dev/null || break
        sleep 1
      done
      if [ -n "$FOUND" ]; then
        echo "$FOUND" > "$TUNNEL_URL_FILE"
        echo "[tunnel] Public URL: $FOUND" >> "$TUNNEL_LOG"
      fi

      # Wait until cloudflared exits, then retry
      wait "$TUNNEL_PID" 2>/dev/null
      rm -f "$TUNNEL_URL_FILE"
      ELAPSED=$(($(date +%s) - START_TS))
      if [ "$ELAPSED" -lt 15 ]; then
        # exited instantly = rejected/rate-limited — back off longer
        sleep 90
      else
        echo "[tunnel] reconnecting in 30s..." >> "$TUNNEL_LOG"
        sleep 30
      fi
    done
  ) &
  TUNNEL_LOOP_PID=$!
}

# Wait up to N seconds for a tunnel URL
wait_for_tunnel_url() {
  local n="${1:-60}"
  for i in $(seq 1 "$n"); do
    [ -n "$(tunnel_url)" ] && return 0
    sleep 1
  done
  return 1
}

tunnel_stop() {
  [ -n "$TUNNEL_LOOP_PID" ] && kill "$TUNNEL_LOOP_PID" 2>/dev/null
  pkill -f "cloudflared tunnel --url" 2>/dev/null
}