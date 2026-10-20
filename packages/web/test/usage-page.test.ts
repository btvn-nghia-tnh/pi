import assert from "node:assert/strict";
import test from "node:test";
import { applyFilters, chartGeometry, rangeChips, type UsageFilter } from "../src/pages/usage.ts";
import type { StackedBarDay, UsageSessionRow } from "../src/usage-client.ts";

const day = (input: number, output: number, cache: number): StackedBarDay => ({
	day: "2026-10-20",
	h: { input, output, cache },
	cost: 1.5,
	label: "$1.50",
});

const row = (id: string, cwd: string, model: string): UsageSessionRow => ({
	file: `/s/${id}.jsonl`,
	id,
	name: id.toUpperCase(),
	cwd,
	model,
	input: 1,
	output: 2,
	cost: 3,
	modified: "2026-10-20T00:00:00Z",
});

test("rangeChips marks the active range and keeps order", () => {
	const chips = rangeChips(7);
	assert.deepEqual(
		chips.map((c) => `${c.label}:${c.days}:${c.active}`),
		["Today:1:false", "7 days:7:true", "30 days:30:false", "All time:0:false"],
	);
	assert.ok(rangeChips(0).find((c) => c.days === 0)?.active);
	assert.ok(rangeChips(1).find((c) => c.days === 1)?.active);
	assert.ok(rangeChips(30).find((c) => c.days === 30)?.active);
});

test("chartGeometry stacks input bottom, output middle, cache top", () => {
	const bars = chartGeometry([day(0.5, 0.3, 0.2), day(0.1, 0.1, 0)], {
		width: 100,
		height: 50,
		barWidth: 20,
	});
	assert.equal(bars.length, 2);
	const [a, b] = bars;
	assert.deepEqual(
		a.rects.map((r) => [r.x, r.y, r.w, r.h, r.fill]),
		[
			[0, 25, 20, 25, "var(--c-accent)"],
			[0, 10, 20, 15, "var(--c-blue)"],
			[0, 0, 20, 10, "var(--c-dim)"],
		],
	);
	assert.deepEqual(
		b.rects.map((r) => [r.y, r.h]),
		[
			[45, 5],
			[40, 5],
			[40, 0],
		],
	);
	assert.equal(a.label, "10-20");
	assert.equal(a.costLabel, "$1.50");
});

test("chartGeometry centers a lone bar and returns empty for no series", () => {
	const [solo] = chartGeometry([day(1, 0, 0)], { width: 100, height: 40, barWidth: 20 });
	assert.equal(solo.rects[0]?.x, 40);
	assert.deepEqual(chartGeometry([]), []);
});

test("chartGeometry spreads bars evenly across the width", () => {
	const bars = chartGeometry([day(1, 0, 0), day(0.5, 0.5, 0), day(0, 0, 0.5)], {
		width: 130,
		height: 40,
		barWidth: 10,
	});
	// n=3: gap = (130 - 30) / 2 = 50 → x_i = i * (10 + 50)
	assert.deepEqual(
		bars.map((bar) => bar.rects[0]?.x),
		[0, 60, 120],
	);
});

test("chartGeometry scales bar width down for long ranges (R20: no overlap)", () => {
	// 30 days at width 680: available per bar = floor((680 - 29*2) / 30) = 20.
	const series: StackedBarDay[] = [];
	for (let i = 0; i < 30; i++) series.push(day(0.3, 0.2, 0.1));
	const bars = chartGeometry(series, { width: 680, height: 140, barWidth: 28 });
	assert.equal(bars.length, 30);
	assert.equal(bars[0]?.rects[0]?.w, 20);
	// No overlap, ordering preserved, and the run stays inside the canvas.
	for (let i = 0; i + 1 < bars.length; i++) {
		assert.ok(
			(bars[i + 1]?.rects[0]?.x ?? 0) >= (bars[i]?.rects[0]?.x ?? 0) + (bars[i]?.rects[0]?.w ?? 0),
			`bar ${i + 1} overlaps bar ${i}`,
		);
	}
	const last = bars[29]?.rects[0];
	assert.ok((last?.x ?? 0) + (last?.w ?? 0) <= 680);
});

test("chartGeometry keeps the requested width when it already fits (R20)", () => {
	// n=1: available = width itself → the requested 28px cap passes through and
	// the lone-bar centering stays intact; an oversized request fills the band.
	const [solo] = chartGeometry([day(1, 0, 0)], { width: 100, height: 40 });
	assert.equal(solo.rects[0]?.w, 28);
	assert.equal(solo.rects[0]?.x, 36);
	const [wide] = chartGeometry([day(1, 0, 0)], { width: 100, height: 40, barWidth: 999 });
	assert.equal(wide.rects[0]?.w, 100);
	assert.equal(wide.rects[0]?.x, 0);
});

test("applyFilters narrows the sessions table client-side", () => {
	const rows = [row("a", "/one", "m1"), row("b", "/two", "m2")];
	const modelOnly: UsageFilter = { model: "m1" };
	assert.deepEqual(
		applyFilters(rows, modelOnly).map((r) => r.id),
		["a"],
	);
	assert.deepEqual(
		applyFilters(rows, { project: "/two" }).map((r) => r.id),
		["b"],
	);
	assert.equal(applyFilters(rows, { model: "m1", project: "/two" }).length, 0);
	assert.equal(applyFilters(rows, {}).length, 2);
	assert.equal(applyFilters(rows, { model: "" }).length, 2);
	assert.equal(applyFilters(rows, { project: "" }).length, 2);
});
