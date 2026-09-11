#!/bin/bash
# Wrapper script for systemd — runs node server + cloudflared tunnel
cd "$(dirname "$0")"
source ./tunnel.sh

# Start node server
node server.js &
SERVER_PID=$!

# Start cloudflared with restart watchdog
start_tunnel_watchdog

# Trap signals to kill both
cleanup() {
  kill "$SERVER_PID" $TUNNEL_LOOP_PID 2>/dev/null
  tunnel_stop
  wait 2>/dev/null
}
trap cleanup SIGTERM SIGINT

# Wait for the server to exit
wait $SERVER_PID