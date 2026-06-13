# LiteLLM Proxy Setup for the VS Code Copilot Chat Extension

This document explains how to run the local LiteLLM proxy that backs the
**LiteLLM Provider for GitHub Copilot Chat** extension. It covers two modes:

- **Basic mode** (sections 1–4): a stateless proxy, no database. Enough to use
  models in Copilot Chat.
- **Budgets & rate-limits mode** (section 5): adds PostgreSQL + Redis to enforce
  Claude-Code-style usage windows (e.g. a 5-hour window plus a weekly cap) on
  the DeepSeek models.

It also records the two gotchas that caused the initial `"No connected db."`
error (see Troubleshooting).

## Overview

There is no standalone "LiteLLM chat" window. The extension
(`vivswan.litellm-vscode-chat`) registers LiteLLM as a **model provider inside
GitHub Copilot Chat**. The local proxy is the backend; Copilot Chat is the UI.

```
VS Code Copilot Chat  ──>  LiteLLM proxy (localhost:4000)  ──>  OpenAI / Anthropic / ...
```

## Prerequisites

- The `.venv-litellm` Python environment with `litellm` installed.
- The **GitHub Copilot Chat** extension installed (provides the chat panel).
- The **LiteLLM Provider** extension installed (`vivswan.litellm-vscode-chat`).

## Python environment (`.venv-litellm`)

The environment has the **full `litellm[proxy]`** install (106 packages,
`litellm` 1.88.1, Python 3.12). Nothing extra needs to be pip-installed for
either mode. Key packages by role:

| Role | Packages |
| --- | --- |
| Proxy server | `litellm`, `fastapi`, `uvicorn`, `gunicorn`, `granian`, `pydantic`, `pydantic_settings`, `apscheduler`, `mcp`, `websockets` |
| LLM clients / tokenization | `openai`, `boto3`, `tiktoken`, `tokenizers`, `numpy`, `httpx`, `httpcore`, `aiohttp`, `backoff` |
| Utilities | `pyyaml`, `python-dotenv`, `click`, `rich`, `jinja2`, `orjson`, `jsonschema`, `cryptography`, `email-validator` |

> `prisma` is the ORM used in **budgets & rate-limits mode** (section 5) to talk
> to PostgreSQL. In basic mode it's installed but unused.

The venv was created with `uv`, so it has **no `pip`**. To list packages use:

```bash
.venv-litellm/bin/python -m uv pip list      # if uv is available
# or inspect dist-info directly:
ls .venv-litellm/lib/python3.12/site-packages/*.dist-info
```

## 1. Configure secrets

The proxy reads these from the **environment**:

```bash
export OPENAI_API_KEY=sk-...            # real OpenAI key
export ANTHROPIC_API_KEY=sk-ant-...     # real Anthropic key
export DEEPSEEK_API_KEY=sk-...          # real DeepSeek key
export LITELLM_MASTER_KEY=sk-...        # any secret string you choose
```

The recommended place is your `~/.bashrc` (so the variables are already
exported in the shell you launch the proxy from). The start script inherits
that environment.

`LITELLM_MASTER_KEY` is the key you enter into the VS Code extension as the
"API key". It can be any string.

> A local `.env` is **optional**: if present, `start-litellm-proxy.sh` sources it
> but never overrides variables already set in your shell. Keep real keys out of
> committed files.

## 2. Config file (`litellm/litellm_config.yaml`)

The committed config is set up for **budgets & rate-limits mode**. The
`database_url` and the `cache` (Redis) blocks are what enable section 5 — for a
stateless basic-mode proxy, simply delete those two blocks. The snippet below
shows the structure; the committed file additionally contains the
`github_copilot/*` model entries with credit-based pricing (see section 6).

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude-sonnet-4-20250514
    litellm_params:
      model: claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY
  # DeepSeek V4 — litellm 1.88.1 has no built-in pricing for these, so we supply
  # it here (USD per token = DeepSeek's per-1M rate / 1e6). Required for budgets.
  - model_name: deepseek-v4-flash
    litellm_params:
      model: deepseek/deepseek-v4-flash
      api_key: os.environ/DEEPSEEK_API_KEY
      input_cost_per_token: 0.00000014            # $0.14 / 1M (cache miss)
      output_cost_per_token: 0.00000028           # $0.28 / 1M
      cache_read_input_token_cost: 0.0000000028   # $0.0028 / 1M (cache hit)
    model_info:
      max_input_tokens: 1000000
      max_output_tokens: 384000
  - model_name: deepseek-v4-pro
    litellm_params:
      model: deepseek/deepseek-v4-pro
      api_key: os.environ/DEEPSEEK_API_KEY
      input_cost_per_token: 0.000000435           # $0.435 / 1M (cache miss)
      output_cost_per_token: 0.00000087           # $0.87 / 1M
      cache_read_input_token_cost: 0.000000003625 # $0.003625 / 1M (cache hit)
    model_info:
      max_input_tokens: 1000000
      max_output_tokens: 384000

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL        # delete for basic mode
  disable_prisma_schema_update: true           # schema is owned by setup-litellm-proxy.sh

