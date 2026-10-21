/**
 * subagent_steer / subagent_stop + subagent_status steer enrichment (batch-4).
 *
 * Fixtures follow R10: every control-inbox file asserted against is written by
 * the code under test (or by these tests in the documented runner shapes) and
 * read back from disk — no hand-copied expected payloads.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { listSubagentRuns } from "../../src/modes/web/subagent-status.ts";
import {
	controlInboxDir,
	SubagentSteerError,
	steerSubagentRun,
	stopSubagentRun,
} from "../../src/modes/web/subagent-steer.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(
		tmpdir(),
		`pi-subagent-steer-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function runStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		lifecycleArtifactVersion: 3,
		runId: "r",
		mode: "single",
		state: "running",
		startedAt: 1000,
		lastActivityAt: 1500,
		lastUpdate: 1500,
		currentStep: 0,
		steps: [
			{
				agent: "worker",
				sessionName: "worker: do the thing",
				model: "bioturing/glm-5.1:high",
				status: "running",
				turnCount: 3,
				toolCount: 5,
				recentTools: [],
				recentOutput: [],
				startedAt: 1000,
				tokens: { input: 1, output: 2, total: 3 },
			},
		],
		totalTokens: { input: 1, output: 2, total: 3 },
		turnCount: 3,
		toolCount: 5,
		...overrides,
	};
}

/** Fixture run directory materialized in the on-disk protocol format. */
function makeRun(root: string, id: string, status: Record<string, unknown>): string {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
	return dir;
}

/** Ack record in the runner's documented steer-acks shape. */
function writeAck(runDir: string, requestId: string, state: string, ts: number, message = "ok"): void {
	const dir = join(controlInboxDir(runDir), "steer-acks", "0");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `ack-${ts}-${state}.json`),
		`${JSON.stringify({
			type: "steer-ack",
			protocolVersion: 1,
			requestId,
			index: 0,
			ts,
			state,
			message,
		})}\n`,
		"utf-8",
	);
}

/** Workflow-run status fixture with per-child steps. */
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

/** One workflow child step record. */
function childStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agent: "delegate",
		runId: "child-step",
		label: "worker",
		status: "running",
		sessionName: "delegate: làm việc",
		startedAt: 1000,
		lastActivityAt: 1400,
		recentOutput: [],
		recentTools: [],
		...overrides,
	};
}

/** Register the in-process steering route a live sync child owns. */
function makeSyncRoute(runDir: string, childId: string, index: number): string {
	const route = join(runDir, "control", "workflow-foreground", childId);
	mkdirSync(join(route, "steer-targets", String(index)), { recursive: true });
	mkdirSync(join(route, "steer-acks", String(index)), { recursive: true });
	mkdirSync(join(route, "steer-capabilities"), { recursive: true });
	return route;
}

/** Child ack in the route's steer-acks shape (flat files, suffixed names). */
function writeRouteAck(route: string, index: number, requestId: string, state: string, ts = 123): void {
	mkdirSync(join(route, "steer-acks", String(index)), { recursive: true });
	writeFileSync(
		join(route, "steer-acks", String(index), `ack-${ts}-${state}.json`),
		`${JSON.stringify({ type: "steer-ack", protocolVersion: 1, requestId, index, ts, state, message: "ok" })}\n`,
		"utf-8",
	);
}

