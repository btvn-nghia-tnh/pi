import assert from "node:assert/strict";
import test from "node:test";
import { cacheHitPct, contextLabel, formatCost, totalsLine, usageLine } from "../src/usage-text.ts";

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
