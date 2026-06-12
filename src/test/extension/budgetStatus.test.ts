import * as assert from "assert";
import {
	bar,
	colorIcon,
	timeUntil,
	windowPct,
	formatUsd,
	buildBudgetStatusText,
	buildBudgetTooltip,
	fetchServerBudget,
	type BudgetWindow,
	type ServerBudget,
} from "../../extension/budgetStatus";

// Stub global fetch with a per-URL responder for fetchServerBudget tests.
function stubFetch(routes: Record<string, { status: number; body: unknown }>): () => void {
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		const match = Object.keys(routes).find((k) => url.includes(k));
		const r = match ? routes[match] : { status: 404, body: {} };
		return {
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			json: async () => r.body,
			text: async () => JSON.stringify(r.body),
		} as Response;
	}) as typeof fetch;
	return () => {
		globalThis.fetch = orig;
	};
}

suite("extension/budgetStatus", () => {
	const fiveHour: BudgetWindow = { label: "5h", spend: 1.5, maxBudget: 3, resetsAt: "2026-06-12T01:00:00Z" };
	const weekly: BudgetWindow = { label: "1w", spend: 0.5, maxBudget: 20, resetsAt: "2026-06-15T00:00:00Z" };

	test("windowPct computes percentage and clamps", () => {
		assert.strictEqual(windowPct(fiveHour), 50);
		assert.strictEqual(windowPct({ ...fiveHour, spend: 99 }), 100); // overshoot clamps
		assert.strictEqual(windowPct({ ...fiveHour, spend: 0 }), 0);
		assert.strictEqual(windowPct({ ...fiveHour, maxBudget: 0 }), 0); // no budget -> 0, no NaN
	});

	test("bar renders filled/empty segments and clamps", () => {
		assert.strictEqual(bar(0), "░░░░░░░░");
		assert.strictEqual(bar(100), "████████");
		assert.strictEqual(bar(50), "████░░░░");
		assert.strictEqual(bar(150), "████████"); // clamped
		assert.strictEqual(bar(50, 20).length, 20);
	});

	test("colorIcon thresholds", () => {
		assert.strictEqual(colorIcon(0), "🟢");
		assert.strictEqual(colorIcon(49.9), "🟢");
		assert.strictEqual(colorIcon(50), "🟡");
		assert.strictEqual(colorIcon(80), "🔴");
		assert.strictEqual(colorIcon(100), "🔴");
	});

	test("timeUntil formats minutes, hours, days and handles null/past", () => {
		const now = new Date("2026-06-12T00:00:00Z").getTime();
		assert.strictEqual(timeUntil(null, now), "n/a");
		assert.strictEqual(timeUntil("not-a-date", now), "n/a");
		assert.strictEqual(timeUntil("2026-06-11T00:00:00Z", now), "resetting…");
		assert.strictEqual(timeUntil("2026-06-12T00:45:00Z", now), "45m");
		assert.strictEqual(timeUntil("2026-06-12T03:05:00Z", now), "3h05m");
		assert.strictEqual(timeUntil("2026-06-14T02:30:00Z", now), "2d02h30m");
	});

	test("formatUsd uses 4 decimals for sub-cent values", () => {
		assert.strictEqual(formatUsd(3), "$3.00");
		assert.strictEqual(formatUsd(0.05), "$0.05");
		assert.strictEqual(formatUsd(0.0042), "$0.0042");
		assert.strictEqual(formatUsd(0), "$0.00");
		assert.strictEqual(formatUsd(0.00000406), "<$0.0001"); // tiny nonzero must not look like zero
	});

	test("buildBudgetStatusText single server shows windows without label prefix", () => {
		const budgets: ServerBudget[] = [{ serverLabel: "Default", keyWindow: fiveHour, userWindow: weekly }];
		const text = buildBudgetStatusText(budgets, "both");
		assert.ok(text.includes("5h"), text);
		assert.ok(text.includes("1w"), text);
		assert.ok(!text.includes("Default:"), "single server should not prefix label");
		assert.ok(text.includes("50%"), text);
	});

	test("buildBudgetStatusText respects mode filtering", () => {
		const budgets: ServerBudget[] = [{ serverLabel: "Default", keyWindow: fiveHour, userWindow: weekly }];
		const windowOnly = buildBudgetStatusText(budgets, "window");
		assert.ok(windowOnly.includes("5h") && !windowOnly.includes("1w"), windowOnly);
		const weeklyOnly = buildBudgetStatusText(budgets, "weekly");
		assert.ok(weeklyOnly.includes("1w") && !weeklyOnly.includes("5h"), weeklyOnly);
	});

	test("buildBudgetStatusText prefixes labels for multiple servers", () => {
		const budgets: ServerBudget[] = [
			{ serverLabel: "DeepSeek", keyWindow: fiveHour, userWindow: null },
			{ serverLabel: "Copilot", keyWindow: { ...fiveHour, label: "5h" }, userWindow: null },
		];
		const text = buildBudgetStatusText(budgets, "both");
		assert.ok(text.includes("DeepSeek:"), text);
		assert.ok(text.includes("Copilot:"), text);
	});

	test("buildBudgetStatusText skips missing windows", () => {
		const budgets: ServerBudget[] = [{ serverLabel: "Default", keyWindow: fiveHour, userWindow: null }];
		assert.strictEqual(buildBudgetStatusText(budgets, "weekly"), "");
	});

	test("fetchServerBudget returns null for a master key (/key/info 404)", async () => {
		const restore = stubFetch({
			"/key/info": { status: 404, body: { error: { message: "Key not found in database" } } },
		});
		try {
			const b = await fetchServerBudget("LocalDev", "http://localhost:4000", "sk-litellm-master-key");
			assert.strictEqual(b, null, "master-key server should be skipped, not error");
		} finally {
			restore();
		}
	});

	test("fetchServerBudget builds windows for a budgeted virtual key", async () => {
		const restore = stubFetch({
			"/key/info": {
				status: 200,
				body: {
					info: {
						spend: 1.5,
						max_budget: 3,
						budget_duration: "5h",
						budget_reset_at: "2026-06-12T01:00:00Z",
						user_id: "haitao",
					},
				},
			},
			"/user/info": {
				status: 200,
				body: {
					user_info: { spend: 0.5, max_budget: 20, budget_duration: "1w", budget_reset_at: "2026-06-15T00:00:00Z" },
				},
			},
		});
		try {
			const b = await fetchServerBudget("DeepSeek", "http://localhost:4000", "sk-virtual");
			assert.ok(b, "should return a budget");
			assert.strictEqual(b!.keyWindow?.label, "5h");
			assert.strictEqual(b!.keyWindow?.maxBudget, 3);
			assert.strictEqual(b!.userWindow?.label, "1w");
			assert.strictEqual(b!.userWindow?.maxBudget, 20);
		} finally {
			restore();
		}
	});

	test("fetchServerBudget returns null for a key with no budget set", async () => {
		const restore = stubFetch({
			"/key/info": { status: 200, body: { info: { spend: 0, max_budget: null, user_id: "someone" } } },
			"/user/info": { status: 200, body: { user_info: { max_budget: null } } },
		});
		try {
			const b = await fetchServerBudget("Unbudgeted", "http://localhost:4000", "sk-nobudget");
			assert.strictEqual(b, null);
		} finally {
			restore();
		}
	});

	test("buildBudgetTooltip includes dollars, percent and reset countdown", () => {
		const now = new Date("2026-06-11T23:00:00Z").getTime();
		const budgets: ServerBudget[] = [{ serverLabel: "Default", keyWindow: fiveHour, userWindow: weekly }];
		const tip = buildBudgetTooltip(budgets, new Date(now), now);
		assert.ok(tip.includes("$1.50 / $3.00"), tip);
		assert.ok(tip.includes("$0.50 / $20.00"), tip);
		assert.ok(tip.includes("resets in 2h00m"), tip);
		assert.ok(tip.includes("50%"), tip);
	});
});
