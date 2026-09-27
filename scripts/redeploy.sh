#!/usr/bin/env bash
#
# Rebuild and restart the API and web server on the VM.
#
# Both run as systemd units — eco-api and eco-web — so this script builds and
# then hands the restart to systemctl. It does not start or stop processes
# itself, and that is the point of two separate repairs:
#
#   1. This script used to kill by pattern, and `pgrep -f "node dist/main.js"`
#      matches the shell running that very command, so the pipeline killed
#      itself part-way through. It did exactly that between an
#      `rm -rf .next/static` and the `cp` meant to replace it, leaving every
#      JavaScript chunk a 404 and the app a blank page. systemd kills by cgroup
#      and cannot make that mistake.
#
#   2. Processes started from a shell do not survive a reboot. An unattended
#      kernel upgrade restarted this machine on 2026-09-22; the containers came
#      back on their own restart policies, so Caddy answered and returned 502
#      for a day while nothing listened on 3000 or 9000. The units are enabled,
#      so both now start at boot and restart on crash.
#
# The one hazard left for this script to handle is its own:
#
#   3. Next's standalone output does not include `static/` or `public/`; they
#      have to be copied in beside it. Removing the old copy before writing the
#      new one leaves a window with no assets at all, so the new directory is
#      staged alongside and swapped in with a rename.
#
# Usage: scripts/redeploy.sh [api|web|all]   (default: all)
#
# Logs are where they always were — $ECO_LOG_DIR, default /var/log/eco — because
# the units append there rather than writing to the journal.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STANDALONE="$ROOT/apps/web/.next/standalone/apps/web"
LOG_DIR="${ECO_LOG_DIR:-/var/log/eco}"
TARGET="${1:-all}"

mkdir -p "$LOG_DIR"

wait_for() {
  local url="$1" name="$2"
  for _ in {1..40}; do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" == "200" ]]; then
      echo "  $name: up"
      return 0
    fi
    sleep 1
  done
  echo "  $name: DID NOT COME UP — see $LOG_DIR" >&2
  return 1
}

if [[ "$TARGET" == "api" || "$TARGET" == "all" ]]; then
  echo "Building API…"
  npm run build --workspace @eco/api --prefix "$ROOT"
  systemctl restart eco-api
  wait_for "http://127.0.0.1:9000/eco/api/v1/health/live" api
fi

if [[ "$TARGET" == "web" || "$TARGET" == "all" ]]; then
  echo "Building web…"
  npm run build --workspace @eco/web --prefix "$ROOT"

  # Stage, then swap: at no point is the live directory missing.
  rm -rf "$STANDALONE/.next/static.new"
  cp -r "$ROOT/apps/web/.next/static" "$STANDALONE/.next/static.new"
  rm -rf "$STANDALONE/.next/static.old"
  [[ -d "$STANDALONE/.next/static" ]] && mv "$STANDALONE/.next/static" "$STANDALONE/.next/static.old"
  mv "$STANDALONE/.next/static.new" "$STANDALONE/.next/static"
  rm -rf "$STANDALONE/.next/static.old"
  cp -r "$ROOT/apps/web/public" "$STANDALONE/" 2>/dev/null || true

  # PORT and HOSTNAME live in the unit, not here.
  systemctl restart eco-web
  wait_for "http://127.0.0.1:3000/eco/app/login" web
fi

echo
echo "Checking a JavaScript chunk actually serves — the failure mode that"
echo "looks like a crash but is really a missing static directory:"
CHUNK=$(curl -s -H 'Host: 169.58.227.114' http://127.0.0.1/eco/app/login \
  | grep -o '/eco/app/_next/static/chunks/[a-zA-Z0-9._-]*\.js' | head -1)
if [[ -n "$CHUNK" ]]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: 169.58.227.114' "http://127.0.0.1$CHUNK")
  echo "  $CHUNK -> $CODE"
  [[ "$CODE" == "200" ]] || { echo "  ASSETS ARE NOT SERVING" >&2; exit 1; }
fi
echo "Done."
