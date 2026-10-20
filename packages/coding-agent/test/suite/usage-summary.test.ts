import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { clearUsageSummaryCache, scanUsageSummary } from "../../src/modes/web/usage-summary.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z
const HOUR_MS = 3_600_000;

function tempRoot(name: string): string {
	const dir = join(tmpdir(), `pi-usage-summary-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(dir: string, fileName: string, lines: string[], opts: { mtime?: number } = {}): string {
	const path = join(dir, fileName);
	writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
	if (opts.mtime !== undefined) {
		utimesSync(path, new Date(opts.mtime), new Date(opts.mtime));
	}
	return path;
}

let idCounter = 0;
function entryId(): string {
	idCounter += 1;
	return `e${idCounter.toString(36)}`;
}

function headerLine(opts: { id: string; cwd: string; ts: number }): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: opts.id,
		timestamp: new Date(opts.ts).toISOString(),
		cwd: opts.cwd,
	});
}

function nameLine(name: string): string {
	return JSON.stringify({
		type: "session_info",
		id: entryId(),
		parentId: null,
		timestamp: new Date(NOW).toISOString(),
		name,
	});
}

function assistantLine(opts: {
	ts: number;
	model: string;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	costTotal?: number;
}): string {
	return JSON.stringify({
		type: "message",
		id: entryId(),
		parentId: null,
		timestamp: new Date(opts.ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "…" }],
			api: "openai",
			provider: "test",
			model: opts.model,
			timestamp: opts.ts,
			usage: {
				input: opts.input,
				output: opts.output,
				cacheRead: opts.cacheRead ?? 0,
				cacheWrite: opts.cacheWrite ?? 0,
				reasoning: 0,
				totalTokens: opts.input + opts.output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.costTotal ?? 0 },
			},
			stopReason: "stop",
		},
	});
}

function userLine(ts: number): string {
	return JSON.stringify({
		type: "message",
		id: entryId(),
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: ts },
	});
}

describe("scanUsageSummary", () => {
	let root: string;
	beforeEach(() => {
		root = tempRoot("scan");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns zeroed totals for an empty sessions dir", async () => {
		const summary = await scanUsageSummary(root, { now: NOW });
		expect(summary.totals).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			sessions: 0,
			skipped: 0,
		});
		expect(summary.perDay).toEqual([]);
		expect(summary.perModel).toEqual([]);
		expect(summary.sessions).toEqual([]);
	});

	it("returns zeroed totals for a missing sessions dir", async () => {
		const summary = await scanUsageSummary(join(root, "does-not-exist"), { now: NOW });
		expect(summary.totals.sessions).toBe(0);
	});

	it("filters by range: stale files (mtime) and old records are excluded, all-time includes them", async () => {
		const projectDir = join(root, "--fixture-project--");
		mkdirSync(projectDir, { recursive: true });
		const recent = writeSessionFile(
			projectDir,
			"recent.jsonl",
			[
				headerLine({ id: "s-recent", cwd: "/p", ts: NOW - 3 * HOUR_MS }),
				assistantLine({ ts: NOW - 2 * HOUR_MS, model: "m-a", input: 100, output: 50, costTotal: 0.5 }),
			],
			{ mtime: NOW - 2 * HOUR_MS },
		);
		void recent;
		const stale = writeSessionFile(
			projectDir,
			"stale.jsonl",
			[
				headerLine({ id: "s-stale", cwd: "/p", ts: NOW - 10 * 24 * HOUR_MS }),
				assistantLine({ ts: NOW - 10 * 24 * HOUR_MS, model: "m-a", input: 999, output: 999, costTotal: 9 }),
			],
			{ mtime: NOW - 10 * 24 * HOUR_MS },
		);
		void stale;
		// Touched recently (scanned) but its records are old — record-level filter must drop them.
		writeSessionFile(
			projectDir,
			"touched-old.jsonl",
			[
				headerLine({ id: "s-touched", cwd: "/p", ts: NOW - 30 * 24 * HOUR_MS }),
				assistantLine({ ts: NOW - 30 * 24 * HOUR_MS, model: "m-a", input: 500, output: 500, costTotal: 5 }),
			],
			{ mtime: NOW - HOUR_MS },
		);

		const week = await scanUsageSummary(root, { now: NOW, rangeDays: 7 });
		expect(week.totals.input).toBe(100);
		expect(week.totals.cost).toBe(0.5);
		expect(week.totals.sessions).toBe(1);
		expect(week.sessions.map((row) => row.id)).toEqual(["s-recent"]);

		const all = await scanUsageSummary(root, { now: NOW });
		expect(all.totals.input).toBe(100 + 999 + 500);
		expect(all.totals.sessions).toBe(3);
	});

	it("counts malformed lines in skipped without throwing; healthy records still aggregate", async () => {
		const dir = join(root, "--m--");
		mkdirSync(dir, { recursive: true });
		writeSessionFile(dir, "mixed.jsonl", [
			headerLine({ id: "s-m", cwd: "/m", ts: NOW - HOUR_MS }),
			"this is not json {",
			userLine(NOW - HOUR_MS),
			'{"type":"message","id":"partial",', // truncated line
			assistantLine({ ts: NOW - 40 * 60 * 1000, model: "m-a", input: 10, output: 20, costTotal: 0.0475 }),
			assistantLine({ ts: NOW - 30 * 60 * 1000, model: "m-a", input: 30, output: 40, costTotal: 0.1 }),
		]);

		const summary = await scanUsageSummary(root, { now: NOW });
		expect(summary.totals.skipped).toBe(2);
		expect(summary.totals.input).toBe(40);
		expect(summary.totals.output).toBe(60);
		expect(summary.totals.cost).toBeCloseTo(0.1475, 10);
	});

	it("aggregates per model and sorts by cost descending", async () => {
		const dir = join(root, "--mm--");
		mkdirSync(dir, { recursive: true });
		writeSessionFile(dir, "one.jsonl", [
			headerLine({ id: "s-1", cwd: "/mm", ts: NOW - 5 * HOUR_MS }),
			assistantLine({ ts: NOW - 4 * HOUR_MS, model: "cheap-1", input: 1000, output: 100, costTotal: 0.2 }),
			assistantLine({ ts: NOW - 3 * HOUR_MS, model: "expensive-1", input: 200, output: 200, costTotal: 1.5 }),
			assistantLine({ ts: NOW - 2 * HOUR_MS, model: "cheap-1", input: 500, output: 50, costTotal: 0.1 }),
		]);

		const summary = await scanUsageSummary(root, { now: NOW });
		expect(summary.perModel).toHaveLength(2);
		expect(summary.perModel.map((row) => row.model)).toEqual(["expensive-1", "cheap-1"]);
		expect(summary.perModel[0]).toMatchObject({
			model: "expensive-1",
			input: 200,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 1.5,
			sessions: 1,
		});
		expect(summary.perModel[1]).toMatchObject({ model: "cheap-1", input: 1500, output: 150, cost: 0.3 });
		expect(summary.totals.sessions).toBe(1);
	});

	it("buckets per day by UTC date and sorts ascending", async () => {
		const dir = join(root, "--tz--");
		mkdirSync(dir, { recursive: true });
		const lateNight = Date.UTC(2026, 9, 19, 23, 30, 0); // 23:30 UTC on the 19th
		const afterMidnight = Date.UTC(2026, 9, 20, 0, 30, 0); // 00:30 UTC on the 20th
		writeSessionFile(dir, "tz.jsonl", [
			headerLine({ id: "s-tz", cwd: "/tz", ts: lateNight }),
			assistantLine({ ts: afterMidnight, model: "m", input: 10, output: 10, costTotal: 0.3 }),
			assistantLine({ ts: lateNight, model: "m", input: 20, output: 20, costTotal: 0.2 }),
		]);

		const summary = await scanUsageSummary(root, { now: NOW });
		expect(summary.perDay).toEqual([
			{ day: "2026-10-19", input: 20, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.2 },
			{ day: "2026-10-20", input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.3 },
		]);
	});

	it("sums cost and cache fields into exact totals", async () => {
		const dir = join(root, "--sums--");
		mkdirSync(dir, { recursive: true });
		writeSessionFile(dir, "sums.jsonl", [
			headerLine({ id: "s-sums", cwd: "/s", ts: NOW - HOUR_MS }),
			assistantLine({
				ts: NOW - 50 * 60 * 1000,
				model: "m",
				input: 12_400,
				output: 3100,
				cacheRead: 8200,
				cacheWrite: 900,
				costTotal: 0.0475,
			}),
			assistantLine({ ts: NOW - 40 * 60 * 1000, model: "m", input: 1000, output: 0, costTotal: 0.1 }),
			assistantLine({
				ts: NOW - 30 * 60 * 1000,
				model: "m",
				input: 200,
				output: 100,
				cacheRead: 300,
				costTotal: 1.2,
			}),
		]);

		const summary = await scanUsageSummary(root, { now: NOW });
		expect(summary.totals.input).toBe(13_600);
		expect(summary.totals.output).toBe(3200);
		expect(summary.totals.cacheRead).toBe(8500);
		expect(summary.totals.cacheWrite).toBe(900);
		expect(summary.totals.cost).toBeCloseTo(1.3475, 10);
	});

	it("builds session rows with id/name/cwd/model/modified and sorts newest first; excludes usage-less sessions", async () => {
		const dir = join(root, "--rows--");
		mkdirSync(dir, { recursive: true });
		const olderTs = NOW - 5 * HOUR_MS;
		const newerTs = NOW - HOUR_MS;
		writeSessionFile(dir, "older.jsonl", [
			headerLine({ id: "s-older", cwd: "/rows", ts: olderTs }),
			nameLine("fix-tui-bug"),
			assistantLine({ ts: olderTs + 60_000, model: "glm-old", input: 10, output: 10, costTotal: 0.1 }),
			userLine(olderTs + 120_000),
			assistantLine({ ts: olderTs + 180_000, model: "glm-new", input: 20, output: 5, costTotal: 0.05 }),
		]);
		writeSessionFile(dir, "newer.jsonl", [
			headerLine({ id: "s-newer", cwd: "/rows2", ts: newerTs }),
			assistantLine({ ts: newerTs + 60_000, model: "glm-newer", input: 7, output: 3, costTotal: 0.01 }),
		]);
		// All-usage range but a session with zero in-range records must not appear.
		writeSessionFile(
			dir,
			"silent.jsonl",
			[
				headerLine({ id: "s-silent", cwd: "/rows", ts: NOW - 8 * 24 * HOUR_MS }),
				assistantLine({ ts: NOW - 8 * 24 * HOUR_MS, model: "m", input: 1, output: 1, costTotal: 1 }),
			],
			{ mtime: NOW - 24 * HOUR_MS }, // scanned by the 7-day file filter…
		);
		const week = await scanUsageSummary(root, { now: NOW, rangeDays: 7 });
		// …but its records are older than the 7-day cutoff → excluded from rows.
		expect(week.sessions.map((row) => row.id)).toEqual(["s-newer", "s-older"]);
		expect(week.sessions.map((row) => row.modified)).toEqual([
			new Date(newerTs + 60_000).toISOString(),
			new Date(olderTs + 180_000).toISOString(),
		]);
		expect(week.sessions[0]).toMatchObject({
			id: "s-newer",
			name: "",
			cwd: "/rows2",
			model: "glm-newer",
			input: 7,
			output: 3,
			cost: 0.01,
		});
		expect(week.sessions[1]).toMatchObject({
			id: "s-older",
			name: "fix-tui-bug",
			cwd: "/rows",
			model: "glm-new",
			input: 30,
			output: 15,
			cost: 0.15,
		});
		expect(week.totals.sessions).toBe(2);
	});

	it("counts usage from a headerless file in totals but emits no session row", async () => {
		const dir = join(root, "--noh--");
		mkdirSync(dir, { recursive: true });
		writeSessionFile(dir, "noh.jsonl", [
			assistantLine({ ts: NOW - 30 * 60 * 1000, model: "m", input: 5, output: 5, costTotal: 0.5 }),
		]);
		const summary = await scanUsageSummary(root, { now: NOW });
		expect(summary.totals.input).toBe(5);
		expect(summary.totals.sessions).toBe(0);
		expect(summary.sessions).toEqual([]);
	});
});

describe("get_usage_summary cache + command", () => {
	const PREV_ENV = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		if (PREV_ENV === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = PREV_ENV;
		clearUsageSummaryCache();
	});

	it("caches per rangeDays for 30s and rescans after flushing", async () => {
		const agentRoot = tempRoot("cache");
		const sessionsDir = join(agentRoot, "sessions", "--p--");
		mkdirSync(sessionsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		clearUsageSummaryCache();

		const { getUsageSummary } = await import("../../src/modes/web/usage-summary.ts");
		// Real clock, rangeDays=0 (all time) so fresh fixtures are always in range;
		// the cache path bypasses when a deterministic `now` is supplied, so it
		// is exercised here through the production code path.
		const fresh0 = Date.now();
		writeSessionFile(sessionsDir, "a.jsonl", [
			headerLine({ id: "s-a", cwd: "/p", ts: fresh0 - HOUR_MS }),
			assistantLine({ ts: fresh0 - 30 * 60 * 1000, model: "m", input: 1, output: 1, costTotal: 1 }),
		]);
		const first = await getUsageSummary();
		expect(first.totals.cost).toBe(1);

		writeSessionFile(sessionsDir, "b.jsonl", [
			headerLine({ id: "s-b", cwd: "/p", ts: Date.now() - HOUR_MS }),
			assistantLine({ ts: Date.now() - 30 * 60 * 1000, model: "m", input: 2, output: 2, costTotal: 2 }),
		]);
		const cached = await getUsageSummary();
		expect(cached.totals.cost).toBe(1); // cache hit: freshly added file ignored

		clearUsageSummaryCache();
		const fresh = await getUsageSummary();
		expect(fresh.totals.cost).toBe(3);
		rmSync(agentRoot, { recursive: true, force: true });
	});
});

describe("get_usage_summary web command", () => {
	it("responds with the summary payload for the handler", async () => {
		const agentRoot = tempRoot("handler");
		const sessionsDir = join(agentRoot, "sessions", "--p--");
		mkdirSync(sessionsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		clearUsageSummaryCache();
		try {
			writeSessionFile(sessionsDir, "cmd.jsonl", [
				headerLine({ id: "s-cmd", cwd: "/p", ts: NOW - HOUR_MS }),
				assistantLine({ ts: NOW - 30 * 60 * 1000, model: "m", input: 42, output: 24, costTotal: 0.75 }),
			]);
			const handler = createWebCommandHandler();
			// The handler extracts session/runtime up front; this command path
			// only touches the disk scanner, so inert stubs suffice.
			const coreStub = {
				getSession: () => ({}),
				getRuntime: () => ({}),
			};
			const response = await handler({ type: "get_usage_summary" } as never, coreStub as never as RpcCore);
			expect(response).toMatchObject({
				type: "response",
				command: "get_usage_summary",
				success: true,
			});
			const data = (response as { data: { totals: { input: number; cost: number; sessions: number } } }).data;
			expect(data.totals.input).toBe(42);
			expect(data.totals.cost).toBe(0.75);
			expect(data.totals.sessions).toBe(1);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});
});

describe("scanUsageSummary walks nested session trees", () => {
	it("picks up nested run/session.jsonl files and fork exports as separate sessions", async () => {
		const root = tempRoot("nested");
		try {
			const project = join(root, "--p--");
			const treeRoot = join(project, "2026-10-20T08-00-00-000Z_root", "task-uuid", "run-0");
			mkdirSync(treeRoot, { recursive: true });
			writeSessionFile(treeRoot, "session.jsonl", [
				headerLine({ id: "s-task", cwd: "/p", ts: NOW - 4 * HOUR_MS }),
				assistantLine({ ts: NOW - 3 * HOUR_MS, model: "m", input: 8, output: 8, costTotal: 0.8 }),
			]);
			const forks = join(project, "2026-10-20T08-00-00-000Z_root", "forks");
			mkdirSync(forks, { recursive: true });
			writeSessionFile(forks, "fork-export.jsonl", [
				headerLine({ id: "s-fork", cwd: "/p", ts: NOW - 2 * HOUR_MS }),
				assistantLine({ ts: NOW - 90 * 60 * 1000, model: "m", input: 3, output: 3, costTotal: 0.3 }),
			]);

			const summary = await scanUsageSummary(root, { now: NOW });
			expect(summary.totals.input).toBe(11);
			expect(new Set(summary.sessions.map((row) => row.id))).toEqual(new Set(["s-task", "s-fork"]));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
