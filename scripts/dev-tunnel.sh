#!/usr/bin/env bash
# Exposes the local API (localhost:8000) to the phone through a Cloudflare quick tunnel.
# Free, no account. The URL changes on every run, so this writes it to mobile/.env.
# Usage: start the API first (cd api && uv run uvicorn app.main:app --reload --port 8000),
# then run scripts/dev-tunnel.sh and restart Metro so the app picks up the new URL.
set -euo pipefail

PORT="${1:-8000}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/mobile/.env"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

command -v cloudflared >/dev/null || { echo "cloudflared not found (expected in ~/.local/bin)"; exit 1; }

cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null; rm -f "$LOG"' EXIT INT TERM

URL=""
for _ in $(seq 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "No tunnel URL after 30 s:"; cat "$LOG"; exit 1; }

if [ -f "$ENV_FILE" ] && grep -q '^EXPO_PUBLIC_API_URL=' "$ENV_FILE"; then
  sed -i "s|^EXPO_PUBLIC_API_URL=.*|EXPO_PUBLIC_API_URL=$URL|" "$ENV_FILE"
  echo "Updated mobile/.env. Restart Metro to use it."
else
  echo "Set EXPO_PUBLIC_API_URL=$URL in mobile/.env, then restart Metro."
fi
echo "API tunnel: $URL  (Ctrl+C to stop)"
wait "$PID"