litellm_settings:
  drop_params: true
  cache: true                                  # delete block for basic mode
  cache_params:
    type: redis
    host: os.environ/REDIS_HOST
    port: os.environ/REDIS_PORT
    password: os.environ/REDIS_PASSWORD
```

> `cache: true` also enables exact-match response caching. Coding prompts rarely
> collide, but you can tune it with `cache_params.ttl` or restrict which calls
> are cached via `cache_params.supported_call_types`.

## 3. Start the proxy

```bash
./litellm/start-litellm-proxy.sh          # http://localhost:4000
./litellm/start-litellm-proxy.sh 8000     # custom port
```

This script also has Python and TypeScript ports with identical behavior:
`./litellm/start-litellm-proxy.py` and `./litellm/start-litellm-proxy.ts` (bun).

The script loads `.env`, warns about placeholder keys, and prints the master
key to use in the extension. Keep this terminal running — Copilot Chat calls the
proxy live.

To stop it (handy when it was started in the background by `litellm-up.ts`):

```bash
./litellm/stop-litellm-proxy.sh           # or .py / .ts; add a port to target a non-4000 proxy
```

## 4. Connect the extension

1. Command Palette (`Ctrl+Shift+P`) → **Manage LiteLLM Provider**
   - Base URL: `http://localhost:4000`
   - API key: your `LITELLM_MASTER_KEY` value
2. **LiteLLM: Test Connection** — status bar should show `$(check) LiteLLM (2)`.
3. Open Copilot Chat (`Ctrl+Alt+I`), click the **model picker** at the bottom of
   the chat box, and select a model from the **LiteLLM** group
   (`gpt-4o` or `claude-sonnet-4-20250514`).

If models don't appear, run **LiteLLM: Show Diagnostics**.

## Verify from the command line

```bash
set -a; . ./.env; set +a
curl -s http://localhost:4000/v1/models -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```

Expected: a JSON list containing `gpt-4o`, `claude-sonnet-4-20250514`,
`deepseek-v4-flash`, and `deepseek-v4-pro`.

> **DeepSeek model names:** `deepseek-chat` / `deepseek-reasoner` are deprecated
> (2026-07-24) and transparently route to `deepseek-v4-flash`. Use the explicit
> `deepseek-v4-flash` / `deepseek-v4-pro` IDs. litellm 1.88.1 (the latest stable)
> has no built-in pricing for V4, so the config supplies it under each model's
> `litellm_params` — update those numbers if DeepSeek changes its prices.

## 5. Budgets & rate limits (PostgreSQL + Redis)

This mode adds the two databases LiteLLM needs to enforce **Claude-Code-style
usage windows** — for example a 5-hour window plus a weekly cap on the DeepSeek
models.

### What each database is for

| Database | Role |
| --- | --- |
| **PostgreSQL** | Persistent virtual keys, budgets, and spend tracking. Budgets reset on their `budget_duration` (e.g. `5h`, `1w`). |
| **Redis** | Distributed spend / TPM / RPM counters so limits stay correct across multiple workers; also backs the budget windows. |

### Install and configure the databases

Run the setup script (native apt install of PostgreSQL + Redis — no Docker,
idempotent, safe to re-run). It comes in three equivalent implementations —
pick whichever runtime you prefer:

```bash
./litellm/setup-litellm-proxy.sh    # Bash
./litellm/setup-litellm-proxy.py    # Python (stdlib only)
./litellm/setup-litellm-proxy.ts    # TypeScript (bun)
```

It:

1. Installs `postgresql` and `redis-server` if missing and enables both services.
2. Creates role `litellm` and database `litellm_proxy` (idempotent).
3. Sets a Redis password (`requirepass`).
4. Writes generated credentials to **`.env.litellm-db`** (chmod 600, git-ignored
   via `.env.*`) — `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`.
5. Verifies both connections.

`start-litellm-proxy.sh` automatically sources `.env.litellm-db`, so the proxy
picks up `DATABASE_URL` and the Redis settings with no extra steps.

### Create the tables (owned by the setup script)

`setup-litellm-proxy.sh` already creates/updates the ~64 LiteLLM tables via
`prisma db push`, and the config sets `disable_prisma_schema_update: true` so the
proxy does **not** migrate on boot. This separation is deliberate — see the
troubleshooting note below on why on-boot migration was removed.

