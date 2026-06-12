#!/usr/bin/env python3
"""
manage-budget-key.py
--------------------
Manage a model-group-scoped LiteLLM virtual key with Claude-Code-style layered
budgets:

  - a weekly cap   (enforced on the user)
  - a window cap   (default 5h, enforced on the key)

The key blocks when EITHER limit is hit.

Modes:
  --create  (default)  Revoke any existing key for the user+group and mint a
                       NEW one. New sk-... value, window spend restarts at $0.
  --update             Change the budgets on the EXISTING key in place. Same
                       sk-... value; accumulated spend and reset window kept.
  --list               Show all managed budget keys as a table (budgets + spend;
                       the secret is never stored, so only a masked key is shown).
                       Optional --group filters to one group.

Model groups (--group, default "deepseek"):
  deepseek  -> models from the proxy whose id starts with "deepseek-"
  copilot   -> models whose id starts with "github_copilot/"
  (--models a,b,c overrides the list explicitly)

The group also names the key alias: "<group>-budget-<user_id>", which is how
one budgeted key per user per group is found and rotated without its plaintext.
Note: the weekly cap lives on the USER, so it aggregates across all of that
user's keys/groups; user-level model access is the union of all groups granted.

Usage:
  ./litellm/manage-budget-key.py [--create|--update] [--group G] [--models a,b]
                                 [user_id] [weekly_usd] [window_usd] [window]

Defaults: user_id=haitao  weekly_usd=20  window_usd=3  window=5h

Examples:
  ./litellm/manage-budget-key.py                            # deepseek key, $20/wk + $3/5h
  ./litellm/manage-budget-key.py --update haitao 20 5       # raise 5h cap, keep key+spend
  ./litellm/manage-budget-key.py --group copilot bob 30 5   # copilot key for bob

Requirements: proxy running (BASE, default http://localhost:4000);
LITELLM_MASTER_KEY set (sourced from .env at repo root if present).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GROUP_PREFIXES = {"deepseek": "deepseek-", "copilot": "github_copilot/"}
# Local plaintext store of minted secrets, keyed by alias. litellm only stores a
# hash, so this is the only way --list can show full keys. Git-ignored, chmod 600.
SECRETS_FILE = ROOT / ".litellm-budget-keys.json"


def load_secrets() -> dict:
    try:
        return json.loads(SECRETS_FILE.read_text())
    except Exception:
        return {}


def save_secret(alias: str, key: str) -> None:
    secrets = load_secrets()
    secrets[alias] = key
    SECRETS_FILE.write_text(json.dumps(secrets, indent=2))
    try:
        os.chmod(SECRETS_FILE, 0o600)
    except OSError:
        pass


def load_master_key() -> str:
    if not os.environ.get("LITELLM_MASTER_KEY"):
        env = ROOT / ".env"
        if env.is_file():
            for line in env.read_text().splitlines():
                line = line.strip()
                if line.startswith("LITELLM_MASTER_KEY="):
                    os.environ["LITELLM_MASTER_KEY"] = line.split("=", 1)[1]
                    break
    mk = os.environ.get("LITELLM_MASTER_KEY")
    if not mk:
        sys.exit("ERROR: LITELLM_MASTER_KEY is not set (export it or put it in .env).")
    return mk


def api(base: str, mk: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {mk}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise SystemExit(f"ERROR: {method} {path} -> HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"ERROR: cannot reach {base} ({e.reason}). Is the proxy running?") from e


def resolve_models(base: str, mk: str, group: str, override: str | None) -> list[str]:
    if override:
        return [m.strip() for m in override.split(",") if m.strip()]
    prefix = GROUP_PREFIXES[group]
    data = api(base, mk, "GET", "/v1/models")
    models = [m["id"] for m in data.get("data", []) if m["id"].startswith(prefix)]
    if not models:
        sys.exit(f"ERROR: proxy lists no models with prefix '{prefix}' for group '{group}'.")
    return models


def user_state(base: str, mk: str, user_id: str, alias: str) -> tuple[bool, list[str], str | None]:
    """Returns (user_exists, user_models, hashed_token_of_aliased_key_or_None)."""
    try:
        info = api(base, mk, "GET", f"/user/info?user_id={user_id}")
    except SystemExit:
        return False, [], None
    user_info = info.get("user_info") or {}
    exists = bool(user_info)
    models = list(user_info.get("models") or [])
    token = None
    for k in info.get("keys") or []:
        if k.get("key_alias") == alias:
            token = k.get("token")
            break
    return exists, models, token


def list_keys(base: str, mk: str, group_filter: str | None) -> None:
    """Print all manage-budget-key keys (alias '<group>-budget-<user>') as a table.
    Secrets are never stored, so only the masked key_name is shown."""
    data = api(base, mk, "GET", "/key/list?return_full_object=true&size=100")
    secrets = load_secrets()
    rows = []
    user_cache: dict[str, dict] = {}
    for k in data.get("keys") or []:
        alias = k.get("key_alias") or ""
        if "-budget-" not in alias:
            continue
        group = alias.split("-budget-", 1)[0]
        if group_filter and group != group_filter:
            continue
        user_id = k.get("user_id") or ""
        if user_id and user_id not in user_cache:
            try:
                user_cache[user_id] = (api(base, mk, "GET", f"/user/info?user_id={user_id}").get("user_info") or {})
            except SystemExit:
                user_cache[user_id] = {}
        u = user_cache.get(user_id, {})
        rows.append({
            "user": user_id,
            "group": group,
            "models": len(k.get("models") or []),
            "win_cap": k.get("max_budget"),
            "win_dur": k.get("budget_duration") or "",
            "win_spend": k.get("spend") or 0,
            "wk_cap": u.get("max_budget"),
            "wk_dur": u.get("budget_duration") or "",
            "wk_spend": u.get("spend") or 0,
            "key": secrets.get(alias) or (k.get("key_name") or "") + " (masked)",
            "alias": alias,
        })

    if not rows:
        print("No managed budget keys found." + (f" (group={group_filter})" if group_filter else ""))
        return

    def money(v) -> str:
        if v is None:
            return "-"
        if v != 0 and abs(v) < 0.01:
            return f"${v:.4f}"
        return f"${v:.2f}"

    rows.sort(key=lambda r: (r["group"], r["user"]))
    hdr = ["USER", "GROUP", "MODELS", "WINDOW", "WIN SPENT", "WEEKLY", "WK SPENT", "KEY", "ALIAS"]
    table = [hdr] + [[
        r["user"], r["group"], str(r["models"]),
        f'{money(r["win_cap"])}/{r["win_dur"]}', money(r["win_spend"]),
        f'{money(r["wk_cap"])}/{r["wk_dur"]}', money(r["wk_spend"]),
        r["key"], r["alias"],
    ] for r in rows]
    widths = [max(len(row[i]) for row in table) for i in range(len(hdr))]
    for ri, row in enumerate(table):
        print("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)))
        if ri == 0:
            print("  ".join("-" * widths[i] for i in range(len(hdr))))
    print(f"\nNote: full sk-... values come from the local store {SECRETS_FILE.name} (git-ignored),")
    print("populated at --create time. Entries marked '(masked)' predate that store or were")
    print("created elsewhere — litellm keeps only a hash, so those secrets can't be recovered.")


def main() -> None:
    p = argparse.ArgumentParser(add_help=True, description=__doc__.splitlines()[2])
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--create", action="store_true", help="rotate: revoke old key, mint a new one (default)")
    mode.add_argument("--update", action="store_true", help="edit budgets in place; key value and spend preserved")
    mode.add_argument("--list", action="store_true", help="list all managed budget keys as a table (no secrets)")
    p.add_argument("--group", choices=sorted(GROUP_PREFIXES), default="deepseek", help="model group (default: deepseek)")
    p.add_argument("--models", help="comma-separated explicit model list (overrides --group's list)")
    p.add_argument("user_id", nargs="?", default="haitao")
    p.add_argument("weekly_usd", nargs="?", type=float, default=20.0)
    p.add_argument("window_usd", nargs="?", type=float, default=3.0)
    p.add_argument("window", nargs="?", default="5h")
    args = p.parse_args()

    base = os.environ.get("BASE", "http://localhost:4000")
    weekly_duration = os.environ.get("WEEKLY_DURATION", "1w")
    mk = load_master_key()

    if args.list:
        list_keys(base, mk, args.group if any(a in sys.argv for a in ("--group",)) else None)
        return

    alias = f"{args.group}-budget-{args.user_id}"
    models = resolve_models(base, mk, args.group, args.models)
    exists, user_models, token_hash = user_state(base, mk, args.user_id, alias)
    # Union with the user's current model access so granting one group doesn't
    # revoke another (the weekly cap stays a per-user aggregate across groups).
    merged_models = sorted(set(user_models) | set(models))

    user_body = {
        "user_id": args.user_id,
        "max_budget": args.weekly_usd,
        "budget_duration": weekly_duration,
        "models": merged_models,
    }

    if args.update:
        if not token_hash:
            sys.exit(f"ERROR: no existing key with alias '{alias}'. Run with --create first.")
        print(f"==> [update] Weekly cap -> ${args.weekly_usd:g} / {weekly_duration} (user-level)")
        api(base, mk, "POST", "/user/update", user_body)
        print(f"==> [update] {args.window} cap -> ${args.window_usd:g} (key-level, in place; spend kept)")
        # Identify the key by hashed token: the server only re-hashes values
        # starting with 'sk-', so a stored hash passes through unchanged.
        api(base, mk, "POST", "/key/update",
            {"key": token_hash, "max_budget": args.window_usd,
             "budget_duration": args.window, "models": models})
        print(f"""
