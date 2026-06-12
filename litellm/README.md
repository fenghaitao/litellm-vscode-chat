# LiteLLM budgeted proxy — Claude-Code-style 5h + weekly limits

A local LiteLLM proxy that gives each model group its own **5-hour** and
**weekly** spending caps. A request is rejected (HTTP 429 `budget_exceeded`) as
soon as **either** cap is exhausted — mirroring Claude Code's two-tier limits.

- a **weekly cap** — enforced on the *user* (aggregates across all their keys)
- a **window cap** (default 5 hours) — enforced on the *key*

## Quick start — one command

If you just want it up with a 5h and a weekly dollar limit, run:

```bash
./litellm/litellm-up.ts 3 20      # $3 / 5h  +  $20 / week  (per group)
```

[`litellm-up.ts`](litellm-up.ts) (bun) does the whole flow: sets up
PostgreSQL + Redis if needed, starts the proxy in the background if it isn't
running, then ensures a budgeted key for each group (deepseek + copilot) —
**created if missing, updated in place otherwise**, so re-running with new
limits never rotates a secret. It prints the keys to paste into the extension.
Each group gets its own user, so the weekly buckets are independent.

The sections below cover the individual pieces `litellm-up.ts` orchestrates.

> Full proxy setup (Postgres/Redis, pricing, troubleshooting) lives in
> [LITELLM_SETUP.md](LITELLM_SETUP.md).

## manage-budget-key — mint / update / list keys

Three equivalent implementations of the key tool. Each mints (or updates) a
**virtual key** on the proxy with the two layered caps above.

## Pick an implementation