**Re-run `./litellm/setup-litellm-proxy.sh` after upgrading `litellm`** so any schema
changes are applied. (To run the migration by hand:)

```bash
set -a; . ./.env.litellm-db; set +a
PATH="$PWD/.venv-litellm/bin:$PATH" .venv-litellm/bin/prisma db push \
  --schema .venv-litellm/lib/python3.12/site-packages/litellm/proxy/schema.prisma \
  --accept-data-loss --skip-generate
```

### Define the limits (5-hour window + weekly cap)

Budgets are **layered**: a key-level budget and a user-level budget are enforced
at the same time, so one key can carry both a 5-hour bucket and a weekly bucket.
With the proxy running, call its admin API with the master key:

```bash
BASE=http://localhost:4000
MK=$LITELLM_MASTER_KEY

# Weekly bucket — a user with a $20 / 7-day budget, restricted to DeepSeek.
curl -s $BASE/user/new -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"user_id":"haitao","max_budget":20,"budget_duration":"1w",
       "models":["deepseek-v4-flash","deepseek-v4-pro"]}'

# 5-hour bucket — a key under that user with a $3 / 5-hour budget.
curl -s $BASE/key/generate -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"user_id":"haitao","max_budget":3,"budget_duration":"5h",
       "models":["deepseek-v4-flash","deepseek-v4-pro"]}'
```

These two calls are wrapped by `manage-budget-key` (see below), available in
three equivalent implementations: `./litellm/manage-budget-key.sh` (Bash,
DeepSeek-only), `./litellm/manage-budget-key.py` (Python, stdlib only) and
`./litellm/manage-budget-key.ts` (TypeScript, run with bun). The Python and
TypeScript ports additionally support `--group deepseek|copilot`; the Bash
original is DeepSeek-only.

The returned `key` (an `sk-...`) is what you hand to the end user / put in the
extension. It blocks when **either** limit is hit: $3 per rolling 5 hours, or
$20 per week — mirroring Claude Code's two-tier limits. Adjust the dollar
amounts to taste; `budget_duration` accepts `s, m, h, d, w, mo`.

You can also cap throughput with `rpm_limit` / `tpm_limit` (per-minute) and
`max_parallel_requests` on the same `key/generate` call.

**`manage-budget-key` — modes and model groups:**

```bash
./litellm/manage-budget-key.py                              # --create: deepseek key for haitao
./litellm/manage-budget-key.py --update haitao 20 5         # change caps in place, keep key
./litellm/manage-budget-key.py --group copilot haitao 30 5  # copilot-scoped key
./litellm/manage-budget-key.ts --create bob 50 8 5h         # TypeScript port, same CLI
```

- **`--group deepseek|copilot`** (default `deepseek`) picks which models the key
  can access. The lists are fetched **live from the proxy** (`/v1/models`,
  filtered by prefix `deepseek-` / `github_copilot/`), so they stay in sync with
  `litellm_config.yaml`; `--models a,b,c` overrides explicitly. The alias becomes
  `<group>-budget-<user_id>`, so one user can hold one key per group. User-level
  model access is the **union** of all groups granted, and the weekly cap lives
  on the user — i.e. it aggregates across that user's groups.
- **`--create`** (default) **revokes the previous key for the user+group before
  minting a new one**, so there's always exactly one valid key per user per
  group — it *rotates* rather than accumulating keys. This matters because each
  key carries its *own* 5-hour window; without rotation, many keys could spread
  usage to sidestep the 5h cap (the weekly cap is user-level and stays
  aggregate-safe regardless). Trade-off: you get a new secret, so re-paste it
  into the extension, and the 5h spend resets to $0.
- **`--update`** changes the caps on the **existing** key in place (found via the
  alias, identified by its hashed token — no plaintext needed). The `sk-...` value,
  accumulated spend, and reset window are all **preserved** — nothing to re-paste.
  Use this to adjust a limit without rotating the secret.

### Two caveats

1. **Budgets are dollar-based**, not request/token-based. LiteLLM converts
   DeepSeek token usage to cost via the model's pricing, so you express limits
   in dollars. (RPM/TPM exist but are per-minute, not 5h/weekly.)
2. **Fixed-reset window, not a true sliding window.** The counter resets every
   `budget_duration` from a reset timestamp, whereas Claude Code uses a rolling
   window. Behavior is very close but not identical at the reset boundary.

## 6. GitHub Copilot models (credit-based pricing)

The config also exposes `github_copilot/*` chat models through the proxy, with
spend tracking that works in the same budget windows as DeepSeek.

### How billing works

GitHub moved Copilot to **credit-based billing**: 1 AI credit = $0.01, and each
model has per-token rates (input / cached input / output — Anthropic models also
have a cache-write rate). Rates are published at
[docs.github.com → Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).

