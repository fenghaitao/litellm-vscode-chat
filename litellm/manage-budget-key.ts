#!/usr/bin/env bun
/**
 * manage-budget-key.ts
 * --------------------
 * Manage a model-group-scoped LiteLLM virtual key with Claude-Code-style
 * layered budgets:
 *
 *   - a weekly cap   (enforced on the user)
 *   - a window cap   (default 5h, enforced on the key)
 *
 * The key blocks when EITHER limit is hit.
 *
 * Modes:
 *   --create  (default)  Revoke any existing key for the user+group and mint
 *                        a NEW one. New sk-... value, window spend restarts at $0.
 *   --update             Change the budgets on the EXISTING key in place. Same
 *                        sk-... value; accumulated spend and reset window kept.
 *   --list               Show all managed budget keys as a table (budgets +
 *                        spend; only a masked key is shown). --group filters.
 *
 * Model groups (--group, default "deepseek"):
 *   deepseek  -> models from the proxy whose id starts with "deepseek-"
 *   copilot   -> models whose id starts with "github_copilot/"
 *   (--models a,b,c overrides the list explicitly)
 *
 * The group also names the key alias: "<group>-budget-<user_id>", which is how
 * one budgeted key per user per group is found and rotated without its
 * plaintext. The weekly cap lives on the USER, so it aggregates across all of
 * that user's keys/groups; user-level model access is the union of all groups.
 *
 * Usage:
 *   ./litellm/manage-budget-key.ts [--create|--update] [--group G] [--models a,b]
 *                                  [user_id] [weekly_usd] [window_usd] [window]
 *
 * Defaults: user_id=haitao  weekly_usd=20  window_usd=3  window=5h
 *
 * Requirements: proxy running (BASE, default http://localhost:4000);
 * LITELLM_MASTER_KEY set (sourced from .env at repo root if present).
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GROUP_PREFIXES: Record<string, string> = {
	deepseek: "deepseek-",
	copilot: "github_copilot/",
};
// Local plaintext store of minted secrets, keyed by alias. litellm only stores a
// hash, so this is the only way --list can show full keys. Git-ignored, chmod 600.
const SECRETS_FILE = resolve(ROOT, ".litellm-budget-keys.json");

function loadSecrets(): Record<string, string> {
	try {
		return JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
	} catch {
		return {};
	}
}

function saveSecret(alias: string, key: string): void {
	const secrets = loadSecrets();
	secrets[alias] = key;
	writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
	try {
		chmodSync(SECRETS_FILE, 0o600);
	} catch {
		/* best effort */
	}
}

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

// ---------------------------------------------------------------- arg parse
interface Args {
	mode: "create" | "update" | "list";
	group: string;
	groupExplicit: boolean;
	models?: string;
	userId: string;
	weeklyUsd: number;
	windowUsd: number;
	window: string;
}

function parseArgs(argv: string[]): Args {
	const a: Args = {
		mode: "create",
		group: "deepseek",
		groupExplicit: false,
		userId: "haitao",
		weeklyUsd: 20,
		windowUsd: 3,
		window: "5h",
	};
	const pos: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const t = argv[i];
		if (t === "--create") a.mode = "create";
		else if (t === "--update") a.mode = "update";
		else if (t === "--list") a.mode = "list";
		else if (t === "--group") {
			const v = argv[++i];
			if (!v || !(v in GROUP_PREFIXES))
				fail(`ERROR: --group must be one of: ${Object.keys(GROUP_PREFIXES).join(", ")}`);
			a.group = v;
			a.groupExplicit = true;
		} else if (t === "--models") {
			a.models = argv[++i] ?? fail("ERROR: --models needs a comma-separated list");
		} else if (t === "--help" || t === "-h") {
			console.log(
				"Usage: manage-budget-key.ts [--create|--update|--list] [--group deepseek|copilot] [--models a,b] [user_id] [weekly_usd] [window_usd] [window]"
			);
			process.exit(0);
		} else if (t.startsWith("--")) fail(`ERROR: unknown flag '${t}' (expected --create, --update or --list)`);
		else pos.push(t);
	}
	if (pos[0]) a.userId = pos[0];
	if (pos[1]) a.weeklyUsd = Number(pos[1]);
	if (pos[2]) a.windowUsd = Number(pos[2]);
	if (pos[3]) a.window = pos[3];
	if (!Number.isFinite(a.weeklyUsd) || !Number.isFinite(a.windowUsd)) fail("ERROR: budgets must be numbers");
	return a;
}