✅ Budgets updated in place (key value unchanged).

  user_id : {args.user_id}
  weekly  : ${args.weekly_usd:g} / {weekly_duration}   (user-level)
  window  : ${args.window_usd:g} / {args.window}          (key-level)
  group   : {args.group}  ({len(models)} models)
  alias   : {alias}

The existing key keeps working — no need to re-paste it into the extension.
Accumulated spend and the current reset window are preserved.""")
        return

    # ------------------------------------------------------------- CREATE
    print(f"==> [create] Ensuring user '{args.user_id}' with weekly cap ${args.weekly_usd:g} / {weekly_duration}")
    if exists:
        api(base, mk, "POST", "/user/update", user_body)
    else:
        # auto_create_key=false: don't mint an extra unbudgeted default key.
        api(base, mk, "POST", "/user/new", {**user_body, "auto_create_key": False})

    print(f"==> [create] Revoking any existing key with alias '{alias}'")
    if token_hash:
        deleted = api(base, mk, "POST", "/key/delete", {"key_aliases": [alias]})
        print(f"    revoked {len(deleted.get('deleted_keys') or [])} old key(s)")
    else:
        print("    revoked 0 old key(s)")

    print(f"==> [create] Generating new key with {args.window} cap ${args.window_usd:g} ({args.group})")
    resp = api(base, mk, "POST", "/key/generate",
               {"user_id": args.user_id, "key_alias": alias,
                "max_budget": args.window_usd, "budget_duration": args.window,
                "models": models})
    key = resp.get("key")
    if not key:
        sys.exit(f"ERROR: no key in response: {json.dumps(resp)[:400]}")
    save_secret(alias, key)  # so --list can show the full secret later

    print(f"""
✅ Key created.

  user_id : {args.user_id}
  weekly  : ${args.weekly_usd:g} / {weekly_duration}   (user-level)
  window  : ${args.window_usd:g} / {args.window}          (key-level)
  group   : {args.group}  ({len(models)} models)
  alias   : {alias}
  key     : {key}

Use this key as the API key in the VS Code extension (Base URL: {base}).
It stops serving when EITHER the weekly or the {args.window} budget is exhausted.

NOTE: --create ROTATES — any prior '{alias}' key was revoked, so re-paste this
new value. To change only budgets without rotating (keeps spend + window):
  ./litellm/manage-budget-key.py --update --group {args.group} {args.user_id} <weekly> <window_usd>""")


if __name__ == "__main__":
    main()
