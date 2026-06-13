import * as assert from "assert";
import * as vscode from "vscode";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBudgetKeys, importBudgetKeys } from "../../extension/budgetKeysImport";
import type { ServerRegistry, ServerConfig } from "../../extension/serverRegistry";

suite("extension/budgetKeysImport", () => {
	test("parseBudgetKeys maps groups to labels and filters non-budget / empty entries", () => {
		const entries = parseBudgetKeys({
			"deepseek-budget-haitao_deepseek": "sk-aaa",
			"copilot-budget-haitao_copilot": "sk-bbb",
			"some-unrelated-token": "sk-zzz", // no -budget- -> skipped
			"deepseek-budget-other": "sk-dup", // same group/label -> deduped
			"empty-budget-x": "", // empty secret -> skipped
		});
		const byLabel = Object.fromEntries(entries.map((e) => [e.label, e.key]));
		assert.deepStrictEqual(Object.keys(byLabel).sort(), ["Copilot", "DeepSeek"]);
		assert.strictEqual(byLabel["DeepSeek"], "sk-aaa");
		assert.strictEqual(byLabel["Copilot"], "sk-bbb");
	});

	test("parseBudgetKeys prettifies unknown group names", () => {
		assert.strictEqual(parseBudgetKeys({ "gemini-budget-me": "sk-g" })[0].label, "Gemini");
	});

	function makeFakeRegistry() {
		const servers: ServerConfig[] = [];
		const keys = new Map<string, string>();
		let idc = 0;
		const registry = {
			getServers: () => servers,
			addServer: async (label: string, baseUrl: string, apiKey: string) => {
				const s: ServerConfig = { id: `id${idc++}`, label, baseUrl };
				servers.push(s);
				keys.set(s.id, apiKey);
				return s;
			},
			updateServer: async (id: string, label: string, baseUrl: string, apiKey: string | undefined) => {
				const s = servers.find((x) => x.id === id);
				if (s) {
					s.label = label;
					s.baseUrl = baseUrl;
				}
				if (apiKey !== undefined) {
					keys.set(id, apiKey);
				}
			},
		} as unknown as ServerRegistry;
		return { registry, servers, keys };
	}

	function stubConfig(values: Record<string, unknown>): () => void {
		const orig = vscode.workspace.getConfiguration;
		(vscode.workspace as Record<string, unknown>).getConfiguration = () => ({
			get: (k: string) => values[k],
		});
		return () => {
			(vscode.workspace as Record<string, unknown>).getConfiguration = orig;
		};
	}

	const noopChannel = { appendLine: () => undefined } as unknown as vscode.OutputChannel;

	test("importBudgetKeys adds then updates server entries idempotently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "budgetkeys-"));
		const file = join(dir, ".litellm-budget-keys.json");
		writeFileSync(file, JSON.stringify({ "deepseek-budget-u": "sk-deep1", "copilot-budget-u": "sk-cop1" }));
		const { registry, servers, keys } = makeFakeRegistry();
		const restore = stubConfig({ "budgetKeys.path": file, "budgetKeys.baseUrl": "http://localhost:4000" });
		try {
			const r1 = await importBudgetKeys(registry, noopChannel, { interactive: false });
			assert.strictEqual(r1.added, 2);
			assert.strictEqual(r1.updated, 0);
			assert.strictEqual(servers.length, 2);
			const deepId = servers.find((s) => s.label === "DeepSeek")!.id;
			assert.strictEqual(keys.get(deepId), "sk-deep1");
			assert.strictEqual(servers[0].baseUrl, "http://localhost:4000");

			// Rotate the DeepSeek key and re-import: update in place, no new servers.
			writeFileSync(file, JSON.stringify({ "deepseek-budget-u": "sk-deep2", "copilot-budget-u": "sk-cop1" }));
			const r2 = await importBudgetKeys(registry, noopChannel, { interactive: false });
			assert.strictEqual(r2.added, 0);
			assert.strictEqual(r2.updated, 2);
			assert.strictEqual(servers.length, 2);
			assert.strictEqual(keys.get(deepId), "sk-deep2");
		} finally {
			restore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("importBudgetKeys trims a trailing slash from baseUrl", async () => {
		const dir = mkdtempSync(join(tmpdir(), "budgetkeys-"));
		const file = join(dir, ".litellm-budget-keys.json");
		writeFileSync(file, JSON.stringify({ "deepseek-budget-u": "sk-x" }));
		const { registry, servers } = makeFakeRegistry();
		const restore = stubConfig({ "budgetKeys.path": file, "budgetKeys.baseUrl": "http://localhost:4000/" });
		try {
			await importBudgetKeys(registry, noopChannel, { interactive: false });
			assert.strictEqual(servers[0].baseUrl, "http://localhost:4000");
		} finally {
			restore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("importBudgetKeys returns an error when no secrets file is found", async () => {
		const { registry } = makeFakeRegistry();
		const restore = stubConfig({ "budgetKeys.path": "/no/such/file.json" });
		try {
			const r = await importBudgetKeys(registry, noopChannel, { interactive: false });
			assert.ok(r.error, "should report an error");
			assert.strictEqual(r.entries.length, 0);
		} finally {
			restore();
		}
	});
});
