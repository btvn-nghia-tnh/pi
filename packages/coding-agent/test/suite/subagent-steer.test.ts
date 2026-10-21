/**
 * subagent_steer / subagent_stop + subagent_status steer enrichment (batch-4).
 *
 * Fixtures follow R10: every control-inbox file asserted against is written by
 * the code under test (or by these tests in the documented runner shapes) and
 * read back from disk — no hand-copied expected payloads.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("steerSubagentRun", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("Queues a request file in the control inbox with the protocol convention", () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const result = steerSubagentRun({
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

	it("reports delivered when an ack record already answers the request", () => {
		const runDir = makeRun(root, "run-1", runStatus());
		writeAck(runDir, "web-fixed-2", "delivered", 1234, "steered to child 0");
		const result = steerSubagentRun({
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

	it("refuses when the runner closed the steer inbox", () => {
		const runDir = makeRun(root, "run-1", runStatus());
		const control = controlInboxDir(runDir);
		mkdirSync(control, { recursive: true });
		writeFileSync(join(control, "steer-inbox-closed.json"), "{}\n", "utf-8");
		let caught: SubagentSteerError | undefined;
		try {
			steerSubagentRun({ runId: "run-1", message: "hi", roots: [root], ackCheckDelayMs: 0 });
		} catch (error) {
			caught = error as SubagentSteerError;
		}
		expect(caught).toBeInstanceOf(SubagentSteerError);
		expect(caught?.reason).toBe("inbox-closed");
		// No request file leaked into a closed inbox.
		const requests = join(control, "steer-requests");
		expect(existsSync(requests)).toBe(false);
	}, 10_000);

	it("rejects message violations exactly at the protocol limits", () => {
		makeRun(root, "run-1", runStatus());
		const blank = () => steerSubagentRun({ runId: "run-1", message: "   \n\t ", roots: [root], ackCheckDelayMs: 0 });
		expect(blank).toThrowError(SubagentSteerError);

		const oversized = () =>
			steerSubagentRun({ runId: "run-1", message: "x".repeat(128 * 1024 + 1), roots: [root], ackCheckDelayMs: 0 });
		expect(oversized).toThrowError(SubagentSteerError);
		// At the protocol cap (exactly 128 KiB) the request must be accepted.
		expect(() =>
			steerSubagentRun({ runId: "run-1", message: "x".repeat(128 * 1024), roots: [root], ackCheckDelayMs: 0 }),
		).not.toThrow();
	}, 10_000);

	it("rejects an invalid delivery mode and an unknown run id", () => {
		makeRun(root, "run-1", runStatus());
		const badMode = () =>
			steerSubagentRun({ runId: "run-1", message: "m", mode: "urgent", roots: [root], ackCheckDelayMs: 0 });
		expect(badMode).toThrowError(SubagentSteerError);

		const unknownRun = () => steerSubagentRun({ runId: "nope-123", message: "m", roots: [root], ackCheckDelayMs: 0 });
		expect(unknownRun).toThrowError(SubagentSteerError);
	}, 10_000);

	it("rejects ids that could masquerade as paths (traversal guard)", () => {
		const slash = () => steerSubagentRun({ runId: "../run-1", message: "m", roots: [root], ackCheckDelayMs: 0 });
		expect(slash).toThrowError(SubagentSteerError);
		const backslash = () => steerSubagentRun({ runId: "a\\b", message: "m", roots: [root], ackCheckDelayMs: 0 });
		expect(backslash).toThrowError(SubagentSteerError);
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
});