// ---------------------------------------------------------------- env / api
function loadMasterKey(): string {
	if (!process.env.LITELLM_MASTER_KEY) {
		const envFile = resolve(ROOT, ".env");
		if (existsSync(envFile)) {
			for (const line of readFileSync(envFile, "utf8").split("\n")) {
				const m = line.trim().match(/^LITELLM_MASTER_KEY=(.*)$/);
				if (m) {
					process.env.LITELLM_MASTER_KEY = m[1];
					break;
				}
			}
		}
	}
	return process.env.LITELLM_MASTER_KEY ?? fail("ERROR: LITELLM_MASTER_KEY is not set (export it or put it in .env).");
}

const BASE = process.env.BASE ?? "http://localhost:4000";
const WEEKLY_DURATION = process.env.WEEKLY_DURATION ?? "1w";
const MK = loadMasterKey();

async function api(method: string, path: string, body?: unknown, tolerate404 = false): Promise<any> {
	let res: Response;
	try {
		res = await fetch(BASE + path, {
			method,
			headers: { Authorization: `Bearer ${MK}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (e) {
		fail(`ERROR: cannot reach ${BASE} (${e}). Is the proxy running?`);
	}
	if (res.status === 404 && tolerate404) return null;
	if (!res.ok) fail(`ERROR: ${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
	return res.json();
}

// ---------------------------------------------------------------- helpers
async function resolveModels(group: string, override?: string): Promise<string[]> {
	if (override)
		return override
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	const prefix = GROUP_PREFIXES[group];
	const data = await api("GET", "/v1/models");
	const models = (data.data ?? []).map((m: { id: string }) => m.id).filter((id: string) => id.startsWith(prefix));
	if (models.length === 0) fail(`ERROR: proxy lists no models with prefix '${prefix}' for group '${group}'.`);
	return models;
}

interface UserState {
	exists: boolean;
	userModels: string[];
	tokenHash?: string;
}

async function userState(userId: string, alias: string): Promise<UserState> {
	// 404 = user doesn't exist yet — that's a normal first-run state.
	const info = await api("GET", `/user/info?user_id=${encodeURIComponent(userId)}`, undefined, true);
	if (info === null) return { exists: false, userModels: [] };
	const userInfo = info.user_info ?? {};
	const keys: Array<{ key_alias?: string; token?: string }> = info.keys ?? [];
	return {
		exists: Object.keys(userInfo).length > 0,
		userModels: userInfo.models ?? [],
		tokenHash: keys.find((k) => k.key_alias === alias)?.token,
	};
}

// ---------------------------------------------------------------- list
function money(v: number | null | undefined): string {
	if (v === null || v === undefined) return "-";
	if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
	return `$${v.toFixed(2)}`;
}

async function listKeys(groupFilter?: string): Promise<void> {
	const data = await api("GET", "/key/list?return_full_object=true&size=100");
	const secrets = loadSecrets();
	const userCache: Record<string, any> = {};
	const rows: string[][] = [];
	for (const k of data.keys ?? []) {
		const alias: string = k.key_alias ?? "";
		if (!alias.includes("-budget-")) continue;
		const group = alias.split("-budget-")[0];
		if (groupFilter && group !== groupFilter) continue;
		const userId: string = k.user_id ?? "";
		if (userId && !(userId in userCache)) {
			const info = await api("GET", `/user/info?user_id=${encodeURIComponent(userId)}`, undefined, true);
			userCache[userId] = info?.user_info ?? {};
		}
		const u = userCache[userId] ?? {};
		rows.push([
			userId,
			group,
			String((k.models ?? []).length),
			`${money(k.max_budget)}/${k.budget_duration ?? ""}`,
			money(k.spend ?? 0),
			`${money(u.max_budget)}/${u.budget_duration ?? ""}`,
			money(u.spend ?? 0),
			secrets[alias] ?? `${k.key_name ?? ""} (masked)`,
			alias,
		]);
	}
	if (rows.length === 0) {
		console.log("No managed budget keys found." + (groupFilter ? ` (group=${groupFilter})` : ""));
		return;
	}
	rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
	const hdr = ["USER", "GROUP", "MODELS", "WINDOW", "WIN SPENT", "WEEKLY", "WK SPENT", "KEY", "ALIAS"];
	const table = [hdr, ...rows];
	const widths = hdr.map((_, i) => Math.max(...table.map((r) => r[i].length)));
	table.forEach((r, ri) => {
		console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));
		if (ri === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
	});
	console.log(`\nNote: full sk-... values come from the local store ${"."}litellm-budget-keys.json (git-ignored),`);
	console.log("populated at --create time. Entries marked '(masked)' predate that store or were");
	console.log("created elsewhere — litellm keeps only a hash, so those secrets can't be recovered.");
}

// ---------------------------------------------------------------- main
const args = parseArgs(process.argv.slice(2));

if (args.mode === "list") {
	await listKeys(args.groupExplicit ? args.group : undefined);
	process.exit(0);
}

const alias = `${args.group}-budget-${args.userId}`;
const models = await resolveModels(args.group, args.models);
const { exists, userModels, tokenHash } = await userState(args.userId, alias);
// Union with current access so granting one group doesn't revoke another.
const mergedModels = [...new Set([...userModels, ...models])].sort();

const userBody = {
	user_id: args.userId,
	max_budget: args.weeklyUsd,
	budget_duration: WEEKLY_DURATION,
	models: mergedModels,
};

if (args.mode === "update") {
	if (!tokenHash) fail(`ERROR: no existing key with alias '${alias}'. Run with --create first.`);
	console.log(`==> [update] Weekly cap -> $${args.weeklyUsd} / ${WEEKLY_DURATION} (user-level)`);
	await api("POST", "/user/update", userBody);
	console.log(`==> [update] ${args.window} cap -> $${args.windowUsd} (key-level, in place; spend kept)`);
	// Identify the key by hashed token: the server only re-hashes values
	// starting with 'sk-', so a stored hash passes through unchanged.
	await api("POST", "/key/update", {
		key: tokenHash,
		max_budget: args.windowUsd,
		budget_duration: args.window,
		models,
	});
	console.log(`
✅ Budgets updated in place (key value unchanged).

  user_id : ${args.userId}
  weekly  : $${args.weeklyUsd} / ${WEEKLY_DURATION}   (user-level)
  window  : $${args.windowUsd} / ${args.window}          (key-level)
  group   : ${args.group}  (${models.length} models)
  alias   : ${alias}

The existing key keeps working — no need to re-paste it into the extension.
Accumulated spend and the current reset window are preserved.`);
	process.exit(0);
}

// --------------------------------------------------------------- create
console.log(`==> [create] Ensuring user '${args.userId}' with weekly cap $${args.weeklyUsd} / ${WEEKLY_DURATION}`);
if (exists) {
	await api("POST", "/user/update", userBody);
} else {
	// auto_create_key=false: don't mint an extra unbudgeted default key.
	await api("POST", "/user/new", { ...userBody, auto_create_key: false });
}

console.log(`==> [create] Revoking any existing key with alias '${alias}'`);
if (tokenHash) {
	const deleted = await api("POST", "/key/delete", { key_aliases: [alias] });
	console.log(`    revoked ${(deleted.deleted_keys ?? []).length} old key(s)`);
} else {
	console.log("    revoked 0 old key(s)");
}

console.log(`==> [create] Generating new key with ${args.window} cap $${args.windowUsd} (${args.group})`);
const resp = await api("POST", "/key/generate", {
	user_id: args.userId,
	key_alias: alias,
	max_budget: args.windowUsd,
	budget_duration: args.window,
	models,
});
if (!resp.key) fail(`ERROR: no key in response: ${JSON.stringify(resp).slice(0, 400)}`);
saveSecret(alias, resp.key); // so --list can show the full secret later

console.log(`
✅ Key created.

  user_id : ${args.userId}
  weekly  : $${args.weeklyUsd} / ${WEEKLY_DURATION}   (user-level)
  window  : $${args.windowUsd} / ${args.window}          (key-level)
  group   : ${args.group}  (${models.length} models)
  alias   : ${alias}
  key     : ${resp.key}

Use this key as the API key in the VS Code extension (Base URL: ${BASE}).
It stops serving when EITHER the weekly or the ${args.window} budget is exhausted.

NOTE: --create ROTATES — any prior '${alias}' key was revoked, so re-paste this
new value. To change only budgets without rotating (keeps spend + window):
  ./litellm/manage-budget-key.ts --update --group ${args.group} ${args.userId} <weekly> <window_usd>`);
