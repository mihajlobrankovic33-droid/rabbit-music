#!/bin/bash
# Installs Tailscale on this laptop so Rabbit Music works from any network.
# Run:  sudo ./install-tailscale.sh
# (This is the ONE step you have to run yourself, because it needs sudo.)

set -e

echo ""
echo "  Installing Tailscale..."
curl -fsSL https://tailscale.com/install.sh | sh

echo ""
echo "  Starting Tailscale — a browser link will appear..."
echo "  Sign in there with the SAME account you will use on your phone."
echo "  (this step stays waiting for you until you finish)"
echo ""
tailscale up

echo ""
echo "  ✅ Tailscale is connected!"
echo "  Laptop IP:      $(tailscale ip -4 2>/dev/null)"
echo "  Tailnet name:   $(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | cut -d'"' -f4)"
echo ""
echo "  Now on your PHONE:"
echo "  1. Install the Tailscale app from the App Store"
echo "  2. Sign in with the SAME account"
echo "  3. Tailscale connects automatically"
echo ""
echo "  Done — tell the assistant everything is connected."