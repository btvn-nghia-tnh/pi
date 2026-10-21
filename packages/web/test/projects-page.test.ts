import assert from "node:assert/strict";
import test from "node:test";
import { projectGroups, sessionTableRows } from "../src/pages/projects.ts";
import type { RpcSessionSummary } from "../src/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-20T12:00:00.000Z").getTime();

function session(overrides: Partial<RpcSessionSummary>): RpcSessionSummary {
	return {
		file: "/sessions/s.jsonl",
		id: "s0",
		cwd: "/home/u/pi",
		created: new Date(NOW - 2 * DAY).toISOString(),
		modified: new Date(NOW - 1 * DAY).toISOString(),
		messageCount: 10,
		firstMessage: "first msg",
		...overrides,
	};
}

test("projectGroups groups by cwd, sorts by last activity, computes meta", () => {
	const sessions = [
		session({ file: "/a.jsonl", id: "a", messageCount: 18, modified: new Date(NOW - HOUR).toISOString() }),
		session({
			cwd: "/home/u/other",
			file: "/b.jsonl",
			id: "b",
			messageCount: 5,
			modified: new Date(NOW - DAY).toISOString(),
		}),
		session({ file: "/c.jsonl", id: "c", messageCount: 42, modified: new Date(NOW - 30 * MINUTE).toISOString() }),
	];
	const groups = projectGroups(sessions, [
		{ id: "a", cwd: "/home/u/pi", running: true },
		{ id: "c", cwd: "/home/u/pi", running: true },
		{ id: "zz", cwd: "/other-project", running: true },
	]);
	assert.equal(groups.length, 2);
	assert.equal(groups[0]?.cwd, "/home/u/pi");
	assert.equal(groups[0]?.name, "pi");
	assert.equal(groups[0]?.sessions.length, 2);
	assert.equal(groups[0]?.totalMessages, 60);
	assert.equal(groups[0]?.running, 2);
	// lastModified = max of the group's modified timestamps.
	assert.equal(groups[0]?.lastModified, new Date(NOW - 30 * MINUTE).toISOString());
	assert.equal(groups[1]?.cwd, "/home/u/other");
	assert.equal(groups[1]?.running, 0);
});

test("projectGroups handles empty input, basename edges, and home-ish cwds", () => {
	assert.deepEqual(projectGroups([], []), []);
	const groups = projectGroups([session({ cwd: "~", file: "/x.jsonl" })], []);
	assert.equal(groups[0]?.name, "~");
	const rootGroups = projectGroups([session({ cwd: "/", file: "/r.jsonl" })], []);
	assert.equal(rootGroups[0]?.name, "/");
});

test("projectGroups excludes /tmp cwds — test-suite noise, not projects", () => {
	// Owner: pi's own test suites spawn one-shot sessions under /tmp which
	// flooded the Projects list; those cwds never represent real projects.
	const sessions = [
		session({ cwd: "/tmp", file: "/t.jsonl", modified: new Date(NOW - MINUTE).toISOString() }),
		session({ cwd: "/tmp/pi-2753-abc/", file: "/t2.jsonl", modified: new Date(NOW).toISOString() }),
		session({ cwd: "/home/u/pi", file: "/real.jsonl", modified: new Date(NOW - DAY).toISOString() }),
	];
	const groups = projectGroups(sessions, [
		{ id: "tmpRun", cwd: "/tmp", running: true },
		{ id: "realRun", cwd: "/home/u/pi", running: true },
	]);
	assert.deepEqual(
		groups.map((group) => group.cwd),
		["/home/u/pi"],
	);
	assert.equal(groups[0]?.running, 1); // /tmp running badge không rò vào group khác
});

test("projectGroups sorts by last activity descending", () => {
	const sessions = [
		session({ cwd: "/old", file: "/1.jsonl", modified: new Date(NOW - 10 * DAY).toISOString() }),
		session({ cwd: "/new", file: "/2.jsonl", modified: new Date(NOW - MINUTE).toISOString() }),
	];
	const groups = projectGroups(sessions, []);
	assert.deepEqual(
		groups.map((group) => group.cwd),
		["/new", "/old"],
	);
});

