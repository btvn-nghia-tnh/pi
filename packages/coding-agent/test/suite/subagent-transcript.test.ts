import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import {
	readSubagentTranscript,
	SubagentTranscriptError,
	type SubagentTranscriptResult,
} from "../../src/modes/web/subagent-transcript.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(
		tmpdir(),
		`pi-subagent-transcript-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface RunFixture {
	status?: unknown;
	/** events.jsonl lines; objects are JSON.stringified, strings written raw. */
	events?: Array<Record<string, unknown> | string>;
}

/** Materialize one fixture run directory in the discovered on-disk format. */
function makeRun(root: string, id: string, fixture: RunFixture = {}): string {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	if (fixture.status !== undefined) {
		writeFileSync(join(dir, "status.json"), `${JSON.stringify(fixture.status, null, 2)}\n`, "utf-8");
	}
	if (fixture.events !== undefined) {
		const lines = fixture.events.map((event) => (typeof event === "string" ? event : JSON.stringify(event)));
		writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf-8");
	}
	return dir;
}

function runStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		lifecycleArtifactVersion: 3,
		runId: "test",
		mode: "single",
		state: "running",
		sessionId: "/sessions/master.jsonl",
		startedAt: 1000,
		lastActivityAt: 1500,
		lastUpdate: 1500,
		currentStep: 0,
		steps: [],
		...overrides,
	};
}

function userEnd(text: string): Record<string, unknown> {
	return { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEnd(content: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "message_end",
		message: { role: "assistant", content, responseId: "resp-1", model: "test/model", ...extra },
	};
}

function toolStart(toolCallId: string, toolName: string, args: unknown): Record<string, unknown> {
	return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolEnd(toolCallId: string, text: string, isError = false): Record<string, unknown> {
	return { type: "tool_execution_end", toolCallId, result: { content: [{ type: "text", text }] }, isError };
}

describe("readSubagentTranscript", () => {
	let root: string;

	beforeEach(() => {
		root = tempRoot("runs");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("projects user + assistant + tool execution into ordered chat items", () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				{ type: "subagent.run.started", ts: 1, runId: "run-1" },
				userEnd("do the thing"),
				assistantEnd([
					{ type: "thinking", thinking: "let me read first" },
					{ type: "text", text: "Reading the file:" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				]),
				toolStart("call-1", "read", { path: "a.ts" }),
				toolEnd("call-1", "file body"),
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.runId).toBe("run-1");
		expect(result.dir).toBe(join(root, "run-1"));
		expect(result.state).toBe("running");
		expect(result.sessionFile).toBe("/sessions/master.jsonl");
		expect(result.lineCount).toBe(5);
		expect(result.truncated).toBe(false);
		expect(result.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		expect(result.items[0].id).toBe("u-1");
		expect((result.items[0].message as { content: Array<{ text: string }> }).content[0].text).toBe("do the thing");
		const assistant = result.items[1];
		expect(assistant.id).toBe("a-resp-1");
		expect(assistant.toolCards).toHaveLength(1);
		const card = assistant.toolCards[0];
		expect(card.toolCallId).toBe("call-1");
		expect(card.toolName).toBe("read");
		expect(card.isError).toBe(false);
		expect(card.running).toBe(false);
		expect((card.result as { content: Array<{ text: string }> }).content[0].text).toBe("file body");
	});

	it("resolves a tool card from a toolResult message_end (and wins over execution_end)", () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				userEnd("t"),
				assistantEnd([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }]),
				toolStart("call-1", "bash", { command: "ls" }),
				toolEnd("call-1", "from-exec"),
				{
					type: "message_end",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "bash",
						content: [{ type: "text", text: "from-message" }],
						isError: true,
					},
				},
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		const card = result.items[1].toolCards[0];
		expect(card.isError).toBe(true);
		expect(card.running).toBe(false);
		expect((card.result as { content: Array<{ text: string }> }).content[0].text).toBe("from-message");
	});

	it("falls back to a toolResult message_start when no message_end exists", () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				userEnd("t"),
				assistantEnd([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
				toolStart("call-1", "read", {}),
				{
					type: "message_start",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "partial" }],
					},
				},
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		const card = result.items[1].toolCards[0];
		expect(card.running).toBe(false);
		expect((card.result as { content: Array<{ text: string }> }).content[0].text).toBe("partial");
	});

	it("keeps a tool card running while its execution has not ended", () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				userEnd("t"),
				assistantEnd([{ type: "toolCall", id: "call-1", name: "sleep", arguments: {} }]),
				toolStart("call-1", "sleep", {}),
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		const card = result.items[1].toolCards[0];
		expect(card.running).toBe(true);
		expect(card.result).toBeUndefined();
	});

	it("clips oversized assistant text and marks truncated", () => {
		const long = "x".repeat(7000);
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [userEnd("t"), assistantEnd([{ type: "text", text: long }])],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.truncated).toBe(true);
		const text = (result.items[1].message as { content: Array<{ text: string }> }).content[0].text;
		expect(text.length).toBeLessThan(long.length);
		expect(text.endsWith("… [truncated]")).toBe(true);
	});

	it("clips oversized tool results", () => {
		const long = "y".repeat(5000);
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				userEnd("t"),
				assistantEnd([{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]),
				toolStart("call-1", "bash", {}),
				toolEnd("call-1", long),
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.truncated).toBe(true);
		const text = (result.items[1].toolCards[0].result as { content: Array<{ text: string }> }).content[0].text;
		expect(text.endsWith("… [truncated]")).toBe(true);
		expect(text.length).toBeLessThan(long.length);
	});

	it("clips oversized tool-call argument strings", () => {
		const long = "z".repeat(4000);
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				userEnd("t"),
				assistantEnd([
					{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.ts", content: long } },
				]),
				toolStart("call-1", "write", { path: "a.ts", content: long }),
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.truncated).toBe(true);
		const args = result.items[1].toolCards[0].args as { content: string };
		expect(args.content.endsWith("… [truncated]")).toBe(true);
	});

	it("skips junk lines without failing", () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: ["{ not json", userEnd("survives"), "[1,2,3]", assistantEnd([{ type: "text", text: "ok" }])],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.lineCount).toBe(2);
		expect(result.items).toHaveLength(2);
	});

	it("answers with an empty transcript when events.jsonl is missing", () => {
		makeRun(root, "run-1", { status: runStatus({ state: "complete" }) });
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.items).toEqual([]);
		expect(result.lineCount).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.state).toBe("complete");
	});

	it("caps items at 400 and marks truncated", () => {
		const events: Array<Record<string, unknown>> = [userEnd("first")];
		for (let i = 0; i < 420; i += 1) {
			events.push(assistantEnd([{ type: "text", text: `turn ${i}` }]));
		}
		makeRun(root, "run-1", { status: runStatus(), events });
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.items).toHaveLength(400);
		expect(result.truncated).toBe(true);
		// Oldest kept: the prompt bubble stays first.
		expect(result.items[0].kind).toBe("user");
	});

	it("rejects an invalid runId", () => {
		expect(() => readSubagentTranscript({ runId: "../evil", roots: [root] })).toThrowError(SubagentTranscriptError);
		try {
			readSubagentTranscript({ runId: "", roots: [root] });
		} catch (error) {
			expect((error as SubagentTranscriptError).code).toBe("invalid-run-id");
		}
	});

	it("reports unknown runs", () => {
		try {
			readSubagentTranscript({ runId: "missing-run", roots: [root] });
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SubagentTranscriptError);
			expect((error as SubagentTranscriptError).code).toBe("unknown-run");
		}
	});

	it("falls back to the first user message_start when no message_end:user exists", () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [
				{
					type: "message_start",
					message: { role: "user", content: [{ type: "text", text: "the master's task" }] },
				},
				assistantEnd([{ type: "text", text: "done" }]),
			],
		});
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		const prompt = (result.items[0].message as { content: Array<{ text: string }> }).content[0].text;
		expect(prompt).toBe("the master's task");
	});

	it("projects per-step session files for chain/workflow runs (no message events)", () => {
		const sessionDir = join(root, "step-sessions");
		mkdirSync(sessionDir, { recursive: true });
		const stepFile = join(sessionDir, "step-0.jsonl");
		const stepEntries = [
			{ type: "session", version: 3, id: "s-1" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "review task 2" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "checking" },
						{ type: "toolCall", id: "call-9", name: "read", arguments: { path: "x.ts" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-9",
					toolName: "read",
					content: [{ type: "text", text: "body" }],
				},
			},
		];
		writeFileSync(stepFile, `${stepEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
		makeRun(root, "run-workflow", {
			status: runStatus({ mode: "workflow", steps: [{ agent: "reviewer", sessionFile: stepFile }] }),
			events: [{ type: "subagent.workflow.started", ts: 1 }],
		});
		const result = readSubagentTranscript({ runId: "run-workflow", roots: [root] });
		expect(result.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		const card = result.items[1].toolCards[0];
		expect(card.toolCallId).toBe("call-9");
		expect(card.running).toBe(false);
		expect((card.result as { content: Array<{ text: string }> }).content[0].text).toBe("body");
	});

	it("stops at the payload budget and marks truncated", () => {
		const events: Array<Record<string, unknown>> = [userEnd("start")];
		// ~6 KB of text per message after the 6000-char clip; 120 of them exceed
		// the 512 KB payload budget, so later items must be dropped.
		const chunk = "q".repeat(6000);
		for (let i = 0; i < 120; i += 1) {
			events.push(assistantEnd([{ type: "text", text: chunk }], { responseId: `resp-${i}` }));
		}
		makeRun(root, "run-1", { status: runStatus(), events });
		const result = readSubagentTranscript({ runId: "run-1", roots: [root] });
		expect(result.truncated).toBe(true);
		expect(result.items.length).toBeLessThan(121);
		const bytes = Buffer.byteLength(JSON.stringify(result.items), "utf-8");
		expect(bytes).toBeLessThan(700 * 1024);
	});
});

