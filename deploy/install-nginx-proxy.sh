#!/usr/bin/env bash
# Optional: install the Hybrid studio nginx site on a dedicated Linux host.
# Skip on Runpod pytorch images — Jupyter already owns nginx on :80, and
# the public API is https://<pod>-8000.proxy.runpod.net
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/deploy/nginx-hybrid-studio.conf"
if [ ! -f "$SRC" ]; then
  echo "missing $SRC"
  exit 1
fi
if [ -f /etc/nginx/sites-available/jupyter ] || pgrep -f jupyter >/dev/null 2>&1; then
  echo "Jupyter/nginx already present. Not installing a competing :80 site."
  echo "Use the Runpod HTTP proxy for port 8000 instead."
  exit 0
fi
install -m 644 "$SRC" /etc/nginx/sites-available/hybrid_studio
ln -sfn /etc/nginx/sites-available/hybrid_studio /etc/nginx/sites-enabled/hybrid_studio
nginx -t
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload nginx
else
  nginx -s reload
fi
echo "nginx hybrid_studio site enabled"
