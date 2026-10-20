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

test("subagentRows: ordering, dedupe, tone buckets, clamps, and relative times", async () => {
	const { subagentRows } = await import("../src/components/session-panel.ts");
	const now = Date.parse("2026-10-21T10:00:00.000Z");
	// Two minutes before `now` → "2m ago".
	const t = (minutesAgo: number): number => now - minutesAgo * 60_000;

	const rows = subagentRows(
		[
			{
				id: "a",
				state: "complete",
				task: "wire the resizer",
				updatedAt: t(30),
			},
			{
				id: "b",
				state: "running",
				task: "mcpConfigList backend",
				updatedAt: t(1),
			},
			{
				id: "b", // duplicate: fresher payload wins
				state: "running",
				task: "mcp_config_list backend",
				updatedText: "",
				updatedAt: t(1),
			} as never,
			{
				id: "c",
				state: "failed",
				task: `x-padding-${"y".repeat(100)}`,
				activity: `log ${"z".repeat(140)}`,
				model: "bioturing/glm-5.1",
				startedAt: t(60),
				updatedAt: t(5),
			},
			{
				id: "d",
				state: "weird-state-name",
				updatedAt: t(10),
			},
			{
				id: "", // dropped: no id
				state: "running",
				updatedAt: t(1),
			},
		],
		now,
	);

	// Order: running first, then updatedAt desc; "a" (30m) after "d"/"c".
	assert.deepEqual(
		rows.map((row) => row.id),
		["b", "c", "d", "a"],
	);
	// Tone buckets per spec.
	assert.deepEqual(
		rows.map((row) => row.tone),
		["accent", "danger", "dim", "ok"],
	);
	// Dedupe kept the fresher "b" text.
	assert.equal(rows[0]!.task, "mcp_config_list backend");
	// 80-char clamp with ellipsis; 120-char clamp on activity (row "c").
	assert.equal(rows[1]!.task.length, 80);
	assert.ok(rows[1]!.task.endsWith("…"));
	assert.equal(rows[1]!.activity.length, 120);
	assert.ok(rows[1]!.activity.endsWith("…"));
	// Model chip text passes through trimmed.
	assert.equal(rows[1]!.model, "bioturing/glm-5.1");
	// Relative labels from epoch/ISO stamps.
	assert.equal(rows[1]!.updatedText, "5m ago");
	assert.equal(rows[1]!.startedText, "1h ago");
	assert.equal(rows[3]!.updatedText, "30m ago");
	// Unknown state string normalizes to "unknown" (row "d", no task).
	assert.equal(rows[2]!.state, "unknown");
	assert.equal(rows[2]!.task, "");
});

test("subagentRows: epoch numbers and ISO strings agree on sorting/latest", async () => {
	const { subagentRows } = await import("../src/components/session-panel.ts");
	const now = Date.parse("2026-10-21T10:00:00.000Z");
	const isoLater = new Date(now - 60_000).toISOString(); // 1m ago — later
	const isoEarlier = new Date(now - 600_000).toISOString(); // 10m ago
	const rows = subagentRows(
		[
			{ id: "iso", state: "complete", updatedAt: isoEarlier },
			{ id: "epoch", state: "complete", updatedAt: now - 60_000 },
			{ id: "iso2", state: "running", updatedAt: isoLater },
		],
		now,
	);
	// running first; then later-updated first.
	assert.deepEqual(
		rows.map((row) => row.id),
		["iso2", "epoch", "iso"],
	);
	assert.deepEqual(
		rows.map((row) => row.updatedText),
		["1m ago", "1m ago", "10m ago"],
	);
});

test("subagentRows: empty/undefined run lists return an empty array", async () => {
	const { subagentRows } = await import("../src/components/session-panel.ts");
	assert.deepEqual(subagentRows([], 0), []);
	assert.deepEqual(subagentRows(undefined, 0), []);
});
