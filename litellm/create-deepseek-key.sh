#!/usr/bin/env bash
#
# create-deepseek-key.sh
# ----------------------
# Mint a DeepSeek-only virtual key with Claude-Code-style layered budgets:
#   - a weekly cap   (enforced on the user)
#   - a 5-hour cap   (enforced on the key)
# The key blocks when EITHER limit is hit.
#
# Usage:
#   ./litellm/create-deepseek-key.sh [user_id] [weekly_usd] [window_usd] [window]
#
# Defaults: user_id=alice  weekly_usd=20  window_usd=3  window=5h
# Examples:
#   ./litellm/create-deepseek-key.sh                      # alice, $20/week + $3/5h
#   ./litellm/create-deepseek-key.sh bob 50 8 5h          # bob,   $50/week + $8/5h
#
# Requirements:
#   - The proxy is running (default http://localhost:4000); override with BASE.
#   - LITELLM_MASTER_KEY is set (sourced from .env if present).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

USER_ID="${1:-alice}"
WEEKLY_USD="${2:-20}"
WINDOW_USD="${3:-3}"
WINDOW="${4:-5h}"
WEEKLY_DURATION="${WEEKLY_DURATION:-1w}"
BASE="${BASE:-http://localhost:4000}"
MODELS='["deepseek-v4-flash","deepseek-v4-pro"]'

# Pick up LITELLM_MASTER_KEY from .env if not already exported.
if [ -z "${LITELLM_MASTER_KEY:-}" ] && [ -f ".env" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue;; esac
    [ "$k" = "LITELLM_MASTER_KEY" ] && export LITELLM_MASTER_KEY="$v"
  done < .env
fi
if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "ERROR: LITELLM_MASTER_KEY is not set (export it or put it in .env)." >&2
  exit 1
fi
MK="$LITELLM_MASTER_KEY"

# Prefer jq for clean output, fall back to raw.
pp() { if command -v jq >/dev/null 2>&1; then jq "$@"; else cat; fi; }

auth=(-H "Authorization: Bearer $MK" -H "Content-Type: application/json")

echo "==> Ensuring user '$USER_ID' with weekly cap \$$WEEKLY_USD / $WEEKLY_DURATION (DeepSeek only)"
# /user/new fails if the user already exists; fall back to /user/update.
created=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/user/new" "${auth[@]}" \
  -d "{\"user_id\":\"$USER_ID\",\"max_budget\":$WEEKLY_USD,\"budget_duration\":\"$WEEKLY_DURATION\",\"models\":$MODELS}")
if [ "$created" != "200" ]; then
  echo "    user exists or /user/new returned $created — updating budget instead"
  curl -s "$BASE/user/update" "${auth[@]}" \
    -d "{\"user_id\":\"$USER_ID\",\"max_budget\":$WEEKLY_USD,\"budget_duration\":\"$WEEKLY_DURATION\",\"models\":$MODELS}" \
    | pp -r '.user_id // "(updated)"' >/dev/null || true
fi

echo "==> Generating key with $WINDOW cap \$$WINDOW_USD (DeepSeek only)"
resp=$(curl -s "$BASE/key/generate" "${auth[@]}" \
  -d "{\"user_id\":\"$USER_ID\",\"max_budget\":$WINDOW_USD,\"budget_duration\":\"$WINDOW\",\"models\":$MODELS}")

if command -v jq >/dev/null 2>&1; then
  KEY=$(echo "$resp" | jq -r '.key // empty')
else
  KEY=$(echo "$resp" | sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

if [ -z "$KEY" ]; then
  echo "ERROR: no key in response:" >&2
  echo "$resp" | pp . >&2
  exit 1
fi

cat <<DONE

✅ DeepSeek key created.

  user_id : $USER_ID
  weekly  : \$$WEEKLY_USD / $WEEKLY_DURATION   (user-level)
  window  : \$$WINDOW_USD / $WINDOW          (key-level)
  models  : deepseek-v4-flash, deepseek-v4-pro
  key     : $KEY

Use this key as the API key in the VS Code extension (Base URL: $BASE).
It stops serving when EITHER the weekly or the $WINDOW budget is exhausted.
DONE
