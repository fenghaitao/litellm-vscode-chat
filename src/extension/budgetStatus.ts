import * as vscode from "vscode";
import type { ServerRegistry } from "./serverRegistry";

// Status bar showing LiteLLM virtual-key budget windows (e.g. $3/5h on the key
// plus $20/1w on the user), in the style of Claude Code's 5h/7d usage bars.
// Data comes from the proxy itself: GET /key/info (self-inspection with the
// virtual key) and GET /user/info?user_id=... — both readable by the key, so
// the master key is never needed here.

export type BudgetDisplayMode = "window" | "weekly" | "both";

export interface BudgetWindow {
	label: string; // litellm budget_duration, e.g. "5h", "1w"
	spend: number;
	maxBudget: number;
	resetsAt: string | null; // ISO 8601 or null (no spend recorded yet)
}

export interface ServerBudget {
	serverLabel: string;
	keyWindow: BudgetWindow | null; // key-level cap (the short window)
	userWindow: BudgetWindow | null; // user-level cap (the long window)
}

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

export function windowPct(w: BudgetWindow): number {
	if (!(w.maxBudget > 0)) {
		return 0;
	}
	return Math.min(100, Math.max(0, (w.spend / w.maxBudget) * 100));
}

export function bar(pct: number, width = 8): string {
	const clamped = Math.min(100, Math.max(0, pct));
	const filled = Math.round((clamped / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function colorIcon(pct: number): string {
	if (pct < 50) {
		return "🟢";
	}
	if (pct < 80) {
		return "🟡";
	}
	return "🔴";
}

export function timeUntil(isoString: string | null, now: number = Date.now()): string {
	if (!isoString) {
		return "n/a";
	}
	const ms = new Date(isoString).getTime() - now;
	if (Number.isNaN(ms)) {
		return "n/a";
	}
	if (ms <= 0) {
		return "resetting…";
	}
	const totalMin = Math.floor(ms / 60_000);
	const d = Math.floor(totalMin / 1440);
	const h = Math.floor((totalMin % 1440) / 60);
	const m = totalMin % 60;
	if (d > 0) {
		return `${d}d${h.toString().padStart(2, "0")}h${m.toString().padStart(2, "0")}m`;
	}
	return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
}

export function formatUsd(v: number): string {
	if (v !== 0 && Math.abs(v) < 0.00005) {
		return "<$0.0001"; // nonzero but would render as $0.0000
	}
	if (v !== 0 && Math.abs(v) < 0.01) {
		return `$${v.toFixed(4)}`;
	}
	return `$${v.toFixed(2)}`;
}

function formatWindowShort(w: BudgetWindow): string {
	const pct = windowPct(w);
	return `${colorIcon(pct)} ${w.label} ${bar(pct)} ${Math.round(pct)}%`;
}

export function buildBudgetStatusText(budgets: ServerBudget[], mode: BudgetDisplayMode): string {
	const parts: string[] = [];
	const multiServer = budgets.length > 1;
	for (const b of budgets) {
		const sub: string[] = [];
		if ((mode === "window" || mode === "both") && b.keyWindow) {
			sub.push(formatWindowShort(b.keyWindow));
		}
		if ((mode === "weekly" || mode === "both") && b.userWindow) {
			sub.push(formatWindowShort(b.userWindow));
		}
		if (sub.length > 0) {
			parts.push((multiServer ? `${b.serverLabel}: ` : "") + sub.join(" | "));
		}
	}
	return parts.join("  ‖  ");
}

export function buildBudgetTooltip(budgets: ServerBudget[], fetchedAt: Date, now: number = Date.now()): string {
	const lines: string[] = ["LiteLLM Budget Usage", ""];
	for (const b of budgets) {
		if (budgets.length > 1) {
			lines.push(`${b.serverLabel}:`);
		}
		for (const w of [b.keyWindow, b.userWindow]) {
			if (!w) {
				continue;
			}
			const pct = windowPct(w);
			lines.push(
				`${w.label.padEnd(4)} ${formatUsd(w.spend)} / ${formatUsd(w.maxBudget)}  (${Math.round(pct)}%, resets in ${timeUntil(
					w.resetsAt,
					now
				)})`
			);
			lines.push(`  ${bar(pct, 20)}`);
		}
		lines.push("");
	}
	lines.push(`Last updated: ${fetchedAt.toLocaleTimeString()}`);
	lines.push("");
	lines.push("Click to toggle view mode");
	return lines.join("\n");
}

// ─── Proxy fetch ─────────────────────────────────────────────────────────────

interface KeyInfoResponse {
	info?: {
		spend?: number;
		max_budget?: number | null;
		budget_duration?: string | null;
		budget_reset_at?: string | null;
		user_id?: string | null;
	};
}

interface UserInfoResponse {
	user_info?: {
		spend?: number;
		max_budget?: number | null;
		budget_duration?: string | null;
		budget_reset_at?: string | null;
	};
}

async function fetchJson<T>(url: string, apiKey: string, timeoutMs = 10_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchServerBudget(
	serverLabel: string,
	baseUrl: string,
	apiKey: string
): Promise<ServerBudget | null> {
	let keyInfo: KeyInfoResponse;
	try {
		keyInfo = await fetchJson<KeyInfoResponse>(`${baseUrl}/key/info`, apiKey);
	} catch (e) {
		// A master key (or any non-virtual key) has no DB record, so /key/info
		// returns 404 "Key not found". That just means there's no budget to show
		// for this server — skip it silently rather than surfacing an error.
		if (e instanceof Error && e.message.includes("404")) {
			return null;
		}
		throw e;
	}
	const info = keyInfo.info ?? {};

	let keyWindow: BudgetWindow | null = null;
	if (typeof info.max_budget === "number" && info.max_budget > 0) {
		keyWindow = {
			label: info.budget_duration || "key",
			spend: info.spend ?? 0,
			maxBudget: info.max_budget,
			resetsAt: info.budget_reset_at ?? null,
		};
	}

	let userWindow: BudgetWindow | null = null;
	if (info.user_id) {
		try {
			const userInfo = await fetchJson<UserInfoResponse>(
				`${baseUrl}/user/info?user_id=${encodeURIComponent(info.user_id)}`,
				apiKey
			);
			const u = userInfo.user_info ?? {};
			if (typeof u.max_budget === "number" && u.max_budget > 0) {
				userWindow = {
					label: u.budget_duration || "user",
					spend: u.spend ?? 0,
					maxBudget: u.max_budget,
					resetsAt: u.budget_reset_at ?? null,
				};
			}
		} catch {
			// User lookup is best-effort: some keys may not be allowed to read it.
		}
	}

	if (!keyWindow && !userWindow) {
		return null; // unbudgeted key (e.g. master key) — nothing to show
	}
	return { serverLabel, keyWindow, userWindow };
}

// ─── Status bar manager ──────────────────────────────────────────────────────

const REFRESH_AFTER_RESPONSE_MS = 2_500; // spend writes are async on the proxy
const MAX_BACKOFF_MS = 60 * 60_000;

export class BudgetStatusBar {
	private readonly item: vscode.StatusBarItem;
	private mode: BudgetDisplayMode;
	private lastBudgets: ServerBudget[] = [];
	private lastFetchedAt: Date | null = null;
	private lastError: string | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private backoffTimer: ReturnType<typeof setTimeout> | null = null;
	private backoffMs = 0;
	private pendingResponseRefresh: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(
		context: vscode.ExtensionContext,
		private readonly registry: ServerRegistry,
		private readonly outputChannel: vscode.OutputChannel
	) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
		this.item.command = "litellm.budgetToggleMode";
		context.subscriptions.push(this.item);
		context.subscriptions.push({ dispose: () => this.dispose() });

		this.mode = this.config().get<BudgetDisplayMode>("budgetStatus.defaultMode") ?? "both";

		context.subscriptions.push(
			vscode.commands.registerCommand("litellm.budgetRefresh", () => this.refresh()),
			vscode.commands.registerCommand("litellm.budgetToggleMode", () => this.toggleMode()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("litellm-vscode-chat.budgetStatus")) {
					this.mode = this.config().get<BudgetDisplayMode>("budgetStatus.defaultMode") ?? "both";
					this.startPolling();
					void this.refresh();
				}
			})
		);

		void this.refresh();
		this.startPolling();
	}

	private config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration("litellm-vscode-chat");
	}

	private enabled(): boolean {
		return this.config().get<boolean>("budgetStatus.enabled") ?? true;
	}

	/** Call when a chat response finished — refreshes shortly after, once the
	 *  proxy's async spend write has likely landed. */
	notifyRequestComplete(): void {
		if (!this.enabled() || this.pendingResponseRefresh) {
			return;
		}
		this.pendingResponseRefresh = setTimeout(() => {
			this.pendingResponseRefresh = null;
			void this.refresh();
		}, REFRESH_AFTER_RESPONSE_MS);
	}

	async refresh(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!this.enabled()) {
			this.item.hide();
			return;
		}
		if (this.backoffTimer) {
			return;
		}

		const servers = await this.registry.getServersWithKeys();
		const budgets: ServerBudget[] = [];
		let firstError: string | null = null;

		for (const server of servers) {
			if (!server.apiKey) {
				continue;
			}
			try {
				const budget = await fetchServerBudget(server.label, server.baseUrl, server.apiKey);
				if (budget) {
					budgets.push(budget);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!firstError) {
					firstError = `${server.label}: ${msg}`;
				}
				this.outputChannel.appendLine(`[${new Date().toISOString()}] Budget fetch failed for ${server.label}: ${msg}`);
			}
		}

		if (budgets.length === 0 && firstError) {
			// All budgeted lookups failed — keep last data, surface the error.
			this.lastError = firstError;
			if (firstError.includes("HTTP 429")) {
				this.backoffMs = this.backoffMs === 0 ? 5 * 60_000 : Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
				this.backoffTimer = setTimeout(() => {
					this.backoffTimer = null;
					void this.refresh();
				}, this.backoffMs);
			}
		} else {
			this.lastError = null;
			this.backoffMs = 0;
			this.lastBudgets = budgets;
			this.lastFetchedAt = new Date();
		}
		this.render();
	}

	private render(): void {
		if (!this.enabled()) {
			this.item.hide();
			return;
		}
		if (this.lastBudgets.length === 0) {
			if (this.lastError) {
				this.item.text = "$(warning) Budget";
				this.item.tooltip = `Budget fetch failed: ${this.lastError}`;
				this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				this.item.show();
			} else {
				// No budgeted keys anywhere (e.g. master key configured) — stay hidden.
				this.item.hide();
			}
			return;
		}

		const stale = this.lastError ? " $(warning)" : "";
		this.item.text = buildBudgetStatusText(this.lastBudgets, this.mode) + stale;
		const tooltipBody = buildBudgetTooltip(this.lastBudgets, this.lastFetchedAt ?? new Date());
		const tooltip = new vscode.MarkdownString("```\n" + tooltipBody + "\n```");
		if (this.lastError) {
			tooltip.appendText(`\nLast refresh failed: ${this.lastError} (showing previous data)`);
		}
		this.item.tooltip = tooltip;
		this.item.backgroundColor = this.lastError ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
		this.item.show();
	}

	private startPolling(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		const seconds = this.config().get<number>("budgetStatus.refreshIntervalSeconds") ?? 300;
		this.refreshTimer = setInterval(() => void this.refresh(), Math.max(60, seconds) * 1000);
	}

	private async toggleMode(): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: "$(clock) Key window", description: "Short window on the key (e.g. 5h)", value: "window" as const },
				{
					label: "$(calendar) User window",
					description: "Long window on the user (e.g. 1w)",
					value: "weekly" as const,
				},
				{ label: "$(list-unordered) Both", description: "Show both windows", value: "both" as const },
			],
			{ placeHolder: `Current: ${this.mode} — select budget view mode` }
		);
		if (picked) {
			this.mode = picked.value;
			this.render();
		}
	}

	private dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
		}
		if (this.backoffTimer) {
			clearTimeout(this.backoffTimer);
		}
		if (this.pendingResponseRefresh) {
			clearTimeout(this.pendingResponseRefresh);
		}
	}
}
