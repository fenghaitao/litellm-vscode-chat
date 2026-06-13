#!/usr/bin/env bun
/**
 * stop-litellm-proxy.ts — stop the local LiteLLM proxy.
 *
 * Stops the proxy started by start-litellm-proxy / litellm-up (foreground or
 * background). Sends SIGTERM for a graceful shutdown, then SIGKILL if it lingers.
 *
 * Usage:
 *   ./litellm/stop-litellm-proxy.ts            # port 4000
 *   ./litellm/stop-litellm-proxy.ts 8000       # custom port
 *
 * (Equivalent to stop-litellm-proxy.sh / .py.)
 */

import { readdirSync, readFileSync } from "node:fs";

const port = process.argv[2] ?? "4000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PIDs of litellm proxy processes serving this exact port (via /proc). */
function findPids(port: string): number[] {
	const me = process.pid;
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === me) continue;
		let cmd: string[];
		try {
			cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
		} catch {
			continue;
		}
		const i = cmd.indexOf("--port");
		if (cmd.length && cmd.join(" ").includes("litellm") && i >= 0 && cmd[i + 1] === port) {
			pids.push(pid);
		}
	}
	return pids;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const pids = findPids(port);
if (pids.length === 0) {
	console.log(`No LiteLLM proxy found on port ${port}.`);
	process.exit(0);
}

console.log(`Stopping LiteLLM proxy on port ${port} (PID(s): ${pids.join(" ")})`);
for (const p of pids) {
	try {
		process.kill(p, "SIGTERM");
	} catch {
		/* already gone */
	}
}

// Wait up to 10s for graceful exit, then force-kill any survivors.
let survivors: number[] = [];
for (let i = 0; i < 10; i++) {
	survivors = pids.filter(alive);
	if (survivors.length === 0) {
		console.log("Stopped.");
		process.exit(0);
	}
	await sleep(1000);
}

console.log(`Force-killing: ${survivors.join(" ")}`);
for (const p of survivors) {
	try {
		process.kill(p, "SIGKILL");
	} catch {
		/* already gone */
	}
}
console.log("Stopped.");