describe("steerSubagentRun", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("Queues a request file in the control inbox with the protocol convention", async () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const result = await steerSubagentRun({
			runId: "run-1",
			message: "wait рабо",
			mode: "steer",
			roots: [root],
			requestId: "web-fixed-1",
			ackCheckDelayMs: 0,
		});
		expect(result.delivered).toBe("queued");
		expect(result.requestId).toBe("web-fixed-1");
		expect(result.runDir).toBe(runDir);
		expect(existsSync(result.requestPath)).toBe(true);

		// File name convention: 13-digit zero-padded ts + base64url id + .json.
		const fileName = basename(result.requestPath);
		expect(fileName).toMatch(/^\d{13}-[\w-]+\.json$/);
		// base64url payloads may contain "-" themselves, so slice by offsets.
		const encodedId = fileName?.slice(14).replace(/\.json$/, "");
		expect(Buffer.from(String(encodedId), "base64url").toString("utf-8")).toBe("web-fixed-1");

		// Contents: the exact SteerRequest the runner validates.
		const written = JSON.parse(readFileSync(result.requestPath, "utf-8")) as Record<string, unknown>;
		expect(written.type).toBe("steer");
		expect(written.id).toBe("web-fixed-1");
		expect(typeof written.ts).toBe("number");
		expect(written.ts).toBeGreaterThan(0);
		expect(written.message).toBe("wait рабо");
		expect(written.mode).toBe("steer");
		expect(written.source).toBe("pi-web");
	}, 10_000);

	it("reports delivered when an ack record already answers the request", async () => {
		const runDir = makeRun(root, "run-1", runStatus());
		writeAck(runDir, "web-fixed-2", "delivered", 1234, "steered to child 0");
		const result = await steerSubagentRun({
			runId: "run-1",
			message: "go faster",
			roots: [root],
			requestId: "web-fixed-2",
			ackCheckDelayMs: 0,
		});
		expect(result.delivered).toBe("delivered");
		expect(result.ack?.state).toBe("delivered");
		expect(result.ack?.message).toBe("steered to child 0");
		expect(result.ack?.ts).toBe(1234);
	}, 10_000);

	it("refuses when the runner closed the steer inbox", async () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const control = controlInboxDir(runDir);
		mkdirSync(control, { recursive: true });
		writeFileSync(join(control, "steer-inbox-closed.json"), "{}\n", "utf-8");
		let caught: SubagentSteerError | undefined;
		try {
			await steerSubagentRun({ runId: "run-1", message: "hi", roots: [root], ackCheckDelayMs: 0 });
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("inbox-closed");
		// No request file leaked into a closed inbox.
		const requests = join(control, "steer-requests");
		expect(existsSync(requests)).toBe(false);
	}, 10_000);

	it("rejects message violations exactly at the protocol limits", async () => {
		makeRun(root, "run-1", runStatus());
		const blank = async () =>
			steerSubagentRun({ runId: "run-1", message: "   \n\t ", roots: [root], ackCheckDelayMs: 0 });
		await expect(blank).rejects.toThrowError(SubagentSteerError);

		const oversized = async () =>
			steerSubagentRun({ runId: "run-1", message: "x".repeat(128 * 1024 + 1), roots: [root], ackCheckDelayMs: 0 });
		await expect(oversized).rejects.toThrowError(SubagentSteerError);
		// At the protocol cap (exactly 128 KiB) the request must be accepted.
		await steerSubagentRun({ runId: "run-1", message: "x".repeat(128 * 1024), roots: [root], ackCheckDelayMs: 0 });
	}, 10_000);

	it("rejects an invalid delivery mode and an unknown run id", async () => {
		makeRun(root, "run-1", runStatus());
		const badMode = async () =>
			steerSubagentRun({ runId: "run-1", message: "m", mode: "urgent", roots: [root], ackCheckDelayMs: 0 });
		await expect(badMode).rejects.toThrowError(SubagentSteerError);

		const unknownRun = async () =>
			steerSubagentRun({ runId: "nope-123", message: "m", roots: [root], ackCheckDelayMs: 0 });
		await expect(unknownRun).rejects.toThrowError(SubagentSteerError);
	}, 10_000);

	it("rejects ids that could masquerade as paths (traversal guard)", async () => {
		const slash = async () =>
			steerSubagentRun({ runId: "../run-1", message: "m", roots: [root], ackCheckDelayMs: 0 });
		await expect(slash).rejects.toThrowError(SubagentSteerError);
		const backslash = async () =>
			steerSubagentRun({ runId: "a\\b", message: "m", roots: [root], ackCheckDelayMs: 0 });
		await expect(backslash).rejects.toThrowError(SubagentSteerError);
	}, 10_000);
});

