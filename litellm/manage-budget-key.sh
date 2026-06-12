#!/usr/bin/env bash
#
# manage-budget-key.sh
# --------------------
# Manage a DeepSeek-only virtual key with Claude-Code-style layered budgets:
#   - a weekly cap   (enforced on the user)
#   - a 5-hour cap   (enforced on the key)
# The key blocks when EITHER limit is hit.
#
# Note: this Bash version creates/updates DeepSeek keys only. --list shows ALL
# managed keys (any group). The Python/TypeScript ports (manage-budget-key.py /
# manage-budget-key.ts) additionally support --group deepseek|copilot for
# create/update, with model lists fetched live from the proxy.
#
# Modes (first arg, default --create):
#   --create   Revoke any existing key for the user and mint a NEW one.
#              You get a new sk-... value and the 5h spend starts at $0.
#              Use when issuing/rotating the secret. Prints the key.
#   --update   Change the budgets on the EXISTING key in place. Same sk-...
#              value, accumulated spend and reset window are preserved.
#              Use to bump a limit without re-pasting anything.
#   --ensure   Update if the key exists, else create (re-runnable).
#   --list     Table of all managed keys (any group; see also the .py/.ts ports).
#
# Usage:
#   ./litellm/manage-budget-key.sh [--create|--update|--ensure|--list] [user_id] [weekly_usd] [window_usd] [window]
#
# Defaults: user_id=haitao  weekly_usd=20  window_usd=3  window=5h
# Examples:
#   ./litellm/manage-budget-key.sh                       # create: haitao, $20/wk + $3/5h
#   ./litellm/manage-budget-key.sh --update haitao 20 5  # raise 5h cap to $5, keep key+spend
#   ./litellm/manage-budget-key.sh --create bob 50 8 5h  # new key for bob, $50/wk + $8/5h
#
# Requirements:
#   - The proxy is running (default http://localhost:4000); override with BASE.
#   - LITELLM_MASTER_KEY is set (sourced from .env if present).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

MODE="create"
case "${1:-}" in
  --create) MODE="create"; shift;;
  --update) MODE="update"; shift;;
  --ensure) MODE="ensure"; shift;;
  --list) MODE="list"; shift;;
  --*) echo "ERROR: unknown flag '$1' (expected --create, --update, --ensure or --list)" >&2; exit 1;;
esac

USER_ID="${1:-haitao}"
WEEKLY_USD="${2:-20}"
WINDOW_USD="${3:-3}"
WINDOW="${4:-5h}"
WEEKLY_DURATION="${WEEKLY_DURATION:-1w}"
BASE="${BASE:-http://localhost:4000}"
MODELS='["deepseek-v4-flash","deepseek-v4-pro"]'
# Deterministic alias => one budgeted key per user, findable without the plaintext.
KEY_ALIAS="deepseek-budget-${USER_ID}"
# Local plaintext store of minted secrets (litellm keeps only a hash). Shared
# with the .py/.ts ports so --list can show full keys. Git-ignored, chmod 600.
SECRETS_FILE="$ROOT_DIR/.litellm-budget-keys.json"

PY=".venv-litellm/bin/python"; [ -x "$PY" ] || PY="python3"

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
auth=(-H "Authorization: Bearer $MK" -H "Content-Type: application/json")

# -------------------------------------------------------------------- LIST
# Table of all managed budget keys (alias '<group>-budget-<user>'). Reads full
# secrets from SECRETS_FILE; falls back to the masked key_name otherwise.
if [ "$MODE" = "list" ]; then
  curl -s "$BASE/key/list?return_full_object=true&size=100" "${auth[@]}" \
    | "$PY" -c "
import sys, json, os
keys = (json.load(sys.stdin).get('keys') or [])
secrets = {}
try: secrets = json.load(open('$SECRETS_FILE'))
except Exception: pass
ucache = {}
def uinfo(uid):
    if uid not in ucache:
        import urllib.request
        req = urllib.request.Request('$BASE/user/info?user_id='+uid, headers={'Authorization':'Bearer $MK'})
        try: ucache[uid] = json.load(urllib.request.urlopen(req, timeout=15)).get('user_info') or {}
        except Exception: ucache[uid] = {}
    return ucache[uid]
