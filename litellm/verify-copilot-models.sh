#!/usr/bin/env bash
#
# verify-copilot-models.sh
# ------------------------
# Query GitHub Copilot's live API for the ground-truth model IDs and your
# plan's quota, using the endpoints documented by the copilot-api project
# (copilot-api/src/lib/api-config.ts, services/copilot/get-models.ts,
#  services/github/get-copilot-usage.ts).
#
# Auth: reuses the long-lived GitHub OAuth token cached by either
#   - litellm's github_copilot login:  ~/.config/litellm/github_copilot/access-token
#   - copilot-api's login:             ~/.local/share/copilot-api/github_token
# and exchanges it for a short-lived Copilot bearer (copilot_internal/v2/token).
#
# Usage:  ./verify-copilot-models.sh [--json]
#   --json   dump the raw /models JSON instead of the table

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PY=".venv-litellm/bin/python"
[ -x "$PY" ] || PY="python3"

exec "$PY" - "$@" <<'PY'
import json, os, sys, urllib.request

RAW = "--json" in sys.argv

token_paths = [
    os.path.expanduser("~/.config/litellm/github_copilot/access-token"),
    os.path.expanduser("~/.local/share/copilot-api/github_token"),
]
gh_token = None
for p in token_paths:
    if os.path.isfile(p):
        t = open(p).read().strip()
        if t:
            gh_token = t
            break
if not gh_token:
    sys.exit("ERROR: no cached GitHub token found. Log in once via litellm "
             "(any github_copilot/* request) or copilot-api, then re-run.")

# headers per copilot-api/src/lib/api-config.ts
gh_headers = {
    "accept": "application/json",
    "authorization": f"token {gh_token}",
    "editor-version": "vscode/1.99.0",
    "editor-plugin-version": "copilot-chat/0.26.7",
    "user-agent": "GitHubCopilotChat/0.26.7",
    "x-github-api-version": "2025-04-01",
}

def get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

# 1) exchange long-lived GitHub token -> short-lived Copilot bearer
tok = get("https://api.github.com/copilot_internal/v2/token", gh_headers)
cop_headers = {
    "Authorization": f"Bearer {tok['token']}",
    "content-type": "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.99.0",
    "editor-plugin-version": "copilot-chat/0.26.7",
    "user-agent": "GitHubCopilotChat/0.26.7",
    "x-github-api-version": "2025-04-01",
}

# 2) ground-truth model list
models = get("https://api.githubcopilot.com/models", cop_headers)
if RAW:
    print(json.dumps(models, indent=2))
    sys.exit(0)

print(f"{'MODEL ID':38} {'vendor':12} {'ctx':>8} {'out':>7}  picker preview tools vision")
for m in sorted(models["data"], key=lambda x: (x["vendor"], x["id"])):
    cap = m["capabilities"]; lim = cap.get("limits", {}); sup = cap.get("supports", {})
    print(f"{m['id']:38} {m['vendor']:12} "
          f"{lim.get('max_context_window_tokens','-'):>8} {lim.get('max_output_tokens','-'):>7}  "
          f"{str(m.get('model_picker_enabled','')):6} {str(m.get('preview','')):7} "
          f"{str(sup.get('tool_calls','')):5} {sup.get('vision','')}")

# 3) plan + quota snapshot
try:
    u = get("https://api.github.com/copilot_internal/user", gh_headers)
    print(f"\nplan: {u.get('copilot_plan')}   quota resets: {u.get('quota_reset_date')}")
    for name, q in (u.get("quota_snapshots") or {}).items():
        if q.get("unlimited"):
            print(f"  {name:22} unlimited")
        else:
            print(f"  {name:22} {q.get('remaining')}/{q.get('entitlement')} left "
                  f"({q.get('percent_remaining')}% remaining)")
except Exception as e:
    print(f"\n(quota lookup failed: {e})")
PY
