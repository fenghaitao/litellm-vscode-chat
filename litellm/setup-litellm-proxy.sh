#!/usr/bin/env bash
#
# setup-litellm-proxy.sh
# ----------------------
# One-shot, idempotent setup of the databases LiteLLM needs for budgets and
# rate limiting (Claude-Code-style 5h / weekly windows):
#
#   - PostgreSQL  -> persistent virtual keys, budgets, spend tracking
#   - Redis       -> distributed spend / TPM / RPM counters across workers
#
# Native apt install (no Docker). Tested on Ubuntu 24.04 + systemd.
# Re-running is safe: existing packages, roles, and generated passwords are reused.
#
# Output: writes connection details to .env.litellm-db (chmod 600, git-ignored).
# After this, run ./litellm/start-litellm-proxy.sh — LiteLLM auto-creates its
# tables on first boot.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PG_DB="litellm_proxy"
PG_USER="litellm"
PG_HOST="127.0.0.1"
PG_PORT="5432"
REDIS_HOST="127.0.0.1"
REDIS_PORT="6379"
ENV_FILE=".env.litellm-db"
REDIS_CONF="/etc/redis/redis.conf"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

genpw() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    tr -dc 'a-f0-9' < /dev/urandom | head -c 32
  fi
}

# ---------------------------------------------------------------------------
# 0. Sanity: this script needs sudo and apt (Debian/Ubuntu).
# ---------------------------------------------------------------------------
if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: apt-get not found. This script targets Debian/Ubuntu." >&2
  exit 1
fi
if ! sudo -n true 2>/dev/null; then
  echo "NOTE: sudo may prompt for your password during installation." >&2
fi

# ---------------------------------------------------------------------------
# 1. Reuse previously generated passwords if the env file already exists.
# ---------------------------------------------------------------------------
PG_PASSWORD=""
REDIS_PASSWORD=""
if [ -f "$ENV_FILE" ]; then
  log "Reusing existing credentials from $ENV_FILE"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
PG_PASSWORD="${PG_PASSWORD:-$(genpw)}"
REDIS_PASSWORD="${REDIS_PASSWORD:-$(genpw)}"

# ---------------------------------------------------------------------------
# 2. Install PostgreSQL and Redis if missing.
# ---------------------------------------------------------------------------
to_install=()
command -v psql         >/dev/null 2>&1 || to_install+=("postgresql")
command -v redis-server >/dev/null 2>&1 || to_install+=("redis-server")
if [ "${#to_install[@]}" -gt 0 ]; then
  log "Installing: ${to_install[*]}"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${to_install[@]}"
else
  log "PostgreSQL and Redis already installed — skipping apt install"
fi

# ---------------------------------------------------------------------------
# 3. Ensure both services are enabled and running.
# ---------------------------------------------------------------------------
log "Enabling and starting services"
sudo systemctl enable --now postgresql
sudo systemctl enable --now redis-server

# ---------------------------------------------------------------------------
# 4. Create the PostgreSQL role and database (idempotent).
# ---------------------------------------------------------------------------
log "Configuring PostgreSQL role '$PG_USER' and database '$PG_DB'"
# Role: create if absent, always (re)set the password to match our env file.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASSWORD}';
  END IF;
END
\$\$;
SQL
# Database: CREATE DATABASE can't run inside a DO/transaction block, so guard it.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"
fi

# ---------------------------------------------------------------------------
# 5. Set a Redis password (requirepass) so local processes can't read counters.
# ---------------------------------------------------------------------------
log "Configuring Redis authentication"
if sudo test -f "$REDIS_CONF"; then
  if ! sudo grep -qxF "requirepass ${REDIS_PASSWORD}" "$REDIS_CONF"; then
    sudo sed -i '/^requirepass /d' "$REDIS_CONF"          # drop any active requirepass
    echo "requirepass ${REDIS_PASSWORD}" | sudo tee -a "$REDIS_CONF" >/dev/null
    sudo systemctl restart redis-server
  fi
else
  echo "WARNING: $REDIS_CONF not found; Redis left without a password." >&2
  REDIS_PASSWORD=""
fi

# ---------------------------------------------------------------------------
# 6. Write the generated connection details (git-ignored via .env.*).
# ---------------------------------------------------------------------------
log "Writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# Generated by setup-litellm-proxy.sh — DO NOT COMMIT (matched by .gitignore '.env.*').
# Sourced automatically by start-litellm-proxy.sh.
PG_PASSWORD=${PG_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
DATABASE_URL=postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}
REDIS_HOST=${REDIS_HOST}
REDIS_PORT=${REDIS_PORT}
EOF
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------------------
# 7. Create / update LiteLLM's tables (prisma db push).
#    We own the schema here so the proxy can run with
#    `disable_prisma_schema_update: true` and never migrate on boot.
#    Re-run this script after upgrading litellm to pick up schema changes.
# ---------------------------------------------------------------------------
log "Creating/updating LiteLLM tables (prisma db push)"
PRISMA_SCHEMA=".venv-litellm/lib/python3.12/site-packages/litellm/proxy/schema.prisma"
if [ -f "$PRISMA_SCHEMA" ] && [ -x ".venv-litellm/bin/prisma" ]; then
  DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}" \
  PATH="$ROOT_DIR/.venv-litellm/bin:$PATH" \
    .venv-litellm/bin/prisma db push --schema "$PRISMA_SCHEMA" --accept-data-loss --skip-generate
else
  echo "WARNING: prisma CLI or schema not found; tables will be created on first proxy boot." >&2
fi

# ---------------------------------------------------------------------------
# 8. Verify connectivity.
# ---------------------------------------------------------------------------
log "Verifying PostgreSQL connection"
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
  -tAc "SELECT 'postgres connection OK'" || { echo "ERROR: cannot connect to Postgres" >&2; exit 1; }

log "Verifying Redis connection"
if [ -n "$REDIS_PASSWORD" ]; then
  REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping
else
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping
fi

cat <<DONE

✅ Databases ready.

  PostgreSQL : ${PG_HOST}:${PG_PORT}  db=${PG_DB}  user=${PG_USER}
  Redis      : ${REDIS_HOST}:${REDIS_PORT}  (password set)
  Credentials: ${ENV_FILE}

Next steps:
  1. Make sure litellm/litellm_config.yaml has 'database_url: os.environ/DATABASE_URL'
     and the redis cache block (already configured if you used the provided config).
  2. Start the proxy:   ./litellm/start-litellm-proxy.sh
     (LiteLLM auto-creates its tables on first boot.)
  3. Create budget-scoped keys — see litellm/LITELLM_SETUP.md "Budgets & rate limits".
DONE
