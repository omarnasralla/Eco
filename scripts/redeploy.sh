#!/usr/bin/env bash
#
# Rebuild and restart the API and web server on the VM.
#
# Written after a hand-rolled restart took the app down. Two hazards it exists
# to remove:
#
#   1. `kill $(pgrep -f "node dist/main.js")` also matches the shell running
#      that very command, so the pipeline kills itself part-way through. It did
#      exactly that between an `rm -rf .next/static` and the `cp` meant to
#      replace it, leaving every JavaScript chunk a 404 and the app a blank
#      page. Here the shell's own process tree is excluded from the match.
#
#   2. Next's standalone output does not include `static/` or `public/`; they
#      have to be copied in beside it. Removing the old copy before writing the
#      new one leaves a window with no assets at all, so the new directory is
#      staged alongside and swapped in with a rename.
#
# Usage: scripts/redeploy.sh [api|web|all]   (default: all)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STANDALONE="$ROOT/apps/web/.next/standalone/apps/web"
LOG_DIR="${ECO_LOG_DIR:-/var/log/eco}"
TARGET="${1:-all}"

mkdir -p "$LOG_DIR"

# Kill by pattern without matching this script or its own subshells.
stop() {
  local pattern="$1" name="$2" pids=()
  while read -r pid; do
    [[ -z "$pid" || "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    pids+=("$pid")
  done < <(pgrep -f "$pattern" | grep -v -x "$$" || true)

  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "  $name: not running"
    return
  fi
  kill "${pids[@]}" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "${pids[@]}" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "${pids[@]}" 2>/dev/null || true
  echo "  $name: stopped (${pids[*]})"
}

# Start a server fully detached.
#
# `setsid --fork` matters: plain `setsid` forks and *waits* when it is already
# a process group leader, leaving a shell that holds this script's stdout open
# — so the script never appears to finish. All three descriptors are redirected
# so nothing inherits the terminal either.
start() {
  local dir="$1" cmd="$2" log="$3"
  ( cd "$dir" && setsid --fork $cmd >"$log" 2>&1 </dev/null )
}

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
  stop "node dist/main.js" api
  start "$ROOT/apps/api" "node dist/main.js" "$LOG_DIR/api.log"
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

  stop "next-server" web
  PORT=3000 HOSTNAME=127.0.0.1 start "$STANDALONE" "node server.js" "$LOG_DIR/web.log"
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