| Script | Runtime | Model groups |
| --- | --- | --- |
| [`manage-budget-key.sh`](manage-budget-key.sh) | bash + curl | DeepSeek only |
| [`manage-budget-key.py`](manage-budget-key.py) | python3 (stdlib only) | `--group deepseek\|copilot`, `--models` |
| [`manage-budget-key.ts`](manage-budget-key.ts) | [bun](https://bun.sh) | `--group deepseek\|copilot`, `--models` |

All three share the same CLI shape and behave identically for DeepSeek. Use the
Python or TypeScript port if you want GitHub Copilot keys or a custom model
list; the Bash original is kept for curl-only environments.

## Prerequisites

- The proxy is running: `./litellm/start-litellm-proxy.sh` (or the equivalent
  `.py` / `.ts` port; default `http://localhost:4000`; override with `BASE`).
  One-time DB setup: `./litellm/setup-litellm-proxy.{sh,py,ts}`.
- `LITELLM_MASTER_KEY` is exported, or present in `.env` at the repo root
  (the scripts read it from there automatically). The master key is required —
  these scripts are admin tooling.

## Usage

```text
manage-budget-key.{sh,py,ts} [--create|--update|--ensure|--list] [--group G] [--models a,b]
                             [user_id] [weekly_usd] [window_usd] [window]
```

Defaults: `--create`, `--group deepseek`, `user_id=haitao`, `weekly_usd=20`,
`window_usd=3`, `window=5h`. (`--group`/`--models`/`--list` are `.py`/`.ts` only.)
`--ensure` = update if the key exists, else create — the re-runnable mode
[`litellm-up.ts`](litellm-up.ts) uses.
`window`/`WEEKLY_DURATION` accept litellm durations: `s, m, h, d, w, mo`.

### Common tasks

```bash
# First key (DeepSeek, $20/week + $3/5h, user haitao) — prints the sk-... key
./litellm/manage-budget-key.py

# Change the caps WITHOUT changing the key (nothing to re-paste; spend kept)
./litellm/manage-budget-key.py --update haitao 20 5

# Rotate the secret (revokes the old key, prints a new one — re-paste it)
./litellm/manage-budget-key.py --create haitao 20 3 5h

# A GitHub Copilot key for the same user (its own 5h window; weekly cap shared)
./litellm/manage-budget-key.py --group copilot haitao 20 5 5h

# Another user, custom window
./litellm/manage-budget-key.py --create bob 50 8 8h

# Explicit model list instead of a group preset
./litellm/manage-budget-key.py --models deepseek-v4-pro haitao 20 3 5h

# List every managed key as a table (budgets + spend; never the secret)
./litellm/manage-budget-key.py --list
./litellm/manage-budget-key.py --list --group copilot   # filter to one group

# Same things via the TypeScript or Bash variants
./litellm/manage-budget-key.ts --group copilot haitao 20 5
./litellm/manage-budget-key.sh --update haitao 20 5
```

`--list` output (`KEY` shows the full secret when known, else masked):

```text
USER             GROUP     MODELS  WINDOW    WIN SPENT  WEEKLY     WK SPENT  KEY                        ALIAS
haitao_copilot   copilot   11      $5.00/5h  $0.00      $20.00/1w  $0.00     sk-W0hxupNx3DVKRQJxb60dew  copilot-budget-haitao_copilot
haitao_deepseek  deepseek  2       $3.00/5h  $0.00      $20.00/1w  $0.00     sk-sEklxSF1MaXpscfNbuC5Lg  deepseek-budget-haitao_deepseek
```

> **How `--list` knows the full secret:** litellm stores only a one-way **hash**
> of each key, so the plaintext can never be recovered from the proxy. To make
> `--list` useful, `--create` saves each minted secret to a local file
> **`.litellm-budget-keys.json`** (repo root, `chmod 600`, git-ignored). `--list`
> reads from it. Keys created before this store existed (or elsewhere) show as
> `sk-...XXXX (masked)` — those secrets are genuinely unrecoverable; rotate with
> `--create` to mint (and record) a fresh one.
>
> Treat `.litellm-budget-keys.json` like any secret file — it holds usable keys
> in plaintext, same posture as `.env`/`.env.litellm-db` on this dev box.

Paste the printed `sk-...` into the VS Code extension (**Manage LiteLLM
Provider** → API key, Base URL `http://localhost:4000`). Don't chat with the
master key — it bypasses every budget.

## `--create` vs `--update` vs `--ensure`

| | `--create` (default) | `--update` | `--ensure` |
| --- | --- | --- | --- |
| Key value (`sk-...`) | **new** — re-paste | unchanged | unchanged if it exists, else new |
| Accumulated window spend | resets to $0 | **preserved** | preserved if it exists |
| Old key | **revoked** (rotation) | n/a | revoked only when creating |
| Use when | issuing / rotating a secret | adjusting limits | re-runnable automation |

`--create` always **revokes the previous key first**, so there is exactly one
valid key per user per group — re-running can't accumulate keys, each with its
own fresh 5h window (which would otherwise let usage dodge the window cap).

`--ensure` = "update if it exists, else create" — the idempotent mode
[`litellm-up.ts`](litellm-up.ts) uses so changing a limit never forces a
re-paste.

## How it works

- Each key is tagged with a deterministic alias **`<group>-budget-<user_id>`**
  (e.g. `deepseek-budget-haitao`). The alias is how the scripts find, revoke,
  and update the key later — LiteLLM stores only a SHA-256 of the secret, so
  the plaintext can never be recovered, only rotated.
- `--update` resolves the alias to the key's *hashed token* via `/user/info`
  and edits it with `/key/update` — no plaintext needed.
- The weekly cap is set on the **user** (`/user/new` / `/user/update`), the
  window cap on the **key** (`/key/generate`), so both gates apply to every
  request. Spend is metered from provider-reported token usage × the per-token
  prices in [litellm_config.yaml](litellm_config.yaml).
- For `.py`/`.ts`, group model lists are fetched **live from the proxy**
  (`/v1/models` filtered by prefix `deepseek-` / `github_copilot/`), so they
  track `litellm_config.yaml` automatically. User-level model access is the
  **union** of all groups granted to that user.

## Gotchas

- **Budgets are dollars, not tokens** — and only as accurate as the per-token
  prices in the config (DeepSeek V4 and Copilot prices are hand-entered there).
- **Copilot legacy models meter $0** (`gpt-4.1`, `gpt-4o`, `gpt-4o-mini` have no
  published rates) — budgets can't constrain them; use `rpm_limit`/`tpm_limit`
  on the key if you need to cap them.
- **Windows are fixed-reset, not sliding** — the counter resets every
  `budget_duration` (checked roughly every 10 minutes by the proxy), slightly
  different from Claude Code's rolling windows at the boundary.
- **The weekly cap is per user, not per key** — a user holding both a DeepSeek
  and a Copilot key shares one weekly bucket across them.
