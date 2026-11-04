#!/usr/bin/env bash
# Exposes the local API (localhost:8000) to the phone through a Cloudflare quick tunnel.
# Free, no account. The URL changes on every run, so this writes it to mobile/.env.
# Usage: start the API first (cd api && uv run uvicorn app.main:app --reload --port 8000),
# then run scripts/dev-tunnel.sh and restart Metro so the app picks up the new URL.
set -euo pipefail

PORT="${1:-8000}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/mobile/.env"
LOG="$(mktemp)"

command -v cloudflared >/dev/null || { echo "cloudflared not found (expected in ~/.local/bin)"; exit 1; }

cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
PID=$!
ORIGINAL_API_LINE=""
URL=""
UPDATED=0
cleanup() {
  # Restore only our public API URL, and only if it still has our tunnel value.
  # Preserve all other settings and any URL the user changed while the tunnel ran.
  if [ "$UPDATED" = 1 ] && [ -f "$ENV_FILE" ] && grep -qxF "EXPO_PUBLIC_API_URL=$URL" "$ENV_FILE"; then
    WTE_ENV_PATH="$ENV_FILE" WTE_OLD_API_LINE="$ORIGINAL_API_LINE" python3 - <<'PY'
import os
from pathlib import Path
p = Path(os.environ['WTE_ENV_PATH'])
lines = p.read_bytes().splitlines(keepends=True)
p.write_bytes(b''.join(os.environ['WTE_OLD_API_LINE'].encode() + (b'\n' if line.endswith(b'\n') else b'')
                      if line.startswith(b'EXPO_PUBLIC_API_URL=') else line for line in lines))
PY
  fi
  kill "$PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for _ in $(seq 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "No tunnel URL after 30 s:"; cat "$LOG"; exit 1; }

if [ -f "$ENV_FILE" ] && grep -q '^EXPO_PUBLIC_API_URL=' "$ENV_FILE"; then
  [ "$(grep -c '^EXPO_PUBLIC_API_URL=' "$ENV_FILE")" = 1 ] || { echo "Multiple API URL settings; no change made."; exit 1; }
  ORIGINAL_API_LINE="$(grep '^EXPO_PUBLIC_API_URL=' "$ENV_FILE")"
  sed -i "s|^EXPO_PUBLIC_API_URL=.*|EXPO_PUBLIC_API_URL=$URL|" "$ENV_FILE"
  UPDATED=1
  echo "Updated mobile/.env. Restart Metro to use it."
else
  echo "Set EXPO_PUBLIC_API_URL=$URL in mobile/.env, then restart Metro."
fi
echo "API tunnel: $URL  (Ctrl+C to stop)"
wait "$PID"
