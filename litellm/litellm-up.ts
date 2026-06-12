#!/usr/bin/env bun
/**
 * litellm-up.ts — one command, just the two limits.
 * -------------------------------------------------
 * Brings the whole budgeted-proxy stack up from a single invocation:
 *
 *   1. Sets up PostgreSQL + Redis if not already done (setup-litellm-proxy.ts).
 *   2. Starts the proxy in the background if it isn't already running.
 *   3. Ensures a budgeted virtual key for each model group (deepseek + copilot)
 *      with the given 5-hour and weekly caps — created if missing, updated in
 *      place otherwise (so re-running with new limits never rotates a secret).
 *   4. Prints the keys to paste into the VS Code extension.
 *
 * Usage:
 *   ./litellm/litellm-up.ts [window_usd] [weekly_usd]
 *
 * Defaults: window_usd=3 (the 5h cap), weekly_usd=20 (the 1-week cap).
 * Env: PORT (default 4000), BASE, BUDGET_USER (default "haitao"),
 *      GROUPS (comma list, default "deepseek,copilot").
 *
 * Each group gets its OWN user (`<BUDGET_USER>_<group>`), so the weekly buckets
 * are independent. Re-run any time you want to change the limits.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, openSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
process.chdir(ROOT);

const windowUsd = process.argv[2] ?? "3";
const weeklyUsd = process.argv[3] ?? "20";
const baseUser = process.env.BUDGET_USER ?? "haitao";
const port = process.env.PORT ?? "4000";
const base = process.env.BASE ?? `http://localhost:${port}`;
const groups = (process.env.GROUPS ?? "deepseek,copilot")
	.split(",")
	.map((g) => g.trim())
	.filter(Boolean);
const window = "5h";
const SECRETS_FILE = resolve(ROOT, ".litellm-budget-keys.json");
const PROXY_LOG = resolve(ROOT, ".litellm-proxy.log");

const bun = process.execPath; // run sibling .ts via the same bun binary
const step = (msg: string) => console.log(`\n\x1b[1;36m┃\x1b[0m \x1b[1m${msg}\x1b[0m`);
const die = (msg: string): never => {
	console.error(`\x1b[1;31m${msg}\x1b[0m`);
	process.exit(1);
};

function runInherit(script: string, args: string[]): void {
	const r = spawnSync(bun, [resolve(HERE, script), ...args], { stdio: "inherit" });
	if (r.status !== 0) die(`ERROR: ${script} ${args.join(" ")} failed (exit ${r.status}).`);
}

async function healthy(): Promise<boolean> {
	try {
		const r = await fetch(`${base}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Databases ---------------------------------------------------------------
if (existsSync(SECRETS_FILE) || existsSync(resolve(ROOT, ".env.litellm-db"))) {
	step("Databases: credentials present — skipping setup");
} else {
	step("Databases: first-time setup (PostgreSQL + Redis)");
	runInherit("setup-litellm-proxy.ts", []);
}

// 2. Proxy -------------------------------------------------------------------
if (await healthy()) {
	step(`Proxy: already running at ${base}`);
} else {
	step(`Proxy: starting in background → ${PROXY_LOG}`);
	const out = openSync(PROXY_LOG, "a");
	const child = spawn(bun, [resolve(HERE, "start-litellm-proxy.ts"), port], {
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	process.stdout.write("   waiting for readiness");
	let up = false;
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		process.stdout.write(".");
		if (await healthy()) {
			up = true;
			break;
		}
	}
	console.log("");
	if (!up) die(`ERROR: proxy did not become healthy within 60s. Check ${PROXY_LOG}.`);
	console.log(`   ready (pid ${child.pid}); logs: ${PROXY_LOG}`);
}

// 3. Budget keys -------------------------------------------------------------
step(`Budget keys: ${window} cap $${windowUsd}, weekly cap $${weeklyUsd} (per group)`);
for (const group of groups) {
	const user = `${baseUser}_${group}`;
	console.log(`\n  • ${group} (user ${user})`);
	runInherit("manage-budget-key.ts", ["--ensure", "--group", group, user, weeklyUsd, windowUsd, window]);
}

// 4. Summary -----------------------------------------------------------------
let secrets: Record<string, string> = {};
try {
	secrets = JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
} catch {
	/* no store yet */
}

console.log(
	`\n\x1b[1;32m✅ Everything is up.\x1b[0m  Paste each key into a VS Code server entry (Base URL ${base}):\n`
);
const rows = groups.map((g) => {
	const alias = `${g}-budget-${baseUser}_${g}`;
	return [g, `${baseUser}_${g}`, secrets[alias] ?? "(secret not in local store — rotate with --create to reveal)"];
});
const head = ["GROUP", "USER", "KEY"];
const table = [head, ...rows];
const w = head.map((_, i) => Math.max(...table.map((r) => r[i].length)));
table.forEach((r, i) => {
	console.log("  " + r.map((c, j) => c.padEnd(w[j])).join("  "));
	if (i === 0) console.log("  " + w.map((n) => "-".repeat(n)).join("  "));
});
console.log(
	`\nManage later:\n` +
		`  • change limits (no re-paste):  ./litellm/litellm-up.ts <window_usd> <weekly_usd>\n` +
		`  • see all keys + spend:         ./litellm/manage-budget-key.ts --list\n` +
		(existsSync(PROXY_LOG) ? `  • proxy logs:                   ${PROXY_LOG}\n` : "")
);
