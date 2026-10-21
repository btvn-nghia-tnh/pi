import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { listSubagentRuns } from "../../src/modes/web/subagent-status.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(
		tmpdir(),
		`pi-subagent-status-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface RunFixture {
	status?: unknown;
	events?: Array<Record<string, unknown>>;
	log?: string;
	junkStatus?: boolean;
}

/** Materialize one fixture run directory in the discovered on-disk format. */
function makeRun(root: string, id: string, fixture: RunFixture = {}): string {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	if (fixture.junkStatus) {
		writeFileSync(join(dir, "status.json"), "{ not json", "utf-8");
	} else if (fixture.status !== undefined) {
		writeFileSync(join(dir, "status.json"), `${JSON.stringify(fixture.status, null, 2)}\n`, "utf-8");
	}
	if (fixture.events !== undefined) {
		const lines = fixture.events.map((event) => JSON.stringify(event)).join("\n");
		writeFileSync(join(dir, "events.jsonl"), `${lines}\n`, "utf-8");
	}
	if (fixture.log !== undefined) {
		writeFileSync(join(dir, "output-0.log"), fixture.log, "utf-8");
	}
	return dir;
}

function runStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		lifecycleArtifactVersion: 3,
		runId: "test",
		mode: "single",
		state: "complete",
		startedAt: 1000,
		lastActivityAt: 1500,
		lastUpdate: 1500,
		currentStep: 0,
		steps: [
			{
				agent: "worker",
				sessionName: "worker: do the thing",
				model: "bioturing/glm-5.1:high",
				status: "complete",
				turnCount: 3,
				toolCount: 5,
				startedAt: 1000,
				endedAt: 1500,
				recentTools: [],
				recentOutput: [],
				tokens: { input: 1, output: 2, total: 3 },
			},
		],
		totalTokens: { input: 1, output: 2, total: 3 },
		turnCount: 3,
		toolCount: 5,
		...overrides,
	};
}

describe("listSubagentRuns", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("sorts running first, then by updatedAt descending", () => {
		makeRun(root, "run-old-complete", {
			status: runStatus({ state: "complete", lastUpdate: 100, lastActivityAt: 100 }),
		});
		makeRun(root, "run-new-failed", {
			status: runStatus({ state: "failed", lastUpdate: 300, lastActivityAt: 300 }),
		});
		makeRun(root, "run-between-running", {
			status: runStatus({ state: "running", lastUpdate: 200, lastActivityAt: 200 }),
		});
		makeRun(root, "run-oldest-running", {
			status: runStatus({ state: "running", lastUpdate: 50, lastActivityAt: 50 }),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs.map((run) => run.id)).toEqual([
			"run-between-running",
			"run-oldest-running",
			"run-new-failed",
			"run-old-complete",
		]);
	});

	it("parses a complete run from status.json", () => {
		makeRun(root, "run-1", { status: runStatus() });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs).toHaveLength(1);
		const run = runs[0];
		expect(run.id).toBe("run-1");
		expect(run.dir).toBe(join(root, "run-1"));
		expect(run.state).toBe("complete");
		expect(run.agent).toBe("worker");
		expect(run.model).toBe("bioturing/glm-5.1:high");
		expect(run.task).toBe("do the thing");
		expect(run.startedAt).toBe(1000);
		expect(run.updatedAt).toBe(1500);
		expect(run.turnCount).toBe(3);
		expect(run.toolCount).toBe(5);
		expect(run.steps).toBe(1);
	});

	it("strips the agent prefix from the task and clamps to 80 chars", () => {
		const longTask = "a".repeat(140);
		makeRun(root, "run-1", {
			status: runStatus({
				state: "running",
				steps: [
					{
						agent: "reviewer",
						sessionName: `reviewer: ${longTask}`,
						status: "running",
						recentOutput: [],
						recentTools: [],
					},
				],
			}),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].task).toBe(`a`.repeat(79) + "…");
	});

	it("takes activity from the last non-empty recentOutput line, clamped to 120", () => {
		makeRun(root, "run-1", {
			status: runStatus({
				state: "running",
				steps: [
					{
						agent: "worker",
						sessionName: "worker: t",
						status: "running",
						recentOutput: ["   ", `${"x".repeat(200)} trailing`, "the last thing it said"],
						recentTools: [{ tool: "read", args: "b", endMs: 5 }],
					},
				],
			}),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].activity).toBe("the last thing it said");
	});

	it("falls back to the newest recentTools entry when output is empty", () => {
		makeRun(root, "run-1", {
			status: runStatus({
				state: "running",
				steps: [
					{
						agent: "worker",
						sessionName: "worker: t",
						status: "running",
						recentOutput: [],
						recentTools: [{ tool: "read", args: "/some/path", endMs: 5 }],
					},
				],
			}),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].activity).toBe("read /some/path");
	});

	it("passes a failed state through from status.json", () => {
		makeRun(root, "run-1", { status: runStatus({ state: "failed" }) });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].state).toBe("failed");
	});

	it("derives state from events when status.json is absent (completed)", () => {
		makeRun(root, "run-1", {
			events: [
				{ type: "subagent.run.started", ts: 10, runId: "run-1", mode: "single" },
				{ type: "subagent.step.started", ts: 11, stepIndex: 0, agent: "worker" },
				{ type: "subagent.step.completed", ts: 20, stepIndex: 0, agent: "worker", exitCode: 0 },
				{ type: "subagent.run.completed", ts: 21, status: "complete" },
			],
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].state).toBe("complete");
		expect(runs[0].agent).toBe("worker");
		expect(runs[0].startedAt).toBe(10);
	});

	it("marks an events-only run without a completion as running", () => {
		makeRun(root, "run-1", {
			events: [
				{ type: "subagent.run.started", ts: 10 },
				{ type: "subagent.step.started", ts: 11, agent: "worker" },
			],
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].state).toBe("running");
	});

	it("marks a nonzero step exit as failed when there is no run completion", () => {
		makeRun(root, "run-1", {
			events: [
				{ type: "subagent.run.started", ts: 10 },
				{ type: "subagent.step.completed", ts: 20, exitCode: 3 },
			],
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].state).toBe("failed");
	});

	it("treats run.completed as the final word over an earlier step failure", () => {
		makeRun(root, "run-1", {
			events: [
				{ type: "subagent.run.started", ts: 10 },
				{ type: "subagent.step.completed", ts: 20, exitCode: 1 },
				{ type: "subagent.run.completed", ts: 21, status: "complete" },
			],
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].state).toBe("complete");
	});

	it("surfaces an empty run directory as state unknown but present", () => {
		makeRun(root, "run-empty");
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe("run-empty");
		expect(runs[0].state).toBe("unknown");
	});

	it("falls back to events when status.json is malformed", () => {
		makeRun(root, "run-1", {
			junkStatus: true,
			events: [
				{ type: "subagent.run.started", ts: 10 },
				{ type: "subagent.run.completed", ts: 30, status: "failed" },
			],
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].state).toBe("failed");
	});

	it("counts non-empty lines of output-0.log", () => {
		makeRun(root, "run-1", { status: runStatus(), log: "first\n\nsecond\nthird\n" });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].lines).toBe(3);
	});

	it("reports lines as undefined when the log is absent", () => {
		makeRun(root, "run-1", { status: runStatus() });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].lines).toBeUndefined();
	});

	it("passes existing roots through and filters nonexistent ones", () => {
		makeRun(root, "run-1", { status: runStatus() });
		const missing = join(root, "does-not-exist");
		const { roots, runs } = listSubagentRuns({ roots: [root, missing] });
		expect(roots).toEqual([root]);
		expect(runs).toHaveLength(1);
	});

	it("yields a defined updatedAt from directory mtime when status has none", () => {
		makeRun(root, "run-1", {
			events: [{ type: "subagent.run.started", ts: 10 }],
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(typeof runs[0].updatedAt).toBe("number");
		expect(runs[0].updatedAt).toBeGreaterThan(0);
	});

	it("passes status.json sessionId through as sessionId", () => {
		makeRun(root, "run-1", { status: runStatus({ sessionId: "/sessions/a.jsonl" }) });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].sessionId).toBe("/sessions/a.jsonl");
	});

	it("leaves sessionId undefined when status.json has none", () => {
		makeRun(root, "run-1", { status: runStatus() });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs[0].sessionId).toBeUndefined();
	});

	it("filters runs to a single session when sessionPath is given", () => {
		makeRun(root, "run-a", { status: runStatus({ sessionId: "/sessions/a.jsonl" }) });
		makeRun(root, "run-b", { status: runStatus({ sessionId: "/sessions/b.jsonl" }) });
		makeRun(root, "run-unknown-session", { status: runStatus() });
		const { runs } = listSubagentRuns({ roots: [root], sessionPath: "/sessions/a.jsonl" });
		expect(runs.map((run) => run.id)).toEqual(["run-a"]);
	});

	it("drops runs without a recorded sessionId while filtering", () => {
		makeRun(root, "run-unknown-session", { status: runStatus() });
		const { runs } = listSubagentRuns({ roots: [root], sessionPath: "/sessions/a.jsonl" });
		expect(runs).toEqual([]);
	});

	it("keeps the machine-wide list when sessionPath is absent", () => {
		makeRun(root, "run-a", { status: runStatus({ sessionId: "/sessions/a.jsonl" }) });
		makeRun(root, "run-b", { status: runStatus({ sessionId: "/sessions/b.jsonl" }) });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs).toHaveLength(2);
	});
});

describe("workflow child expansion", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function workflowStatus(
		children: Array<Record<string, unknown>>,
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			lifecycleArtifactVersion: 3,
			runId: "wf",
			mode: "workflow",
			state: "running",
			startedAt: 1000,
			lastActivityAt: 1500,
			lastUpdate: 1500,
			currentStep: 0,
			steps: children,
			...overrides,
		};
	}

	function childStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			agent: "delegate",
			runId: "child-step",
			label: "worker",
			status: "completed",
			sessionName: "delegate: làm việc",
			startedAt: 1000,
			lastActivityAt: 1200,
			recentOutput: [],
			recentTools: [],
			...overrides,
		};
	}

	it("expands a workflow into one row per step child with identities", () => {
		makeRun(root, "wf-1", {
			status: workflowStatus([
				childStep({
					runId: "child-a",
					label: "poet",
					status: "running",
					sessionName: "delegate: viết thơ",
					sessionFile: "/s/a.jsonl",
					lastActivityAt: 900,
					model: "m1",
					recentOutput: ["đang viết"],
					turnCount: 2,
					toolCount: 4,
				}),
				childStep({
					runId: "child-b",
					label: "critic",
					status: "pending",
					sessionName: "delegate: chấm điểm",
					lastActivityAt: 800,
				}),
				childStep({
					runId: "child-c",
					label: "seer",
					status: "completed",
					sessionName: "delegate: dự báo",
					lastActivityAt: 1600,
				}),
			]),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs.map((run) => run.id)).toEqual(["child-a", "child-c", "child-b"]);
		const a = runs[0] as {
			parentRunId?: string;
			childId?: string;
			childIndex?: number;
			sessionFile?: string;
			label?: string;
			task?: string;
			activity?: string;
			state?: string;
		};
		expect(a.parentRunId).toBe("wf-1");
		expect(a.childId).toBe("child-a");
		expect(a.childIndex).toBe(0);
		expect(a.sessionFile).toBe("/s/a.jsonl");
		expect(a.label).toBe("poet");
		expect(a.task).toBe("viết thơ");
		expect(a.activity).toBe("đang viết");
		expect(a.state).toBe("running");
		const b = runs[2] as { state?: string };
		expect(b.state).toBe("pending");
	}, 10_000);

	it("maps step statuses and the needs_attention marker onto card states", () => {
		makeRun(root, "wf-1", {
			status: runStatus({
				mode: "workflow",
				state: "running",
				steps: [
					{ agent: "delegate", runId: "c-run", status: "running", recentOutput: [], recentTools: [] },
					{ agent: "delegate", runId: "c-pend", status: "queued", recentOutput: [], recentTools: [] },
					{ agent: "delegate", runId: "c-fail", status: "failed", recentOutput: [], recentTools: [] },
					{ agent: "delegate", runId: "c-stop", status: "cancelled", recentOutput: [], recentTools: [] },
					{
						agent: "delegate",
						runId: "c-attention",
						status: "running",
						activityState: "needs_attention",
						recentOutput: [],
						recentTools: [],
					},
					{ agent: "delegate", runId: "c-weird", status: "hibernating", recentOutput: [], recentTools: [] },
				],
			}),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		const byId = new Map(runs.map((run) => [run.id, run.state]));
		expect(byId.get("c-run")).toBe("running");
		expect(byId.get("c-pend")).toBe("pending");
		expect(byId.get("c-fail")).toBe("failed");
		expect(byId.get("c-stop")).toBe("stopped");
		expect(byId.get("c-attention")).toBe("needs-attention");
		expect(byId.get("c-weird")).toBe("unknown");
	}, 10_000);

	it("flags live sync children via control/workflow-foreground and not finished ones", () => {
		const runDir = makeRun(root, "wf-live", {
			status: workflowStatus([
				childStep({ runId: "c-live", status: "running" }),
				childStep({ runId: "c-gone", status: "completed" }),
				{ agent: "delegate", status: "running", recentOutput: [], recentTools: [] },
			]),
		});
		mkdirSync(join(runDir, "control", "workflow-foreground", "c-live"), { recursive: true });
		const { runs } = listSubagentRuns({ roots: [root] });
		const live = runs.find((run) => run.id === "c-live");
		const gone = runs.find((run) => run.id === "c-gone");
		const unnamed = runs.find((run) => run.id === "wf-live#2");
		expect(live?.syncRoute).toBe(true);
		expect(gone?.syncRoute).toBeUndefined();
		expect(unnamed?.childIndex).toBe(2);
		expect(unnamed?.childId).toBeUndefined();
		expect(unnamed?.parentRunId).toBe("wf-live");
	}, 10_000);

	it("session-scoping keeps only the active session's children (sessionId passes through)", () => {
		makeRun(root, "wf-a", {
			status: workflowStatus([childStep({ runId: "a-1" }), childStep({ runId: "a-2" })], {
				sessionId: "/sessions/a.jsonl",
			}),
		});
		makeRun(root, "wf-b", {
			status: workflowStatus([childStep({ runId: "b-1" })], { sessionId: "/sessions/b.jsonl" }),
		});
		const { runs } = listSubagentRuns({ roots: [root], sessionPath: "/sessions/a.jsonl" });
		expect(runs.map((run) => run.id).sort()).toEqual(["a-1", "a-2"]);
		for (const run of runs) expect(run.sessionId).toBe("/sessions/a.jsonl");
	}, 10_000);

	it("falls back to the parent row when a workflow recorded no steps", () => {
		makeRun(root, "wf-empty", { status: workflowStatus([], { state: "failed" }) });
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs).toHaveLength(1);
		expect(runs[0].id).toBe("wf-empty");
		expect(runs[0].state).toBe("failed");
		expect(runs[0].parentRunId).toBeUndefined();
	}, 10_000);

	it("leaves single and chain modes as one directory row", () => {
		makeRun(root, "run-single", {
			status: runStatus({
				mode: "single",
				steps: [
					{ agent: "worker", sessionName: "worker: t", status: "complete", recentOutput: [], recentTools: [] },
				],
			}),
		});
		makeRun(root, "run-chain", {
			status: runStatus({
				mode: "chain",
				steps: [
					{ agent: "worker", sessionName: "worker: t", status: "complete", recentOutput: [], recentTools: [] },
					{ agent: "reviewer", sessionName: "reviewer: t", status: "complete", recentOutput: [], recentTools: [] },
				],
			}),
		});
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs.map((run) => run.id).sort()).toEqual(["run-chain", "run-single"]);
		expect(runs.find((run) => run.id === "run-chain")?.steps).toBe(2);
		expect(runs.every((run) => run.parentRunId === undefined)).toBe(true);
	}, 10_000);
});

describe("subagent_status web command", () => {
	it("answers with the scanner payload through the handler", async () => {
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler({ type: "subagent_status" } as never, core as unknown as RpcCore)) as {
			type: string;
			command: string;
			success: boolean;
			data: { roots: string[]; runs: unknown[] };
		};
		expect(response.type).toBe("response");
		expect(response.command).toBe("subagent_status");
		expect(response.success).toBe(true);
		expect(Array.isArray(response.data.roots)).toBe(true);
		expect(Array.isArray(response.data.runs)).toBe(true);
		// Tolerant contract: every run carries at least id/dir/state.
		for (const run of response.data.runs as Array<{ id: unknown; dir: unknown; state: unknown }>) {
			expect(typeof run.id).toBe("string");
			expect(typeof run.dir).toBe("string");
			expect(typeof run.state).toBe("string");
		}
	});

	it("scopes the scan by sessionPath (no match answers with no runs)", async () => {
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler(
			{ type: "subagent_status", sessionPath: "/no/such/session.jsonl" } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; data: { runs: unknown[] } };
		expect(response.success).toBe(true);
		// Every run on disk records a sessionId, so a bogus path matches nothing.
		expect(response.data.runs).toEqual([]);
	});

	it("rejects a non-string sessionPath", async () => {
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler(
			{ type: "subagent_status", sessionPath: 42 } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(response.success).toBe(false);
		expect(response.error).toBe("sessionPath must be a string");
	});
});
