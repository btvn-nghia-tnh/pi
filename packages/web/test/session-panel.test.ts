import assert from "node:assert/strict";
import test from "node:test";
import { hasWidgets } from "../src/components/session-panel.ts";

test("hasWidgets only counts structured non-overlay widgets", () => {
	const base = { widgets: new Map(), collapsedWidgets: new Set() } as never;
	assert.equal(hasWidgets(base), false);
	assert.equal(
		hasWidgets({
			widgets: new Map([["todo", { lines: [], placement: "aboveEditor", data: { kind: "rpiv-todo" } }]]),
			collapsedWidgets: new Set(),
		} as never),
		true,
	);
	// Lines-only widgets stay docked under the editor — not panel content.
	assert.equal(
		hasWidgets({
			widgets: new Map([["spinner", { lines: ["tick"], placement: "aboveEditor" }]]),
			collapsedWidgets: new Set(),
		} as never),
		false,
	);
	// Overlay widgets render as modals — never as panel cards.
	assert.equal(
		hasWidgets({
			widgets: new Map([
				["ask", { lines: [], placement: "aboveEditor", data: { kind: "question", display: "overlay" } }],
			]),
			collapsedWidgets: new Set(),
		} as never),
		false,
	);
});
