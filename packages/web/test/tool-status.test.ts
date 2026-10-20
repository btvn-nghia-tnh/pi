import assert from "node:assert/strict";
import test from "node:test";
import { toolStatusDescriptor } from "../src/components/tool-status.ts";

const now = 1_000_000;

test("running bash shows seconds and can stop", () => {
	const d = toolStatusDescriptor({ toolName: "bash", running: true, startedAt: now - 12_000 } as never, now);
	assert.deepEqual(d, { label: "running 12s", tone: "warn", running: true, canStop: true });
});

test("running non-bash tools cannot stop", () => {
	const d = toolStatusDescriptor({ toolName: "read", running: true, startedAt: now - 3_000 } as never, now);
	assert.deepEqual(d.canStop, false);
	assert.equal(d.label, "running 3s");
});

test("completed ok and error states", () => {
	assert.deepEqual(
		toolStatusDescriptor(
			{ toolName: "bash", running: false, startedAt: now - 1200, endedAt: now, isError: false } as never,
			now,
		),
		{ label: "✓ 1s", tone: "ok", running: false, canStop: false },
	);
	assert.equal(toolStatusDescriptor({ toolName: "bash", running: false, isError: true } as never, now).tone, "danger");
});

test("rehydrated cards without timing degrade to a muted check", () => {
	const card = {
		toolCallId: "c1",
		toolName: "bash",
		args: { command: "ls" },
		partialResult: undefined,
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
		expanded: false,
	};
	const d = toolStatusDescriptor(card, now);
	assert.deepEqual(d, { label: "✓", tone: "muted", running: false, canStop: false });
});