describe("subagent_transcript web command", () => {
	const handler = createWebCommandHandler();
	const core = {
		getSession: () => ({ sessionManager: { getCwd: () => process.cwd() } }),
		getRuntime: () => ({}),
	} as never;

	let root: string;
	beforeEach(() => {
		root = tempRoot("cmd");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns the projected transcript", async () => {
		makeRun(root, "run-1", {
			status: runStatus(),
			events: [userEnd("hello"), assistantEnd([{ type: "text", text: "hi" }])],
		});
		const response = (await handler(
			{ type: "subagent_transcript", runId: "run-1", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; data: SubagentTranscriptResult };
		expect(response.type).toBe("response");
		expect(response.command).toBe("subagent_transcript");
		expect(response.success).toBe(true);
		expect(response.data.items).toHaveLength(2);
		expect(response.data.items[0].kind).toBe("user");
	});

	it("answers an rpc error for an unknown run", async () => {
		const response = (await handler(
			{ type: "subagent_transcript", runId: "missing-run", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(response.success).toBe(false);
		expect(response.error).toContain("No pi-subagents run found");
	});

	it("answers an rpc error for an invalid runId", async () => {
		const response = (await handler(
			{ type: "subagent_transcript", runId: "../evil", roots: [root] } as never,
			core as unknown as RpcCore,
		)) as { success: boolean; error?: string };
		expect(response.success).toBe(false);
		expect(response.error).toContain("run directory name");
	});
});
