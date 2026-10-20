import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchUsageSummary,
	modelRows,
	sessionRows,
	stackedBarSeries,
	type UsageSummary,
	usageCostByFile,
	usageStatCards,
} from "../src/usage-client.ts";

const emptySummary: UsageSummary = {
	totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0, skipped: 0 },
	perDay: [],
	perModel: [],
	sessions: [],
};

const summary: UsageSummary = {
	totals: { input: 3200, output: 3100, cacheRead: 6300, cacheWrite: 900, cost: 23.8, sessions: 3, skipped: 1 },
	perDay: [
		{ day: "2026-10-19", input: 1000, output: 2000, cacheRead: 6300, cacheWrite: 700, cost: 9.62 },
		{ day: "2026-10-20", input: 2000, output: 1000, cacheRead: 2600, cacheWrite: 400, cost: 14.18 },
	],
	perModel: [
		{ model: "gpt-5.2-codex", input: 1000, output: 3100, cacheRead: 6300, cacheWrite: 900, cost: 9, sessions: 2 },
		{ model: "claude-sonnet-4.5", input: 2200, output: 0, cacheRead: 0, cacheWrite: 0, cost: 12, sessions: 1 },
		{ model: "kimi-k3", input: 999, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.0475, sessions: 1 },
	],
	sessions: [
		{
			file: "a.jsonl",
			id: "older",
			name: "fix-tui-bug",
			cwd: "/home/u/pi",
			model: "gpt-5.2-codex",
			input: 999,
			output: 100,
			cost: 0.0475,
			modified: "2026-10-19T09:00:00.000Z",
		},
		{
			file: "b.jsonl",
			id: "newer",
			name: "ui-redesign",
			cwd: "/home/u/pi",
			model: "claude-sonnet-4.5",
			input: 2200,
			output: 0,
			cost: 14.18,
			modified: "2026-10-20T10:00:00.000Z",
		},
	],
};

test("usageStatCards derives the four cards from totals", () => {
	const cards = usageStatCards(summary, null);
	assert.equal(cards.cost, "$23.80");
	assert.equal(cards.costDelta, "—");
	assert.equal(cards.sessions, "3");
	assert.equal(cards.tokensIn, "9.5k"); // input 3200 + cacheRead 6300 = 9500
	assert.equal(cards.tokensOut, "3.1k"); // output 3100
	assert.equal(cards.cacheWrite, "900"); // < 1k keeps plain digits
	assert.equal(cards.hitPct, 61); // 6300 / (3200+6300+900) rounded
	assert.equal(cards.skipped, 1);
});

test("costDelta computes signed percent vs prev period and degrades safely", () => {
	const at12 = usageStatCards(summary, { ...summary, totals: { ...summary.totals, cost: 21.25 } });
	assert.equal(at12.costDelta, "+12%");
	const atMinus5 = usageStatCards(
		{ ...summary, totals: { ...summary.totals, cost: 19 } },
		{
			...summary,
			totals: { ...summary.totals, cost: 20 },
		},
	);
	assert.equal(atMinus5.costDelta, "-5%");
	const zeroPrev = usageStatCards(summary, { ...summary, totals: { ...summary.totals, cost: 0 } });
	assert.equal(zeroPrev.costDelta, "—");
	assert.equal(usageStatCards(summary, null).costDelta, "—");
});

test("usageStatCards on an empty summary yields zeroed cards and null hit", () => {
	const cards = usageStatCards(emptySummary, null);
	assert.equal(cards.cost, "$0.00");
	assert.equal(cards.costDelta, "—");
	assert.equal(cards.sessions, "0");
	assert.equal(cards.tokensIn, "0");
	assert.equal(cards.tokensOut, "0");
	assert.equal(cards.cacheWrite, "0");
	assert.equal(cards.hitPct, null);
	assert.equal(cards.skipped, 0);
});

test("stackedBarSeries normalizes each day against the busiest day total", () => {
	// Day totals: 10-19 → 10000 (max), 10-20 → 6000 — fixtures chosen to divide cleanly.
	const bars = stackedBarSeries(summary);
	assert.deepEqual(bars, [
		{
			day: "2026-10-19",
			h: { input: 0.1, output: 0.2, cache: 0.7 }, // cache segment: read+write = 7000/10000
			cost: 9.62,
			label: "$9.62",
		},
		{
			day: "2026-10-20",
			h: { input: 0.2, output: 0.1, cache: 0.3 },
			cost: 14.18,
			label: "$14.18",
		},
	]);
});

