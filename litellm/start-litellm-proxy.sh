#!/usr/bin/env bash
#
# Start the LiteLLM proxy for the VS Code Copilot Chat extension.
#
# Usage:
#   ./litellm/start-litellm-proxy.sh            # uses port 4000
#   ./litellm/start-litellm-proxy.sh 8000       # custom port
#
# API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY) and LITELLM_MASTER_KEY are read
# from the environment — e.g. exported in your ~/.bashrc. A local .env, if
# present, is sourced as a convenience and does NOT override existing values.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PORT="${1:-4000}"
CONFIG="litellm/litellm_config.yaml"
VENV_LITELLM=".venv-litellm/bin/litellm"

# Put the venv's bin on PATH so LiteLLM can find the `prisma` CLI on startup
# (it detects Prisma via `subprocess.run(["prisma"])`). This means you do NOT
# have to `source .venv-litellm/bin/activate` first.
export PATH="$ROOT_DIR/.venv-litellm/bin:$PATH"

if [ ! -x "$VENV_LITELLM" ]; then
  echo "ERROR: $VENV_LITELLM not found. Did you create the .venv-litellm environment?" >&2
  exit 1
fi

# Source generated DB/Redis credentials and a local .env, letting the existing
# environment win. .env.litellm-db is written by setup-litellm-proxy.sh.
for envfile in .env.litellm-db .env; do
  [ -f "$envfile" ] || continue
  while IFS='=' read -r key val; do
    case "$key" in ''|\#*) continue;; esac          # skip blanks/comments
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi  # only if not already set
  done < "$envfile"
done

# Warn (don't fail) about anything still missing, so issues are obvious.
for v in OPENAI_API_KEY ANTHROPIC_API_KEY; do
  if [ -z "${!v:-}" ]; then
    echo "WARNING: $v is not set — calls to that provider's models will fail." >&2
  fi
done
if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "ERROR: LITELLM_MASTER_KEY is not set (export it in ~/.bashrc or .env)." >&2
  exit 1
fi

echo "Starting LiteLLM proxy on http://localhost:${PORT} (config: ${CONFIG})"
echo "Use this master key as the API key in the VS Code extension: ${LITELLM_MASTER_KEY}"
exec "$VENV_LITELLM" --config "$CONFIG" --port "$PORT"
