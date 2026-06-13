import * as vscode from "vscode";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import type { ServerRegistry } from "./serverRegistry";

// Auto-registers the budget-scoped virtual keys minted by `litellm-up.ts` /
// `manage-budget-key` (stored in `.litellm-budget-keys.json`) as server entries
// in the extension — so you never have to paste a key by hand. Only the
// extension can write the encrypted server registry, which a CLI cannot.

const SECRETS_FILENAME = ".litellm-budget-keys.json";
const GROUP_LABELS: Record<string, string> = { deepseek: "DeepSeek", copilot: "Copilot" };

export interface BudgetServerEntry {
	alias: string; // e.g. "deepseek-budget-haitao_deepseek"
	group: string; // e.g. "deepseek"
	label: string; // server label, e.g. "DeepSeek"
	key: string; // the sk-... secret
}

/** Convert a `{alias: secret}` store into one server entry per group. Pure. */
export function parseBudgetKeys(raw: Record<string, unknown>): BudgetServerEntry[] {
	const out: BudgetServerEntry[] = [];
	const seen = new Set<string>();
	for (const [alias, key] of Object.entries(raw)) {
		if (typeof key !== "string" || !key || !alias.includes("-budget-")) {
			continue;
		}
		const group = alias.split("-budget-")[0];
		const label = GROUP_LABELS[group] ?? group.charAt(0).toUpperCase() + group.slice(1);
		if (seen.has(label.toLowerCase())) {
			continue; // first alias per group/label wins (one key per group is the supported shape)
		}
		seen.add(label.toLowerCase());
		out.push({ alias, group, label, key });
	}
	return out;
}

function resolveSecretsPath(configured: string | undefined): string | undefined {
	if (configured && configured.trim()) {
		const p = configured.trim();
		return existsSync(p) ? p : undefined;
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const p = path.join(folder.uri.fsPath, SECRETS_FILENAME);
		if (existsSync(p)) {
			return p;
		}
	}
	return undefined;
}

export interface ImportResult {
	added: number;
	updated: number;
	entries: BudgetServerEntry[];
	error?: string;
}

/** Read the secrets store and register/update a server entry per budget key. */
export async function importBudgetKeys(
	registry: ServerRegistry,
	outputChannel: vscode.OutputChannel,
	opts: { interactive: boolean }
): Promise<ImportResult> {
	const cfg = vscode.workspace.getConfiguration("litellm-vscode-chat");
	const baseUrl = (cfg.get<string>("budgetKeys.baseUrl") || "http://localhost:4000").replace(/\/+$/, "");
	const filePath = resolveSecretsPath(cfg.get<string>("budgetKeys.path"));
	const ts = () => new Date().toISOString();
	const warn = (msg: string): ImportResult => {
		if (opts.interactive) {
			void vscode.window.showWarningMessage(`LiteLLM: ${msg}`);
		}
		return { added: 0, updated: 0, entries: [], error: msg };
	};

	if (!filePath) {
		return warn(`No ${SECRETS_FILENAME} found. Run ./litellm/litellm-up.ts first, or set "budgetKeys.path".`);
	}

	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (e) {
		const msg = `Failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}`;
		outputChannel.appendLine(`[${ts()}] ${msg}`);
		if (opts.interactive) {
			void vscode.window.showErrorMessage(`LiteLLM: ${msg}`);
		}
		return { added: 0, updated: 0, entries: [], error: msg };
	}

	const entries = parseBudgetKeys(raw);
	if (entries.length === 0) {
		return warn(`No budget keys found in ${filePath}.`);
	}

	let added = 0;
	let updated = 0;
	for (const e of entries) {
		const existing = registry.getServers().find((s) => s.label.toLowerCase() === e.label.toLowerCase());
		if (existing) {
			await registry.updateServer(existing.id, e.label, baseUrl, e.key);
			updated++;
		} else {
			await registry.addServer(e.label, baseUrl, e.key);
			added++;
		}
		outputChannel.appendLine(`[${ts()}] Imported budget server "${e.label}" (${e.alias}) -> ${baseUrl}`);
	}
	return { added, updated, entries };
}

/**
 * Registers the `litellm.importBudgetKeys` command, plus (when
 * `budgetKeys.autoImport` is enabled) an import on activation and a watcher that
 * re-imports whenever the secrets file changes — so re-running litellm-up.ts
 * keeps the extension in sync with no manual step.
 *
 * `refresh` is invoked after a successful import to re-fetch models / budgets.
 */
export function registerBudgetKeysImport(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	outputChannel: vscode.OutputChannel,
	refresh: () => void
): void {
	const run = async (interactive: boolean): Promise<ImportResult> => {
		const r = await importBudgetKeys(registry, outputChannel, { interactive });
		if (r.entries.length > 0 && !r.error) {
			refresh();
			if (interactive) {
				void vscode.window.showInformationMessage(
					`LiteLLM: imported ${r.entries.length} budget server${r.entries.length === 1 ? "" : "s"} ` +
						`(${r.added} added, ${r.updated} updated). Open the model picker to use them.`
				);
			}
		}
		return r;
	};

	context.subscriptions.push(vscode.commands.registerCommand("litellm.importBudgetKeys", () => run(true)));

	const autoImportEnabled = () =>
		vscode.workspace.getConfiguration("litellm-vscode-chat").get<boolean>("budgetKeys.autoImport") ?? false;

	if (autoImportEnabled()) {
		void run(false);
	}

	// Watch the secrets file so re-running litellm-up.ts auto-syncs the extension.
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, SECRETS_FILENAME));
		const onChange = () => {
			if (autoImportEnabled()) {
				void run(false);
			}
		};
		watcher.onDidCreate(onChange);
		watcher.onDidChange(onChange);
		context.subscriptions.push(watcher);
	}
}