def money(v):
    if v is None: return '-'
    return ('\$%.4f' % v) if (v and abs(v) < 0.01) else ('\$%.2f' % v)
rows=[]
for k in keys:
    a = k.get('key_alias') or ''
    if '-budget-' not in a: continue
    g = a.split('-budget-',1)[0]
    u = uinfo(k.get('user_id') or '')
    rows.append([k.get('user_id') or '', g, str(len(k.get('models') or [])),
        money(k.get('max_budget'))+'/'+(k.get('budget_duration') or ''), money(k.get('spend') or 0),
        money(u.get('max_budget'))+'/'+(u.get('budget_duration') or ''), money(u.get('spend') or 0),
        secrets.get(a) or (k.get('key_name') or '')+' (masked)', a])
if not rows:
    print('No managed budget keys found.'); sys.exit(0)
rows.sort(key=lambda r:(r[1],r[0]))
hdr=['USER','GROUP','MODELS','WINDOW','WIN SPENT','WEEKLY','WK SPENT','KEY','ALIAS']
tbl=[hdr]+rows
w=[max(len(r[i]) for r in tbl) for i in range(len(hdr))]
for ri,r in enumerate(tbl):
    print('  '.join(c.ljust(w[i]) for i,c in enumerate(r)))
    if ri==0: print('  '.join('-'*w[i] for i in range(len(hdr))))
