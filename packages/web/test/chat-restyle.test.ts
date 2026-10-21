import assert from "node:assert/strict";
import test from "node:test";
import { clampPanelWidth } from "../src/components/panel-resizer.ts";
import { DOCK_WIDGET_BLOCKLIST } from "../src/footer.ts";
import { sessionRowMatches } from "../src/render/sidebar.ts";

/**
 * Sprint-4 Task 5 (B3+B7+B8) unit coverage:
 * - B3: the docked-widget blocklist pins the "pi-modes" composer noise out of
 *   the above-editor area (mode state still renders in the status bar chip).
 * - B7: same shared clamp drives both resizer sides; right-mode width math is
 *   originEdge − pointerX, clamped 260–560 for the chat right panel.
 * - B8: the session filter matches a session's label, project cwd, or file
 *   path ("lọc theo title + cwd + session id") and passes everything on an
 *   empty query.
 */

test("DOCK_WIDGET_BLOCKLIST blocks pi-modes and nothing else yet (B3)", () => {
	assert.equal(DOCK_WIDGET_BLOCKLIST.has("pi-modes"), true);
	assert.equal(DOCK_WIDGET_BLOCKLIST.has("rpiv-todo"), false);
	assert.equal(DOCK_WIDGET_BLOCKLIST.size, 1);
});

test("clampPanelWidth clamps NaN to min and honors the chat right panel range (B7)", () => {
	// Right-mode width derives as originEdge − clientX before the clamp.
	assert.equal(clampPanelWidth(3000 - 2400, 260, 560), 560); // 600 → wider than max
	assert.equal(clampPanelWidth(3000 - 2780, 260, 560), 260); // 220 → narrower than min
	assert.equal(clampPanelWidth(3000 - 2660, 260, 560), 340); // in-range stays
	assert.equal(clampPanelWidth(Number.NaN, 260, 560), 260); // NaN guard
});

test("sessionRowMatches: empty query passes everything (B8)", () => {
	const row = { label: "Fix login bug", title: "/home/u/pi/s1.jsonl", cwd: "/home/u/pi" };
	assert.equal(sessionRowMatches(row, ""), true);
	assert.equal(sessionRowMatches(row, "   "), true);
});

test("sessionRowMatches: matches label, cwd, or path — case-insensitive", () => {
	const row = { label: "Fix LOGIN bug", title: "/home/u/pi/s1.jsonl", cwd: "/home/u/pi" };
	assert.equal(sessionRowMatches(row, "login"), true); // label
	assert.equal(sessionRowMatches(row, "U/PI"), true); // cwd fragment
	assert.equal(sessionRowMatches(row, "s1.jsonl"), true); // session file/id
	assert.equal(sessionRowMatches(row, "nope"), false);
});
