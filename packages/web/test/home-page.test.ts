import assert from "node:assert/strict";
import test from "node:test";
import { heroPlaceholder, recentProjects, recentSessions, sparklineSeries } from "../src/pages/home.ts";

const mkSummary = (over: Record<string, unknown>) =>
	({
		file: `/sessions/${String(over.id ?? "aaa")}.jsonl`,
		id: "aaa",
		cwd: "/home/u/pi",
		created: "2026-10-19T10:00:00.000Z",
		modified: "2026-10-20T09:00:00.000Z",
		messageCount: 12,
		firstMessage: "first!",
		name: "",
		...over,
	}) as never;

test("heroPlaceholder renders the Phase-1 stub tone with an optional version chip", () => {
	assert.deepEqual(heroPlaceholder(), {
		heading: "Welcome back",
		sub: "Pick a session, or start something new — pi is listening.",
		versionChip: undefined,
	});
	assert.deepEqual(heroPlaceholder("0.84.4"), {
		heading: "Welcome back",
		sub: "Pick a session, or start something new — pi is listening.",
		versionChip: "pi v0.84.4",
	});
});

test("recentProjects groups by cwd, names by basename, sorts recent-first, counts running", () => {
	const sessions = [
		mkSummary({ id: "a1", cwd: "/home/u/pi", modified: "2026-10-20T09:00:00.000Z" }),
		mkSummary({ id: "b1", cwd: "/home/u/pi", modified: "2026-10-20T11:00:00.000Z" }),
		mkSummary({ id: "c1", cwd: "/home/u/watvmedia", modified: "2026-10-18T08:00:00.000Z" }),
		mkSummary({ id: "d1", cwd: "/", modified: "2026-10-01T08:00:00.000Z" }),
	];
	const open = [
		{ id: "a1", cwd: "/home/u/pi", running: true },
		{ id: "zzz", cwd: "/home/u/other", running: true },
	];
	const groups = recentProjects(sessions, open);
	assert.deepEqual(
		groups.map((g) => [g.name, g.path, g.count]),
		[
			["pi", "/home/u/pi", 2],
			["watvmedia", "/home/u/watvmedia", 1],
			["/", "/", 1],
		],
	);
	assert.equal(groups[0]!.lastModified, "2026-10-20T11:00:00.000Z");
	assert.deepEqual(
		groups.map((g) => g.running),
		[1, 0, 0],
	);
});

test("recentProjects returns [] for no sessions", () => {
	assert.deepEqual(recentProjects([], []), []);
});

test("recentSessions sorts recent-first, limits, and falls back on names", () => {
	const sessions = [
		// Newest, no name/message → id fallback.
		mkSummary({ id: "new1", name: undefined, firstMessage: "", modified: "2026-10-20T09:00:00.000Z" }),
		// Newer still, empty-string name → firstMessage fallback ("first!").
		mkSummary({ id: "new2", name: "", modified: "2026-10-21T09:00:00.000Z" }),
	];
	const rows = recentSessions(sessions, 5);
	assert.equal(rows[0]!.id, "new2");
	assert.equal(rows[0]!.displayName, "first!");
	assert.equal(rows[1]!.id, "new1");
	assert.equal(rows[1]!.displayName, "new1");

	const withMessage = recentSessions(
		[mkSummary({ id: "x", name: undefined, firstMessage: "hello world preview" })],
		1,
	);
	assert.equal(withMessage[0]!.displayName, "hello world preview");

	const bulk = Array.from({ length: 7 }, (_, i) =>
		mkSummary({
			id: `bulk${i}`,
			name: `bulk ${i}`,
			firstMessage: "",
			modified: `2026-09-${String(10 + i).padStart(2, "0")}T09:00:00.000Z`,
		}),
	);
	const limited = recentSessions([sessions[0]!, sessions[1]!, ...bulk], 5);
	assert.equal(limited.length, 5);
	// September entries all rank below the October pair; the newest three bulks fill rows 2-4.
	assert.deepEqual(
		limited.slice(2).map((r) => r.id),
		["bulk6", "bulk5", "bulk4"],
	);
});

test("sparklineSeries normalizes to 0..1 by max and pads single points", () => {
	assert.deepEqual(sparklineSeries([10, 20, 5]), [0.5, 1, 0.25]);
	assert.deepEqual(sparklineSeries([7]), [0, 1]);
	assert.deepEqual(sparklineSeries([]), []);
	assert.deepEqual(sparklineSeries([0, 0]), [0, 0]);
});