test("sessionTableRows sorts by modified, falls back through name candidates, defaults cost to dash", () => {
	const named = session({
		file: "/n.jsonl",
		name: "ui-redesign",
		modified: new Date(NOW - HOUR).toISOString(),
		messageCount: 18,
	});
	const firstMsg = session({
		file: "/f.jsonl",
		cwd: "/home/u/x",
		firstMessage: "help me wire the drawer",
		messageCount: 4,
		modified: new Date(NOW - 30 * MINUTE).toISOString(),
	});
	const bare = session({
		file: "/nested/2026-10-01_nightly.jsonl",
		firstMessage: "",
		modified: new Date(NOW - 3 * DAY).toISOString(),
		messageCount: 96,
	});
	const rows = sessionTableRows([named, firstMsg, bare], NOW);
	assert.deepEqual(
		rows.map((row) => row.name),
		["help me wire the drawer", "ui-redesign", "2026-10-01_nightly.jsonl"],
	);
	assert.equal(rows[0]?.messages, "4");
	assert.equal(rows[0]?.modifiedText, "30m ago");
	assert.equal(rows[1]?.modifiedText, "1h ago");
	assert.equal(rows[2]?.modifiedText, "3d ago");
	assert.ok(rows.every((row) => row.cost === "—"));
});

test("sessionTableRows formats cost from a usage map via formatCost and tolerates gaps", () => {
	const a = session({ file: "/a.jsonl", modified: new Date(NOW - MINUTE).toISOString() });
	const b = session({ file: "/b.jsonl", modified: new Date(NOW - 2 * MINUTE).toISOString() });
	const rows = sessionTableRows([a, b], NOW, new Map([["/b.jsonl", 23.8]]));
	assert.equal(rows[0]?.cost, "—");
	// formatCost(23.8) === "$23.80" (R10: real formatter output).
	assert.equal(rows[1]?.cost, "$23.80");
});

// ---- issue batch 3: New project path resolution + panel width clamps ----

import { clampPanelWidth, readStoredPanelWidth } from "../src/components/panel-resizer.ts";
import { resolveNewProject } from "../src/pages/projects.ts";

test("resolveNewProject accepts absolute paths and strips trailing slashes", () => {
	assert.deepEqual(resolveNewProject("/home/u/pi"), { ok: true, cwd: "/home/u/pi" });
	assert.deepEqual(resolveNewProject("/home/u/pi/"), { ok: true, cwd: "/home/u/pi" });
	assert.deepEqual(resolveNewProject("  /home/u/pi  "), { ok: true, cwd: "/home/u/pi" });
	// root survives slash-strip
	assert.deepEqual(resolveNewProject("/"), { ok: true, cwd: "/" } as const);
	assert.deepEqual(resolveNewProject("/home///"), { ok: true, cwd: "/home" } as const);
});

test("resolveNewProject rejects empty and relative inputs", () => {
	assert.deepEqual(resolveNewProject(""), { ok: false, reason: "empty" });
	assert.deepEqual(resolveNewProject("   "), { ok: false, reason: "empty" });
	assert.deepEqual(resolveNewProject("relative/path"), { ok: false, reason: "relative" });
	assert.deepEqual(resolveNewProject("~/../etc", "/home/u"), { ok: true, cwd: "/home/u/../etc" } as const);
});

test("resolveNewProject expands ~ against home when known", () => {
	assert.deepEqual(resolveNewProject("~", "/home/u"), { ok: true, cwd: "/home/u" } as const);
	assert.deepEqual(resolveNewProject("~/projects/pi", "/home/u"), { ok: true, cwd: "/home/u/projects/pi" } as const);
	assert.deepEqual(resolveNewProject("~/", "/home/u"), { ok: true, cwd: "/home/u" } as const);
	assert.deepEqual(resolveNewProject("~", undefined), { ok: true, cwd: "~" } as const);
});

test("clampPanelWidth clamps to range and rounds (R10: pure math truth)", () => {
	assert.equal(clampPanelWidth(100, 220, 480), 220);
	assert.equal(clampPanelWidth(600, 220, 480), 480);
	assert.equal(clampPanelWidth(307.6, 220, 480), 308);
	assert.equal(clampPanelWidth(Number.NaN, 220, 480), 220);
	assert.equal(clampPanelWidth(Number.POSITIVE_INFINITY, 220, 480), 480);
});

test("readStoredPanelWidth clamps persisted values and tolerates junk", () => {
	const store = new Map<string, string>([
		["good", "340"],
		["junk", "abc"],
		["out-of-range", "9999"],
	]);
	(globalThis as { window?: unknown }).window = { localStorage: { getItem: (key: string) => store.get(key) ?? null } };
	assert.equal(readStoredPanelWidth("good", 220, 480), 340);
	assert.equal(readStoredPanelWidth("missing", 220, 480), undefined);
	assert.equal(readStoredPanelWidth("junk", 220, 480), undefined);
	assert.equal(readStoredPanelWidth("out-of-range", 220, 480), 480);
	delete (globalThis as { window?: unknown }).window;
});