litellm (1.88.1, and upstream `main` as of June 2026) has **no built-in prices**
for `github_copilot/*` — all entries are null and there is no upstream PR — so
`litellm/litellm_config.yaml` supplies them per model, exactly like the DeepSeek
V4 entries. Update those numbers if GitHub revises the tables.

Notes on specific entries:

- **GPT-5.4 / GPT-5.5** are priced at the *Default* tier. GitHub bills a higher
  *Long context* tier for large inputs, but litellm encodes one flat rate per
  entry — long-context usage is therefore under-counted locally.
- **`gpt-4.1`, `gpt-4o`, `gpt-4o-mini`** have no published per-token rates
  (legacy/included models) — litellm records **$0 spend** for them, so budgets
  do not constrain these.

### Auth

No API key: litellm's `github_copilot` provider runs a one-time OAuth
**device-code login** on first use (prints a `github.com/login/device` code —
works over SSH). Tokens are cached in `~/.config/litellm/github_copilot/`.

### Verifying model IDs and quota: `verify-copilot-models.sh`

GitHub's docs use marketing names ("GPT-5.4 (Default)"), not API IDs. The
ground truth is Copilot's `/models` endpoint. `./litellm/verify-copilot-models.sh`
queries it using the endpoints documented by the bundled
`copilot-api/` project (reverse-engineered Copilot proxy):

1. Reuses the cached GitHub token (litellm's or copilot-api's) and exchanges it
   at `api.github.com/copilot_internal/v2/token` for a short-lived bearer.
2. Lists `api.githubcopilot.com/models` — exact model IDs, context/output
   limits, capabilities (`--json` for the raw payload).
3. Shows your plan's quota from `api.github.com/copilot_internal/user`.

Verified mappings (2026-06): "GPT-5.4 (Default/Long context)" is the single ID
`gpt-5.4` (400K ctx); Claude Opus 4.6–4.8 / Sonnet 4.6 are 264K ctx; Gemini 3.1
Pro's ID carries a `-preview` suffix. Claude Fable 5, GPT-5.4 nano, Raptor mini
and MAI-Code-1 were not available on this plan.

### Relationship to GitHub's own metering

GitHub already enforces plan limits server-side (this account: Copilot Business,
`premium_interactions` 20K/month, monthly reset — shown by the verify script).
Local litellm budgets add your own 5h/weekly *shape* on top; they do not replace
GitHub's cap, and GitHub's cap does not respect your local windows.

## Troubleshooting: `"No connected db."`

This error had **two** root causes during setup:

1. **`database_url: "sqlite:///litellm.db"`** — LiteLLM's proxy DB only supports
   PostgreSQL (via Prisma), **not SQLite**. The original config pointed at SQLite,
   so the proxy thought it had a DB but could never connect. **Fix:** either run
   the real PostgreSQL setup (section 5, `database_url: os.environ/DATABASE_URL`),
   or — for basic mode — remove `database_url` entirely so the proxy runs
   stateless.

2. **`${VAR}` env syntax** — LiteLLM only expands env vars written as
   **`os.environ/VAR`**, not `${VAR}`. With `${LITELLM_MASTER_KEY}`, the master
   key was the literal string `"${LITELLM_MASTER_KEY}"`, so the extension's key
   never matched and the request fell through to a DB key-lookup →
   `"No connected db."`. **Fix:** use `os.environ/LITELLM_MASTER_KEY` (and the
   same for the API keys).

## Troubleshooting: proxy hangs on startup (extension can't connect)

After enabling `database_url`, the proxy can hang during boot and never reach
"Application startup complete", so the extension reports a connection failure.

- **Cause:** on startup LiteLLM runs a Prisma schema migration
  (`PrismaManager.setup_database`) whenever it finds both `DATABASE_URL` and the
  `prisma` CLI on `PATH`. That migration step was hanging.
- **Fix:** set `disable_prisma_schema_update: true` in `general_settings` and let
  `setup-litellm-proxy.sh` own the schema (`prisma db push`). The proxy then just
  connects — no on-boot migration.
- **Related gotcha:** LiteLLM detects Prisma by running the bare command
  `prisma` (`subprocess.run(["prisma"])`), so `.venv-litellm/bin` must be on
  `PATH` — i.e. activate the venv (`source .venv-litellm/bin/activate`) before
  launching, or the proxy logs `"prisma package not found"`.

## Notes

- `set_verbose: true` is deprecated in LiteLLM 1.88+. For debug logs, set
  `LITELLM_LOG=DEBUG` instead.
- No extra Python packages need installing for either mode — `litellm[proxy]`
  (including `prisma`) is already in `.venv-litellm`.
- PostgreSQL/Redis are managed by systemd (`systemctl status postgresql
  redis-server`). Generated credentials live in `.env.litellm-db`.
