#!/usr/bin/env bun
/**
 * setup-litellm-proxy.ts
 * ----------------------
 * One-shot, idempotent setup of the databases LiteLLM needs for budgets and
 * rate limiting (Claude-Code-style 5h / weekly windows):
 *
 *   - PostgreSQL  -> persistent virtual keys, budgets, spend tracking
 *   - Redis       -> distributed spend / TPM / RPM counters across workers
 *
 * Native apt install (no Docker). Tested on Ubuntu 24.04 + systemd.
 * Re-running is safe: existing packages, roles, and generated passwords reused.
 *
 * Output: writes connection details to .env.litellm-db (chmod 600, git-ignored).
 * After this, run ./litellm/start-litellm-proxy.ts — LiteLLM auto-creates its
 * tables on first boot.
 *
 * (Equivalent to setup-litellm-proxy.sh / .py.)
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, accessSync, constants, globSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const PG_DB = "litellm_proxy";
const PG_USER = "litellm";
const PG_HOST = "127.0.0.1";
const PG_PORT = "5432";
const REDIS_HOST = "127.0.0.1";
const REDIS_PORT = "6379";
const ENV_FILE = resolve(ROOT, ".env.litellm-db");
const REDIS_CONF = "/etc/redis/redis.conf";

const log = (msg: string) => console.log(`\n\x1b[1;34m==>\x1b[0m ${msg}`);
const die = (msg: string): never => {
	console.error(msg);
	process.exit(1);
};
const have = (cmd: string) => spawnSync("command", ["-v", cmd], { shell: true }).status === 0;
const genpw = () => randomBytes(16).toString("hex");

/** Run a command, exiting on non-zero status (like `set -e`). stdio inherited. */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): void {
	const r = spawnSync(cmd, args, {
		stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
		env: opts.env ?? process.env,
		input: opts.input,
	});
	if (r.status !== 0) die(`ERROR: command failed (${r.status}): ${cmd} ${args.join(" ")}`);
}
/** Run a command and capture stdout (string). */
function capture(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { status: number; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8", env: env ?? process.env });
	return { status: r.status ?? 1, out: r.stdout ?? "" };
}

// 0. Sanity: this script needs sudo and apt (Debian/Ubuntu).
if (!have("apt-get")) die("ERROR: apt-get not found. This script targets Debian/Ubuntu.");
if (spawnSync("sudo", ["-n", "true"]).status !== 0)
	console.error("NOTE: sudo may prompt for your password during installation.");

// 1. Reuse previously generated passwords if the env file already exists.
let pgPassword = "";
let redisPassword = "";
if (existsSync(ENV_FILE)) {
	log(`Reusing existing credentials from .env.litellm-db`);
	for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
		const m = line.trim().match(/^(\w+)=(.*)$/);
		if (m && m[1] === "PG_PASSWORD") pgPassword = m[2];
		if (m && m[1] === "REDIS_PASSWORD") redisPassword = m[2];
	}
}
pgPassword ||= genpw();
redisPassword ||= genpw();

// 2. Install PostgreSQL and Redis if missing.
const toInstall = [
	["postgresql", "psql"],
	["redis-server", "redis-server"],
]
	.filter(([, cmd]) => !have(cmd))
	.map(([pkg]) => pkg);
if (toInstall.length) {
	log(`Installing: ${toInstall.join(" ")}`);
	run("sudo", ["apt-get", "update", "-y"]);
	run("sudo", ["apt-get", "install", "-y", ...toInstall], {
		env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
	});
} else {
	log("PostgreSQL and Redis already installed — skipping apt install");
}

// 3. Ensure both services are enabled and running.
log("Enabling and starting services");
run("sudo", ["systemctl", "enable", "--now", "postgresql"]);
run("sudo", ["systemctl", "enable", "--now", "redis-server"]);

// 4. Create the PostgreSQL role and database (idempotent).
log(`Configuring PostgreSQL role '${PG_USER}' and database '${PG_DB}'`);
const roleSql = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${pgPassword}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${pgPassword}';
  END IF;
