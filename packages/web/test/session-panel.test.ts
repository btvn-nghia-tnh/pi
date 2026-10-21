import assert from "node:assert/strict";
import test from "node:test";
import { hasWidgets, modalLogText } from "../src/components/session-panel.ts";

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

// ---------------------------------------------------------------------
// Batch-4 T2: steer/stop helpers + modal pure projections + CSS pins
// ---------------------------------------------------------------------

test("validSteerMessage: trim, empties, and the 128 KB protocol cap", async () => {
	const { validSteerMessage, MAX_STEER_MESSAGE_BYTES } = await import("../src/components/session-panel.ts");
	assert.equal(validSteerMessage(""), undefined);
	assert.equal(validSteerMessage("   \n\t "), undefined);
	assert.equal(validSteerMessage("  hold on  "), "hold on");
	// Byte cap: 1 byte over → invalid; exactly at the cap → valid.
	assert.equal(validSteerMessage("a".repeat(MAX_STEER_MESSAGE_BYTES + 1)), undefined);
	assert.equal(validSteerMessage("a".repeat(MAX_STEER_MESSAGE_BYTES)), "a".repeat(MAX_STEER_MESSAGE_BYTES));
	// Multibyte chars count as bytes, not code points.
	const twoByteChars = "é".repeat(Math.ceil(MAX_STEER_MESSAGE_BYTES / 2) + 1);
	assert.equal(validSteerMessage(twoByteChars), undefined);
});

test("shortRunId: first uuid segment, short strings pass through", async () => {
	const { shortRunId } = await import("../src/components/session-panel.ts");
	assert.equal(shortRunId("e379a374-6d9c-4054-b901-2dd26d20193b"), "e379a374");
	assert.equal(shortRunId("abc"), "abc");
	assert.equal(shortRunId(""), "");
});

test("steerOutcomeText: queued/failed/fallback lines", async () => {
	const { steerOutcomeText } = await import("../src/components/session-panel.ts");
	assert.equal(
		steerOutcomeText({ delivered: "queued", requestId: "web-01Ab-xyz" }),
		"Steer queued (request web) — watch the steering line.",
	);
	assert.equal(steerOutcomeText({ delivered: "failed", reason: "inbox-closed" }), "Steer failed: inbox-closed.");
	assert.equal(steerOutcomeText({ delivered: "failed" }), "Steer failed.");
	assert.equal(steerOutcomeText(undefined), "Steer sent.");
	assert.equal(steerOutcomeText({ something: "else" }), "Steer sent.");
});

test("stopOutcomeText: requested/failed lines", async () => {
	const { stopOutcomeText } = await import("../src/components/session-panel.ts");
	assert.equal(
		stopOutcomeText({ delivered: "requested" }),
		"Stop requested — the run halts at its next step boundary.",
	);
	assert.equal(stopOutcomeText({ delivered: "failed" }), "Stop failed — the run may have already ended.");
	assert.equal(stopOutcomeText(undefined), "Stop requested — the run halts at its next step boundary.");
});

test("steeringSummary: counters + newest recent preview", async () => {
	const { steeringSummary } = await import("../src/components/session-panel.ts");
	assert.equal(steeringSummary(undefined), undefined);
	assert.equal(steeringSummary({}), undefined);
	assert.equal(steeringSummary({ delivered: 0, failed: 0, recent: [] }), undefined);
	assert.equal(steeringSummary({ delivered: 2 }), "steering: 2 delivered");
	assert.equal(steeringSummary({ failed: 1 }), "steering: 1 failed");
	assert.equal(steeringSummary({ delivered: 3, failed: 1 }), "steering: 3 delivered 1 failed");
	assert.equal(
		steeringSummary({ delivered: 1, recent: [{ id: "r1", messagePreview: "finish the report" }] }),
		"steering: 1 delivered last: finish the report",
	);
	// Newest recent entry wins; long previews clamp with an ellipsis.
	assert.equal(
		steeringSummary({
			delivered: 2,
			recent: [
				{ id: "old", messagePreview: "stale" },
				{ id: "new", messagePreview: "x".repeat(60) },
			],
		}),
		`steering: 2 delivered last: ${"x".repeat(47)}…`,
	);
	// Recent without a preview still surfaces "requested" when no counters.
	assert.equal(steeringSummary({ recent: [{ id: "r" }] }), "steering: requested");
});

test("isSteerableState: running and needs-attention only", async () => {
	const { isSteerableState } = await import("../src/components/session-panel.ts");
	assert.equal(isSteerableState("running"), true);
	assert.equal(isSteerableState("needs-attention"), true);
	assert.equal(isSteerableState("complete"), false);
	assert.equal(isSteerableState("failed"), false);
	assert.equal(isSteerableState("unknown"), false);
});

test("subagent card scroll fix + modal CSS pins (batch-4 B2/B4)", async () => {
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../src/styles/pages.css", import.meta.url), "utf8");
	// B2 root cause: flex rows must pin to natural height so overflow is real.
	assert.ok(
		/\.c-subagent-body\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/.test(css),
		"subagent rows pin to natural height (no shrink)",
	);
	assert.ok(
		/\.c-subagent-body\s*\{[^}]*overscroll-behavior:\s*contain/.test(css),
		"subagent body keeps wheel events contained",
	);
	// B4 modal chrome.
	assert.ok(css.includes(".c-modal-scrim"), "modal scrim exists");
	assert.ok(css.includes(".c-modal-sheet"), "modal sheet exists");
	assert.ok(/\.c-modal-sheet\s*\{[^}]*max-height:\s*min\(720px,\s*80vh\)/.test(css), "modal sheet capped at 80vh");
	assert.ok(css.includes(".c-modal-steer-textarea"), "steer textarea style exists");
});

test("modalLogText: trims trailing blank lines and keeps body verbatim", () => {
	assert.equal(modalLogText("line one\nline two\n\n"), "line one\nline two");
	assert.equal(modalLogText("  indented\n"), "  indented");
});

test("modalLogText: empty and whitespace-only logs get the placeholder", () => {
	const placeholder = "(transcript empty — the runner hasn't emitted output yet)";
	assert.equal(modalLogText(""), placeholder);
	assert.equal(modalLogText("  \n\t\n"), placeholder);
});
