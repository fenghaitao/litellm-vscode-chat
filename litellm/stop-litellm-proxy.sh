#!/usr/bin/env bash
#
# stop-litellm-proxy.sh — stop the local LiteLLM proxy.
#
# Stops the proxy started by start-litellm-proxy / litellm-up (foreground or
# background). Sends SIGTERM for a graceful shutdown, then SIGKILL if it lingers.
#
# Usage:
#   ./litellm/stop-litellm-proxy.sh            # port 4000
#   ./litellm/stop-litellm-proxy.sh 8000       # custom port
#
# (Equivalent to stop-litellm-proxy.py / .ts.)

set -euo pipefail

PORT="${1:-4000}"

# Match the litellm proxy process for this exact port (pgrep -af lists "pid cmdline";
# awk keeps lines whose cmdline has '--port <PORT>' on a value boundary). The stop
# script itself has no '--port' arg, so it never matches.
pids=$(pgrep -af "litellm" 2>/dev/null | awk -v p="$PORT" '$0 ~ ("--port[ =]" p "($|[^0-9])") {print $1}' || true)

if [ -z "$pids" ]; then
  echo "No LiteLLM proxy found on port ${PORT}."
  exit 0
fi

echo "Stopping LiteLLM proxy on port ${PORT} (PID(s): $(echo "$pids" | tr '\n' ' '))"
# shellcheck disable=SC2086
kill -TERM $pids 2>/dev/null || true

# Wait up to 10s for graceful exit, then force-kill any survivors.
for _ in $(seq 1 10); do
  alive=""
  for p in $pids; do
    kill -0 "$p" 2>/dev/null && alive="$alive $p"
  done
  if [ -z "$alive" ]; then
    echo "Stopped."
    exit 0
  fi
  sleep 1
done

echo "Force-killing:${alive}"
# shellcheck disable=SC2086
kill -KILL $alive 2>/dev/null || true
echo "Stopped."
