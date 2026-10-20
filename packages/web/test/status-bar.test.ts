import assert from "node:assert/strict";
import test from "node:test";
import { statusBarProjector } from "../src/components/status-bar.ts";

const baseState = {
	sessionState: {
		model: { id: "anthropic/claude-sonnet-4.5", name: "sonnet-4.5", contextWindow: 200000 },
		thinkingLevel: "medium",
		sessionName: "pi-web-ui-redesign",
		autoCompactionEnabled: true,
		isStreaming: false,
	},
	contextInfo: {
		cwd: "/home/nghiatnh/projects/pi",
		gitBranch: "main",
		agentDir: "/home/nghiatnh/.pi/agent",
	},
	contextUsage: { tokens: 90000, contextWindow: 200000, percent: 45 },
	extensionStatuses: new Map([
		["build", "\u001b[38;2mⓂ build\u001b[39m"],
		["mcp", "\u001b[38;2m🔌 MCP: 3 servers enabled\u001b[39m"],
	]),
	footerUsage: { input: 312000, output: 88000, cacheRead: 880000, cacheWrite: 0, cost: 1.284 },
	latestUsage: {
		input: 1200,
		output: 0,
		cacheRead: 6300,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
} as never as Parameters<typeof statusBarProjector>[0];

test("statusBarProjector derives all spec groups", () => {
	const parts = statusBarProjector(baseState);
	assert.equal(parts.cwdText, "~/projects/pi");
	assert.equal(parts.branch, "main");
	assert.equal(parts.sessionName, "pi-web-ui-redesign");
	assert.deepEqual(parts.context, { percent: 45, window: 200000, auto: true });
	assert.equal(parts.rightText, "$1.28 · ↑312k ↓88k · R 84%");
	assert.equal(parts.modelText, "sonnet-4.5 · medium");
	assert.deepEqual(
		parts.statuses.map((s) => s.tone),
		["neutral", "info"],
	);
	assert.deepEqual(
		parts.statuses.map((s) => s.text),
		["Ⓜ build", "🔌 MCP: 3 servers enabled"],
	);
});

test("model text falls back to no-model", () => {
	const bare = { ...baseState, sessionState: { model: undefined, thinkingLevel: undefined } } as never;
	const parts = statusBarProjector(bare as never as Parameters<typeof statusBarProjector>[0]);
	assert.equal(parts.modelText, "no-model");
});
