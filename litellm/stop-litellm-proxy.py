#!/usr/bin/env python3
"""
stop-litellm-proxy.py — stop the local LiteLLM proxy.

Stops the proxy started by start-litellm-proxy / litellm-up (foreground or
background). Sends SIGTERM for a graceful shutdown, then SIGKILL if it lingers.

Usage:
  ./litellm/stop-litellm-proxy.py            # port 4000
  ./litellm/stop-litellm-proxy.py 8000       # custom port

(Equivalent to stop-litellm-proxy.sh / .ts.)
"""

import os
import signal
import sys
import time

port = sys.argv[1] if len(sys.argv) > 1 else "4000"


def find_pids(port: str) -> list[int]:
    """PIDs of litellm proxy processes serving this exact port (via /proc)."""
    me = os.getpid()
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == me:
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = [p.decode("utf-8", "replace") for p in f.read().split(b"\x00") if p]
        except OSError:
            continue
        if not cmd or "litellm" not in " ".join(cmd) or "--port" not in cmd:
            continue
        try:
            if cmd[cmd.index("--port") + 1] == port:
                pids.append(pid)
        except (ValueError, IndexError):
            pass
    return pids


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


pids = find_pids(port)
if not pids:
    print(f"No LiteLLM proxy found on port {port}.")
    sys.exit(0)

print(f"Stopping LiteLLM proxy on port {port} (PID(s): {' '.join(map(str, pids))})")
for p in pids:
    try:
        os.kill(p, signal.SIGTERM)
    except ProcessLookupError:
        pass

# Wait up to 10s for graceful exit, then force-kill any survivors.
for _ in range(10):
    survivors = [p for p in pids if alive(p)]
    if not survivors:
        print("Stopped.")
        sys.exit(0)
    time.sleep(1)

print(f"Force-killing: {' '.join(map(str, survivors))}")
for p in survivors:
    try:
        os.kill(p, signal.SIGKILL)
    except ProcessLookupError:
        pass
print("Stopped.")
