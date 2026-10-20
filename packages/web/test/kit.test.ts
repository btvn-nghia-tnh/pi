import assert from "node:assert/strict";
import test from "node:test";
import { barPoints, popoverTop, progressTone } from "../src/components/kit.ts";

test("barPoints maps values into the box, last point at right edge", () => {
	const pts = barPoints([0, 1, 0.5], 100, 40);
	assert.equal(pts.split(" ").length, 3);
	const [a, b, c] = pts.split(" ").map((p) => p.split(",").map(Number) as [number, number]);
	assert.deepEqual(a, [0, 40]);
	assert.deepEqual(b, [50, 0]);
	assert.deepEqual(c, [100, 20]);
});

test("progressTone thresholds match the spec", () => {
	assert.equal(progressTone(12), "ok");
	assert.equal(progressTone(45), "ok");
	assert.equal(progressTone(71), "warn");
	assert.equal(progressTone(89.9), "warn");
	assert.equal(progressTone(90), "warn"); // boundary: danger is strictly >90 per spec §3.2.5
	assert.equal(progressTone(90.1), "danger");
	assert.equal(progressTone(101), "danger");
});

test("barPoints handles single-value series", () => {
	assert.equal(barPoints([0.4], 80, 20), "0,12");
});

test("popoverTop opens below when it fits and flips above the viewport bottom", () => {
	// Fits below: anchor bottom + menu + margin stays inside the viewport.
	assert.equal(popoverTop({ top: 800, bottom: 830 }, 60, 900), 836);
	// Overflows: flips above the anchor, keeping a 6px gap and an 8px top clamp.
	assert.equal(popoverTop({ top: 860, bottom: 894 }, 60, 900), 794);
	// Degenerate flip (tiny viewport) clamps at 8px instead of going negative.
	assert.equal(popoverTop({ top: 10, bottom: 44 }, 60, 100), 8);
	// Bottom-of-viewport status-bar chip flips instead of opening off-screen.
	assert.equal(popoverTop({ top: 862, bottom: 894 }, 40, 900), 816);
});
