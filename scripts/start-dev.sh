#!/usr/bin/env bash
# Ensure the Vite dev server is running for this project, then open it in
# Safari. Reuses an already-running server (however it was started) if one
# is found on this project's directory; otherwise starts a fresh one on the
# first free port from 5173 up.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$PROJECT_DIR/.dev-server.log"

# Look for a running `vite` process whose working directory is this project,
# and return the port it's listening on.
find_running_port() {
  local pid cwd port
  for pid in $(pgrep -f "vite" 2>/dev/null || true); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    [ "$cwd" = "$PROJECT_DIR" ] || continue
    port=$(lsof -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null \
      | sed -n -E 's/^n.*:([0-9]+)$/\1/p' | head -1)
    if [ -n "$port" ]; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

port_is_free() {
  ! lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local port=5173
  while ! port_is_free "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

PORT="$(find_running_port || true)"

if [ -n "${PORT:-}" ]; then
  echo "Dev server already running on port $PORT"
else
  PORT="$(find_free_port)"
  echo "Starting dev server on port $PORT (log: $LOG_FILE)..."
  (cd "$PROJECT_DIR" && nohup npm run dev -- --port "$PORT" --strictPort \
    >"$LOG_FILE" 2>&1 & disown)

  echo -n "Waiting for it to come up"
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null "http://localhost:$PORT"; then
      echo
      break
    fi
    echo -n "."
    sleep 0.5
  done

  if ! curl -s -o /dev/null "http://localhost:$PORT"; then
    echo
    echo "Dev server didn't come up in time — check $LOG_FILE" >&2
    exit 1
  fi
fi

open -a Safari "http://localhost:$PORT"