print('\nNote: full sk-... values come from the local store .litellm-budget-keys.json (git-ignored),')
print(\"populated at --create time. Entries marked '(masked)' predate that store or were\")
print('created elsewhere — litellm keeps only a hash, so those secrets can'\"'\"'t be recovered.')
"
  exit 0
fi

# Append a minted secret to the shared local store (keyed by alias).
save_secret() {
  KEY_ALIAS="$1" KEY_VALUE="$2" SECRETS_FILE="$SECRETS_FILE" "$PY" -c "
import os, json
p=os.environ['SECRETS_FILE']
try: d=json.load(open(p))
except Exception: d={}
d[os.environ['KEY_ALIAS']]=os.environ['KEY_VALUE']
json.dump(d, open(p,'w'), indent=2)
try: os.chmod(p, 0o600)
except OSError: pass
"
}

# Hashed token of the user's budgeted key (the alias), or empty if none exists.
existing_key_hash() {
  curl -s "$BASE/user/info?user_id=$USER_ID" "${auth[@]}" 2>/dev/null \
    | "$PY" -c "
import sys,json
try: ks=json.load(sys.stdin).get('keys') or []
except Exception: ks=[]
for k in ks:
    if k.get('key_alias')=='$KEY_ALIAS':
        print(k.get('token') or ''); break
"
}

# --ensure: update in place if the key already exists, otherwise create it.
if [ "$MODE" = "ensure" ]; then
  if [ -n "$(existing_key_hash)" ]; then MODE="update"; else MODE="create"; fi
fi

# -------------------------------------------------------------------- UPDATE
if [ "$MODE" = "update" ]; then
  echo "==> [update] Looking up existing key for '$USER_ID' (alias '$KEY_ALIAS')"
  HASH="$(existing_key_hash)"
  if [ -z "$HASH" ]; then
    echo "ERROR: no existing key for '$USER_ID'. Run with --create first." >&2
    exit 1
  fi
  echo "==> [update] Weekly cap -> \$$WEEKLY_USD / $WEEKLY_DURATION (user-level)"
  curl -s "$BASE/user/update" "${auth[@]}" \
    -d "{\"user_id\":\"$USER_ID\",\"max_budget\":$WEEKLY_USD,\"budget_duration\":\"$WEEKLY_DURATION\",\"models\":$MODELS}" >/dev/null
  echo "==> [update] 5h cap -> \$$WINDOW_USD / $WINDOW (key-level, in place; spend kept)"
  # Identify the key by its hashed token: _hash_token_if_needed only hashes
  # values starting with 'sk-', so the hash passes through unchanged.
  curl -s "$BASE/key/update" "${auth[@]}" \
    -d "{\"key\":\"$HASH\",\"max_budget\":$WINDOW_USD,\"budget_duration\":\"$WINDOW\",\"models\":$MODELS}" >/dev/null
  cat <<DONE

✅ DeepSeek budgets updated in place (key value unchanged).

  user_id : $USER_ID
  weekly  : \$$WEEKLY_USD / $WEEKLY_DURATION   (user-level)
  window  : \$$WINDOW_USD / $WINDOW          (key-level)
  alias   : $KEY_ALIAS

The existing key keeps working — no need to re-paste it into the extension.
Accumulated spend and the current reset window are preserved.
DONE
  exit 0
fi

# -------------------------------------------------------------------- CREATE
echo "==> [create] Ensuring user '$USER_ID' with weekly cap \$$WEEKLY_USD / $WEEKLY_DURATION (DeepSeek only)"
# auto_create_key=false: don't mint an extra unbudgeted default key for the user
# (we create the budgeted key explicitly via /key/generate below).
created=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/user/new" "${auth[@]}" \
  -d "{\"user_id\":\"$USER_ID\",\"max_budget\":$WEEKLY_USD,\"budget_duration\":\"$WEEKLY_DURATION\",\"models\":$MODELS,\"auto_create_key\":false}")
if [ "$created" != "200" ]; then
  echo "    user exists or /user/new returned $created — updating budget instead"
  curl -s "$BASE/user/update" "${auth[@]}" \
    -d "{\"user_id\":\"$USER_ID\",\"max_budget\":$WEEKLY_USD,\"budget_duration\":\"$WEEKLY_DURATION\",\"models\":$MODELS}" >/dev/null || true
fi

# Revoke the previous key (rotation) so we never accumulate multiple keys, each
# with its own independent 5h window.
echo "==> [create] Revoking any existing key with alias '$KEY_ALIAS'"
curl -s "$BASE/key/delete" "${auth[@]}" -d "{\"key_aliases\":[\"$KEY_ALIAS\"]}" \
  | "$PY" -c "import sys,json
try: n=len(json.load(sys.stdin).get('deleted_keys') or [])
except Exception: n=0
print(f'    revoked {n} old key(s)')" 2>/dev/null || true

echo "==> [create] Generating new key with $WINDOW cap \$$WINDOW_USD (DeepSeek only)"
resp=$(curl -s "$BASE/key/generate" "${auth[@]}" \
  -d "{\"user_id\":\"$USER_ID\",\"key_alias\":\"$KEY_ALIAS\",\"max_budget\":$WINDOW_USD,\"budget_duration\":\"$WINDOW\",\"models\":$MODELS}")
KEY=$(echo "$resp" | "$PY" -c "import sys,json
try: print(json.load(sys.stdin).get('key') or '')
except Exception: print('')")

if [ -z "$KEY" ]; then
  echo "ERROR: no key in response:" >&2
  echo "$resp" >&2
  exit 1
fi
save_secret "$KEY_ALIAS" "$KEY"  # so --list can show the full secret later

cat <<DONE

✅ DeepSeek key created.

  user_id : $USER_ID
  weekly  : \$$WEEKLY_USD / $WEEKLY_DURATION   (user-level)
  window  : \$$WINDOW_USD / $WINDOW          (key-level)
  models  : deepseek-v4-flash, deepseek-v4-pro
  alias   : $KEY_ALIAS
  key     : $KEY

Use this key as the API key in the VS Code extension (Base URL: $BASE).
It stops serving when EITHER the weekly or the $WINDOW budget is exhausted.

NOTE: --create ROTATES — it revoked any prior key and issued this new value, so
re-paste it into the extension. To change only the budgets WITHOUT rotating the
secret (keeps spend + window), re-run with: --update $USER_ID <weekly> <5h>
DONE