describe("stopSubagentRun", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes the portable stop.json request", () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const result = stopSubagentRun({ runId: "run-1", reason: "owner asked", roots: [root] });
		expect(result.delivered).toBe("requested");
		expect(result.stopPath).toBe(join(controlInboxDir(runDir), "stop.json"));
		const written = JSON.parse(readFileSync(result.stopPath, "utf-8")) as Record<string, unknown>;
		expect(written.type).toBe("stop");
		expect(typeof written.ts).toBe("number");
		expect(written.source).toBe("pi-web");
		expect(written.reason).toBe("owner asked");
	}, 10_000);

	it("omits the reason field when none is given and trims whitespace-only reasons", () => {
		makeRun(root, "run-1", runStatus());
		const first = stopSubagentRun({ runId: "run-1", roots: [root] });
		const firstWritten = JSON.parse(readFileSync(first.stopPath, "utf-8")) as Record<string, unknown>;
		expect("reason" in firstWritten).toBe(false);

		const second = stopSubagentRun({ runId: "run-1", reason: "   ", roots: [root] });
		const secondWritten = JSON.parse(readFileSync(second.stopPath, "utf-8")) as Record<string, unknown>;
		expect("reason" in secondWritten).toBe(false);
	}, 10_000);

	it("fails for unknown runs without touching the filesystem", () => {
		const gone = () => stopSubagentRun({ runId: "ghost", roots: [root] });
		expect(gone).toThrowError(SubagentSteerError);
	}, 10_000);
});