END
$$;`;
run("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-q"], { input: roleSql });
// CREATE DATABASE can't run inside a DO/transaction block, so guard it.
const dbExists = capture("sudo", [
	"-u",
	"postgres",
	"psql",
	"-tAc",
	`SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'`,
]).out;
if (!dbExists.includes("1")) {
	run("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${PG_DB} OWNER ${PG_USER};`]);
}

// 5. Set a Redis password (requirepass) so local processes can't read counters.
log("Configuring Redis authentication");
if (spawnSync("sudo", ["test", "-f", REDIS_CONF]).status === 0) {
	const already = spawnSync("sudo", ["grep", "-qxF", `requirepass ${redisPassword}`, REDIS_CONF]).status === 0;
	if (!already) {
		run("sudo", ["sed", "-i", "/^requirepass /d", REDIS_CONF]);
		run("sudo", ["tee", "-a", REDIS_CONF], { input: `requirepass ${redisPassword}\n` });
		run("sudo", ["systemctl", "restart", "redis-server"]);
	}
} else {
	console.error(`WARNING: ${REDIS_CONF} not found; Redis left without a password.`);
	redisPassword = "";
}

// 6. Write the generated connection details (git-ignored via .env.*).
const DATABASE_URL = `postgresql://${PG_USER}:${pgPassword}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
log("Writing .env.litellm-db");
writeFileSync(
	ENV_FILE,
	`# Generated by setup-litellm-proxy — DO NOT COMMIT (matched by .gitignore '.env.*').
# Sourced automatically by start-litellm-proxy.
PG_PASSWORD=${pgPassword}
REDIS_PASSWORD=${redisPassword}
DATABASE_URL=${DATABASE_URL}
REDIS_HOST=${REDIS_HOST}
REDIS_PORT=${REDIS_PORT}
`
);
chmodSync(ENV_FILE, 0o600);

// 7. Create / update LiteLLM's tables (prisma db push).
log("Creating/updating LiteLLM tables (prisma db push)");
const schema = globSync(resolve(ROOT, ".venv-litellm/lib/python3.*/site-packages/litellm/proxy/schema.prisma"))[0];
const prisma = resolve(ROOT, ".venv-litellm/bin/prisma");
let prismaOk = false;
try {
	accessSync(prisma, constants.X_OK);
	prismaOk = true;
} catch {
	prismaOk = false;
}
if (schema && prismaOk) {
	run(prisma, ["db", "push", "--schema", schema, "--accept-data-loss", "--skip-generate"], {
		env: { ...process.env, DATABASE_URL, PATH: `${ROOT}/.venv-litellm/bin:${process.env.PATH ?? ""}` },
	});
} else {
	console.error("WARNING: prisma CLI or schema not found; tables will be created on first proxy boot.");
}

// 8. Verify connectivity.
log("Verifying PostgreSQL connection");
const pg = capture(
	"psql",
	["-h", PG_HOST, "-p", PG_PORT, "-U", PG_USER, "-d", PG_DB, "-tAc", "SELECT 'postgres connection OK'"],
	{ ...process.env, PGPASSWORD: pgPassword }
);
if (pg.status !== 0) die("ERROR: cannot connect to Postgres");
console.log(pg.out.trim());

log("Verifying Redis connection");
const redisEnv = { ...process.env, ...(redisPassword ? { REDISCLI_AUTH: redisPassword } : {}) };
console.log(capture("redis-cli", ["-h", REDIS_HOST, "-p", REDIS_PORT, "ping"], redisEnv).out.trim());

console.log(`
✅ Databases ready.

  PostgreSQL : ${PG_HOST}:${PG_PORT}  db=${PG_DB}  user=${PG_USER}
  Redis      : ${REDIS_HOST}:${REDIS_PORT}  (password set)
  Credentials: .env.litellm-db

Next steps:
  1. Make sure litellm/litellm_config.yaml has 'database_url: os.environ/DATABASE_URL'
     and the redis cache block (already configured if you used the provided config).
  2. Start the proxy:   ./litellm/start-litellm-proxy.ts
     (LiteLLM auto-creates its tables on first boot.)
  3. Create budget-scoped keys — see litellm/LITELLM_SETUP.md "Budgets & rate limits".`);
