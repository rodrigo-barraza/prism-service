#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Fix Synology Nginx Reverse Proxy timeout for SSE streaming
# ─────────────────────────────────────────────────────────────
# Run this on the Synology via SSH:
#   ssh admin@<synology-ip>
#   sudo bash fix-synology-proxy-timeout.sh
#
# The Synology built-in reverse proxy (Nginx) defaults to a
# 5-minute proxy_read_timeout, which kills SSE streams that
# exceed that duration — even when data is flowing continuously.
# ─────────────────────────────────────────────────────────────

set -e

echo "=== Synology Nginx SSE Timeout Fix ==="
echo ""

# Find the reverse proxy config file
CONF_DIR="/etc/nginx"
CONF_FILE=""

# DSM 7 locations
for candidate in \
  "$CONF_DIR/sites-enabled/server.ReverseProxy.conf" \
  "$CONF_DIR/conf.d/server.ReverseProxy.conf" \
  "$CONF_DIR/app.d/server.ReverseProxy.conf"; do
  if [ -f "$candidate" ]; then
    CONF_FILE="$candidate"
    break
  fi
done

if [ -z "$CONF_FILE" ]; then
  echo "Could not find the reverse proxy config. Searching..."
  CONF_FILE=$(grep -rl "proxy_pass" "$CONF_DIR" 2>/dev/null | head -1)
fi

if [ -z "$CONF_FILE" ]; then
  echo "ERROR: No Nginx reverse proxy config found."
  echo "Try: grep -r 'proxy_pass' /etc/nginx/"
  exit 1
fi

echo "Found config: $CONF_FILE"
echo ""

# Show current proxy timeout settings
echo "Current proxy_read_timeout settings:"
grep -n "proxy_read_timeout" "$CONF_FILE" 2>/dev/null || echo "  (none found — using Nginx default: 60s)"
echo ""

# Check if our fix is already applied
if grep -q "proxy_read_timeout 86400" "$CONF_FILE"; then
  echo "Fix already applied. Nothing to do."
  exit 0
fi

# Back up
BACKUP="${CONF_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$CONF_FILE" "$BACKUP"
echo "Backed up to: $BACKUP"

# Find the location block that proxies to port 7777 (Prism) and inject timeout directives
# If no specific location block, add to the server block
if grep -q "7777" "$CONF_FILE"; then
  echo "Found Prism proxy (port 7777). Injecting timeout fix..."
  
  # Add timeout directives after the proxy_pass line for port 7777
  sed -i '/proxy_pass.*7777/a\        proxy_read_timeout 86400s;\n        proxy_send_timeout 86400s;\n        proxy_buffering off;\n        proxy_cache off;' "$CONF_FILE"
else
  echo "WARNING: Port 7777 not found in config. Adding global proxy timeout..."
  echo ""
  echo "You may need to manually add these lines to the correct location block:"
  echo "    proxy_read_timeout 86400s;"
  echo "    proxy_send_timeout 86400s;"
  echo "    proxy_buffering off;"
  echo "    proxy_cache off;"
  exit 1
fi

echo ""
echo "Verifying Nginx config..."
nginx -t 2>&1

echo ""
echo "Reloading Nginx..."
nginx -s reload || synosystemctl restart nginx 2>/dev/null || systemctl restart nginx 2>/dev/null

echo ""
echo "=== Done. SSE streams should now work without 5-minute timeout. ==="