describe("steerSubagentRun — workflow children", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("steers a live in-process child through its workflow-foreground route", async () => {
		const runDir = makeRun(
			root,
			"wf-live",
			workflowStatus([
				childStep({ runId: "child-poet", label: "poet", status: "running", lastActivityAt: 900 }),
				childStep({ runId: "child-critic", label: "critic", status: "running", lastActivityAt: 800 }),
			]),
		);
		const route = makeSyncRoute(runDir, "child-poet", 0);
		const result = await steerSubagentRun({
			runId: "wf-live",
			childId: "child-poet",
			message: "đi chậm lại",
			mode: "steer",
			roots: [root],
			requestId: "web-child-1",
			syncAckWaitMs: 60,
			syncAckPollMs: 5,
		});
		expect(result.delivered).toBe("queued");
		expect(result.childId).toBe("child-poet");
		expect(result.index).toBe(0);
		expect(result.requestPath.startsWith(join(route, "steer-targets", "0"))).toBe(true);
		const written = JSON.parse(readFileSync(result.requestPath, "utf-8")) as Record<string, unknown>;
		expect(written.type).toBe("steer");
		expect(written.id).toBe("web-child-1");
		expect(written.targetIndex).toBe(0);
		expect(written.message).toBe("đi chậm lại");
		expect(written.source).toBe("pi-web");
	}, 10_000);

	it("reports delivered when the child acks the route request mid-wait", async () => {
		const runDir = makeRun(root, "wf-live", workflowStatus([childStep({ runId: "child-a" })]));
		const route = makeSyncRoute(runDir, "child-a", 0);
		setTimeout(() => writeRouteAck(route, 0, "web-child-2", "delivered", 444), 15);
		const result = await steerSubagentRun({
			runId: "wf-live",
			childId: "child-a",
			message: "hello",
			roots: [root],
			requestId: "web-child-2",
			syncAckWaitMs: 2_000,
			syncAckPollMs: 5,
		});
		expect(result.delivered).toBe("delivered");
		expect(result.ack?.state).toBe("delivered");
		expect(result.ack?.ts).toBe(444);
	}, 10_000);

	it("fails honestly when the steering route vanishes mid-wait (child ended)", async () => {
		const runDir = makeRun(root, "wf-live", workflowStatus([childStep({ runId: "child-a" })]));
		const route = makeSyncRoute(runDir, "child-a", 0);
		setTimeout(() => rmSync(route, { recursive: true, force: true }), 15);
		let caught: SubagentSteerError | undefined;
		try {
			await steerSubagentRun({
				runId: "wf-live",
				childId: "child-a",
				message: "hello",
				roots: [root],
				requestId: "web-child-3",
				syncAckWaitMs: 2_000,
				syncAckPollMs: 5,
			});
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("child-not-live");
	}, 10_000);

	it("refuses a child that declared steering unsupported", async () => {
		const runDir = makeRun(root, "wf-live", workflowStatus([childStep({ runId: "child-a" })]));
		const route = makeSyncRoute(runDir, "child-a", 0);
		writeFileSync(
			join(route, "steer-capabilities", "0.json"),
			`${JSON.stringify({ type: "steer-capability", protocolVersion: 1, index: 0, pid: 9, readyAt: 1, supported: false })}\n`,
			"utf-8",
		);
		let caught: SubagentSteerError | undefined;
		try {
			await steerSubagentRun({
				runId: "wf-live",
				childId: "child-a",
				message: "hello",
				roots: [root],
				requestId: "web-child-4",
				syncAckWaitMs: 60,
				syncAckPollMs: 5,
			});
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("child-not-steerable");
		// No request file leaked into an unsupported route.
		expect(existsSync(join(route, "steer-targets", "0"))).toBe(true);
		expect(readdirSync(join(route, "steer-targets", "0"))).toHaveLength(0);
	}, 10_000);

	it("targets an async (detached) workflow child via the top-level inbox with targetIndex", async () => {
		const runDir = makeRun(
			root,
			"wf-async",
			workflowStatus([childStep({ runId: "c-one" }), childStep({ runId: "c-two", status: "running" })]),
		);
		const result = await steerSubagentRun({
			runId: "wf-async",
			childId: "c-two",
			message: "hey child two",
			roots: [root],
			requestId: "web-idx-1",
			ackCheckDelayMs: 0,
		});
		expect(result.index).toBe(1);
		expect(result.childId).toBe("c-two");
		expect(result.requestPath.startsWith(join(runDir, "control", "steer-requests"))).toBe(true);
		const written = JSON.parse(readFileSync(result.requestPath, "utf-8")) as Record<string, unknown>;
		expect(written.targetIndex).toBe(1);
		expect(written.id).toBe("web-idx-1");
	}, 10_000);

	it("rejects a child id the parent run does not know", async () => {
		makeRun(root, "wf-async", workflowStatus([childStep({ runId: "c-one" })]));
		let caught: SubagentSteerError | undefined;
		try {
			await steerSubagentRun({ runId: "wf-async", childId: "ghost", message: "x", roots: [root], requestId: "g-1" });
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("unknown-child");
	}, 10_000);

	it("refuses to write a dead letter into a finished run (honest whole-run steer)", async () => {
		makeRun(root, "done-run", runStatus({ state: "complete" }));
		let caught: SubagentSteerError | undefined;
		try {
			await steerSubagentRun({
				runId: "done-run",
				message: "hi",
				roots: [root],
				requestId: "late-1",
				ackCheckDelayMs: 0,
			});
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("not-running");
	}, 10_000);

	it("rejects child ids that could masquerade as paths (traversal guard)", async () => {
		makeRun(root, "wf-live", workflowStatus([childStep({ runId: "child-a" })]));
		const slash = async () => steerSubagentRun({ runId: "wf-live", childId: "../evil", message: "m", roots: [root] });
		await expect(slash).rejects.toThrowError(SubagentSteerError);
	}, 10_000);
});

describe("stopSubagentRun — workflow children", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("stops an async workflow child with targetIndex + childId in stop.json", () => {
		makeRun(root, "wf-async", workflowStatus([childStep({ runId: "c-one" }), childStep({ runId: "c-two" })]));
		const result = stopSubagentRun({ runId: "wf-async", childId: "c-two", reason: "owner asked", roots: [root] });
		expect(result.childId).toBe("c-two");
		expect(result.index).toBe(1);
		const written = JSON.parse(readFileSync(result.stopPath, "utf-8")) as Record<string, unknown>;
		expect(written.type).toBe("stop");
		expect(written.targetIndex).toBe(1);
		expect(written.childId).toBe("c-two");
		expect(written.reason).toBe("owner asked");
	}, 10_000);

	it("refuses to stop an in-process (sync) child — no file consumer exists", () => {
		const runDir = makeRun(root, "wf-sync", workflowStatus([childStep({ runId: "c-one" })]));
		makeSyncRoute(runDir, "c-one", 0);
		let caught: SubagentSteerError | undefined;
		try {
			stopSubagentRun({ runId: "wf-sync", childId: "c-one", roots: [root] });
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("sync-child-stop-unsupported");
		// No stop.json leaked for a stop nobody would consume.
		expect(existsSync(join(runDir, "control", "stop.json"))).toBe(false);
	}, 10_000);

	it("rejects child ids that could masquerade as paths (traversal guard)", () => {
		makeRun(root, "wf-async", workflowStatus([childStep({ runId: "c-one" })]));
		expect(() => stopSubagentRun({ runId: "wf-async", childId: "../evil", roots: [root] })).toThrowError(
			SubagentSteerError,
		);
	}, 10_000);
});

describe("subagent_status steering passthrough", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("passes the runner-written steering block through untouched", () => {
		// Same block shape a real runner wrote into status.json (verified on
		// /tmp/pi-subagents-uid-1000/async-subagent-runs/<runId>/status.json).
		const steering = {
			requested: 2,
			scheduled: 0,
			pending: 1,
			delivered: 1,
			failed: 0,
			recovered: 0,
			lastRequestedAt: 55,
			recent: [
				{
					id: "web-1",
					requestedAt: 55,
					source: "pi-web",
					messagePreview: "go faster",
					targets: [{ index: 0, state: "queued" }],
				},
			],
		};
		makeRun(root, "run-live", runStatus({ steering }));
		const { runs } = listSubagentRuns({ roots: [root] });
		const live = runs.find((run) => run.id === "run-live");
		expect(live?.steering).toEqual(steering);
	}, 10_000);

	it("omits steering when status.json has no steering block", () => {
		makeRun(root, "run-live", runStatus());
		makeRun(root, "run-done", runStatus({ state: "complete" }));
		// A malformed (non-object) steering block is dropped, not passed through.
		makeRun(root, "run-junk", runStatus({ steering: "nope" }));
		const { runs } = listSubagentRuns({ roots: [root] });
		expect(runs.find((run) => run.id === "run-live")?.steering).toBeUndefined();
		expect(runs.find((run) => run.id === "run-done")?.steering).toBeUndefined();
		expect(runs.find((run) => run.id === "run-junk")?.steering).toBeUndefined();
	}, 10_000);
});

describe("subagent_steer / subagent_stop web commands", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("answers steer requests with the queue result and errors as rpc failures", async () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;

		const response = (await handler(
			{ type: "subagent_steer", runId: "run-1", message: "hello", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean };
		expect(response.type).toBe("response");
		expect(response.command).toBe("subagent_steer");
		expect(response.success).toBe(true);

		const runDirProbe = join(runDir, "control", "steer-requests");
		expect(existsSync(runDirProbe)).toBe(true);

		const failure = (await handler(
			{ type: "subagent_steer", runId: "ghost", message: "hello", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { type: string; success: boolean };
		expect(failure.type).toBe("response");
		expect(failure.success).toBe(false);
	}, 20_000);

	it("answers stop requests with the written request confirmation", async () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler(
			{ type: "subagent_stop", runId: "run-1", reason: "done", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean };
		expect(response.type).toBe("response");
		expect(response.command).toBe("subagent_stop");
		expect(response.success).toBe(true);
		expect(existsSync(join(runDir, "control", "stop.json"))).toBe(true);
	}, 20_000);

	it("threads childId through steer to a live sync child's route inbox", async () => {
		const runDir = makeRun(root, "wf-live", workflowStatus([childStep({ runId: "child-a", label: "poet" })]));
		const route = makeSyncRoute(runDir, "child-a", 0);
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler(
			{ type: "subagent_steer", runId: "wf-live", childId: "child-a", message: "nhẹ thôi", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; data: { childId?: string; index?: number } };
		expect(response.success).toBe(true);
		expect(response.data.childId).toBe("child-a");
		expect(response.data.index).toBe(0);
		const requests = readdirSync(join(route, "steer-targets", "0"));
		expect(requests).toHaveLength(1);
	}, 20_000);

	it("validates childId/index types on the command boundary", async () => {
		makeRun(root, "wf-live", workflowStatus([childStep({ runId: "child-a" })]));
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const badChild = (await handler(
			{ type: "subagent_steer", runId: "wf-live", childId: 42, message: "x", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(badChild.success).toBe(false);
		expect(badChild.error).toBe("childId must be a string");

		const badIndex = (await handler(
			{
				type: "subagent_steer",
				runId: "wf-live",
				childId: "child-a",
				index: "zero",
				message: "x",
				roots: [root],
			} as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(badIndex.success).toBe(false);
		expect(badIndex.error).toBe("index must be an integer");

		const badStopChild = (await handler(
			{ type: "subagent_stop", runId: "wf-live", childId: "../evil", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(badStopChild.success).toBe(false);
	}, 20_000);

	it("threads childId through stop and refuses in-process children honestly", async () => {
		const runDir = makeRun(root, "wf-sync", workflowStatus([childStep({ runId: "child-a" })]));
		makeSyncRoute(runDir, "child-a", 0);
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler(
			{ type: "subagent_stop", runId: "wf-sync", childId: "child-a", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(response.success).toBe(false);
		expect(response.error).toContain("in-process");
	}, 20_000);
});
