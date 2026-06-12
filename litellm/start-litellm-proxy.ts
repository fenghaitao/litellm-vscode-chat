#!/usr/bin/env bun
/**
 * Start the LiteLLM proxy for the VS Code Copilot Chat extension.
 *
 * Usage:
 *   ./litellm/start-litellm-proxy.ts            # uses port 4000
 *   ./litellm/start-litellm-proxy.ts 8000       # custom port
 *
 * API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY) and LITELLM_MASTER_KEY are read
 * from the environment — e.g. exported in your ~/.bashrc. A local .env, if
 * present, is sourced as a convenience and does NOT override existing values.
 *
 * (Equivalent to start-litellm-proxy.sh / .py.)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const port = process.argv[2] ?? "4000";
const config = "litellm/litellm_config.yaml";
const venvLitellm = resolve(ROOT, ".venv-litellm/bin/litellm");

// Put the venv's bin on PATH so LiteLLM can find the `prisma` CLI on startup
// (it detects Prisma via `subprocess.run(["prisma"])`). This means you do NOT
// have to `source .venv-litellm/bin/activate` first.
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${ROOT}/.venv-litellm/bin:${process.env.PATH ?? ""}` };

try {
	accessSync(venvLitellm, constants.X_OK);
} catch {
	console.error(`ERROR: ${venvLitellm} not found. Did you create the .venv-litellm environment?`);
	process.exit(1);
}

// Source generated DB/Redis credentials and a local .env, letting the existing
// environment win. .env.litellm-db is written by setup-litellm-proxy.
for (const envfile of [".env.litellm-db", ".env"]) {
	const p = resolve(ROOT, envfile);
	if (!existsSync(p)) continue;
	for (const line of readFileSync(p, "utf8").split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#") || !t.includes("=")) continue;
		const idx = t.indexOf("=");
		const key = t.slice(0, idx);
		const val = t.slice(idx + 1);
		if (!env[key]) env[key] = val; // only if not already set
	}
}

// Warn (don't fail) about anything still missing, so issues are obvious.
for (const v of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
	if (!env[v]) console.error(`WARNING: ${v} is not set — calls to that provider's models will fail.`);
}
if (!env.LITELLM_MASTER_KEY) {
	console.error("ERROR: LITELLM_MASTER_KEY is not set (export it in ~/.bashrc or .env).");
	process.exit(1);
}

console.log(`Starting LiteLLM proxy on http://localhost:${port} (config: ${config})`);
console.log(`Use this master key as the API key in the VS Code extension: ${env.LITELLM_MASTER_KEY}`);

// bun/node can't exec-replace the process, so spawn with inherited stdio,
// forward termination signals, and exit with the child's status.
const child = spawn(venvLitellm, ["--config", config, "--port", String(port)], { stdio: "inherit", env });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
