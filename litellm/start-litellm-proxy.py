#!/usr/bin/env python3
"""
Start the LiteLLM proxy for the VS Code Copilot Chat extension.

Usage:
  ./litellm/start-litellm-proxy.py            # uses port 4000
  ./litellm/start-litellm-proxy.py 8000       # custom port

API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY) and LITELLM_MASTER_KEY are read
from the environment — e.g. exported in your ~/.bashrc. A local .env, if
present, is sourced as a convenience and does NOT override existing values.

(Equivalent to start-litellm-proxy.sh / .ts.)
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)

port = sys.argv[1] if len(sys.argv) > 1 else "4000"
config = "litellm/litellm_config.yaml"
venv_litellm = ROOT / ".venv-litellm/bin/litellm"

# Put the venv's bin on PATH so LiteLLM can find the `prisma` CLI on startup
# (it detects Prisma via `subprocess.run(["prisma"])`). This means you do NOT
# have to `source .venv-litellm/bin/activate` first.
os.environ["PATH"] = f"{ROOT}/.venv-litellm/bin:{os.environ.get('PATH', '')}"

if not os.access(venv_litellm, os.X_OK):
    sys.exit(f"ERROR: {venv_litellm} not found. Did you create the .venv-litellm environment?")

# Source generated DB/Redis credentials and a local .env, letting the existing
# environment win. .env.litellm-db is written by setup-litellm-proxy.
for envfile in (".env.litellm-db", ".env"):
    p = ROOT / envfile
    if not p.is_file():
        continue
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        if not os.environ.get(key):  # only if not already set
            os.environ[key] = val

# Warn (don't fail) about anything still missing, so issues are obvious.
for v in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
    if not os.environ.get(v):
        print(f"WARNING: {v} is not set — calls to that provider's models will fail.", file=sys.stderr)
if not os.environ.get("LITELLM_MASTER_KEY"):
    sys.exit("ERROR: LITELLM_MASTER_KEY is not set (export it in ~/.bashrc or .env).")

print(f"Starting LiteLLM proxy on http://localhost:{port} (config: {config})")
print(f"Use this master key as the API key in the VS Code extension: {os.environ['LITELLM_MASTER_KEY']}")
sys.stdout.flush()  # execve does not flush Python's buffers; force the banner out first
sys.stderr.flush()
# Replace this process with the proxy (like `exec` in the shell version).
os.execve(str(venv_litellm), [str(venv_litellm), "--config", config, "--port", str(port)], os.environ)