test("stackedBarSeries sorts days ascending and guards all-zero totals", () => {
	const s: UsageSummary = {
		...emptySummary,
		perDay: [
			{ day: "2026-10-21", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			{ day: "2026-10-19", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		],
	};
	const bars = stackedBarSeries(s);
	assert.deepEqual(
		bars.map((b) => b.day),
		["2026-10-19", "2026-10-21"],
	);
	assert.deepEqual(bars[0].h, { input: 0, output: 0, cache: 0 }); // no NaN division
	assert.deepEqual(stackedBarSeries(emptySummary), []);
});

test("modelRows sorts by cost desc and formats via the canonical formatters", () => {
	const rows = modelRows(summary);
	assert.deepEqual(rows, [
		{ model: "claude-sonnet-4.5", costText: "$12.00", tokensText: "↑2.2k ↓0", pctBar: 100 },
		{ model: "gpt-5.2-codex", costText: "$9.00", tokensText: "↑1.0k ↓3.1k", pctBar: 75 },
		{ model: "kimi-k3", costText: "$0.048", tokensText: "↑999 ↓100", pctBar: 0 },
	]);
});

test("modelRows keeps stable order on cost ties and handles empties", () => {
	const tie: UsageSummary = {
		...emptySummary,
		perModel: [
			{ model: "a", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, sessions: 1 },
			{ model: "b", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, sessions: 1 },
		],
	};
	assert.deepEqual(
		modelRows(tie).map((r) => r.model),
		["a", "b"],
	);
	assert.deepEqual(modelRows(emptySummary), []);
});

test("sessionRows sorts modified desc, passes names and timestamps through", () => {
	const rows = sessionRows(summary);
	assert.deepEqual(rows, [
		{
			id: "newer",
			name: "ui-redesign",
			path: "/home/u/pi",
			model: "claude-sonnet-4.5",
			tokensText: "↑2.2k ↓0",
			costText: "$14.18",
			activeText: "2026-10-20T10:00:00.000Z",
		},
		{
			id: "older",
			name: "fix-tui-bug",
			path: "/home/u/pi",
			model: "gpt-5.2-codex",
			tokensText: "↑999 ↓100",
			costText: "$0.048",
			activeText: "2026-10-19T09:00:00.000Z",
		},
	]);
});

test("sessionRows keeps stable order on modified ties and passes empty names", () => {
	const tie: UsageSummary = {
		...emptySummary,
		sessions: [
			{ file: "1", id: "first", name: "", cwd: "/x", model: "m", input: 0, output: 0, cost: 0, modified: "same" },
			{ file: "2", id: "second", name: "", cwd: "/x", model: "m", input: 0, output: 0, cost: 0, modified: "same" },
		],
	};
	const rows = sessionRows(tie);
	assert.deepEqual(
		rows.map((r) => r.id),
		["first", "second"],
	);
	assert.equal(rows[0].name, "");
	assert.deepEqual(sessionRows(emptySummary), []);
});

test("fetchUsageSummary requests the summary range over the connection", async () => {
	let received: unknown;
	const stub = {
		request<T>(command: unknown): Promise<T> {
			received = command;
			return Promise.resolve(summary as T);
		},
	};
	const out = await fetchUsageSummary(stub as never as Parameters<typeof fetchUsageSummary>[0], 7);
	assert.equal(out, summary); // thin wrapper: the resolved payload passes through
	assert.deepEqual(received, { type: "get_usage_summary", rangeDays: 7 });
	// rangeDays 0 = all-time must serialize too; assert the emitted command shape.
	await fetchUsageSummary(stub as never as Parameters<typeof fetchUsageSummary>[0], 0);
	assert.deepEqual(received, { type: "get_usage_summary", rangeDays: 0 });
});

test("usageCostByFile maps session files to their cost", () => {
	const map = usageCostByFile(summary);
	assert.equal(map.size, 2);
	assert.equal(map.get("a.jsonl"), 0.0475);
	assert.equal(map.get("b.jsonl"), 14.18);
	assert.equal(map.get("missing"), undefined);
});

test("usageCostByFile on an empty summary yields an empty map", () => {
	const map = usageCostByFile(emptySummary);
	assert.equal(map.size, 0);
});
