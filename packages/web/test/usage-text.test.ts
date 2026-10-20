import assert from "node:assert/strict";
import test from "node:test";
import { cacheHitPct, contextLabel, formatCost, relativeTime, totalsLine, usageLine } from "../src/usage-text.ts";

test("formatCost keeps 3 decimals under a dollar", () => {
	assert.equal(formatCost(0.0475), "$0.048");
	assert.equal(formatCost(1.28), "$1.28");
	assert.equal(formatCost(12), "$12.00");
});

test("contextLabel formats spec strings", () => {
	assert.equal(contextLabel({ percent: 45, window: 200000, auto: true }), "45% of 200k (auto)");
	assert.equal(contextLabel({ percent: null, window: 1000000, auto: true }), "? of 1.0M (auto)");
	assert.equal(contextLabel({ percent: 8, window: 128000, auto: false }), "8.0% of 128k (manual)");
});

test("usageLine omits zero components and optional cost", () => {
	const u = { input: 12400, output: 3100, cacheRead: 8200, cacheWrite: 0, cost: { total: 0.0475 } };
	assert.equal(usageLine(u), "↑12k ↓3.1k · R 8.2k · $0.048");
	assert.equal(usageLine({ ...u, cacheRead: 0 }, { withCost: false }), "↑12k ↓3.1k");
	const w = { ...u, cacheWrite: 900 };
	assert.equal(usageLine(w), "↑12k ↓3.1k · R 8.2k · W 900 · $0.048");
});

test("cacheHitPct and totalsLine", () => {
	assert.equal(cacheHitPct({ input: 1200, cacheRead: 8800, cacheWrite: 0 }), 88);
	assert.equal(cacheHitPct({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
	assert.equal(totalsLine({ input: 312000, output: 88000, cost: 1.284 }, 74), "$1.28 · ↑312k ↓88k · R 74%");
	assert.equal(totalsLine({ input: 1000, output: 0, cost: 0 }, null), "$0.00 · ↑1.0k ↓0");
});

test("relativeTime — capped semantics (projects: 14d then ISO date)", () => {
	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;
	const NOW = new Date("2026-10-20T12:00:00.000Z").getTime();
	const cap = { maxDays: 14 };
	assert.equal(relativeTime(new Date(NOW).toISOString(), NOW, cap), "just now");
	assert.equal(relativeTime(new Date(NOW - 30_000).toISOString(), NOW, cap), "just now");
	assert.equal(relativeTime(new Date(NOW - MINUTE).toISOString(), NOW, cap), "1m ago");
	assert.equal(relativeTime(new Date(NOW - 59 * MINUTE).toISOString(), NOW, cap), "59m ago");
	assert.equal(relativeTime(new Date(NOW - HOUR).toISOString(), NOW, cap), "1h ago");
	assert.equal(relativeTime(new Date(NOW - 23 * HOUR).toISOString(), NOW, cap), "23h ago");
	assert.equal(relativeTime(new Date(NOW - DAY).toISOString(), NOW, cap), "1d ago");
	assert.equal(relativeTime(new Date(NOW - 14 * DAY).toISOString(), NOW, cap), "14d ago");
	// Beyond 14 days: ISO date of the timestamp.
	assert.equal(relativeTime(new Date(NOW - 15 * DAY).toISOString(), NOW, cap), "2026-10-05");
	// Future timestamps clamp to "just now".
	assert.equal(relativeTime(new Date(NOW + MINUTE).toISOString(), NOW, cap), "just now");
});

test("relativeTime — unbounded semantics (home) and invalid stamps", () => {
	const DAY = 24 * 3_600_000;
	const NOW = new Date("2026-10-20T12:00:00.000Z").getTime();
	const home = { invalidText: "\u2014" };
	assert.equal(relativeTime(new Date(NOW - 40 * DAY).toISOString(), NOW, home), "40d ago");
	assert.equal(relativeTime(new Date(NOW - 400 * DAY).toISOString(), NOW, home), "400d ago");
	// Home renders an em-dash for unparseable stamps instead of the raw text.
	assert.equal(relativeTime("not-a-date", NOW, home), "\u2014");
	// Default invalid fallback keeps the raw string (projects behavior).
	assert.equal(relativeTime("not-a-date", NOW), "not-a-date");
	// No opts at all: unbounded like home, invalid passthrough.
	assert.equal(relativeTime(new Date(NOW - 2 * DAY).toISOString(), NOW), "2d ago");
	assert.equal(relativeTime(new Date(NOW + 5_000).toISOString(), NOW), "just now");
});
