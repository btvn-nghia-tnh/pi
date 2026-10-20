import assert from "node:assert/strict";
import test from "node:test";
import { filterModels, primaryButtonState } from "../src/components/editor-toolbar.ts";

const models = [
	{ provider: "anthropic", id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, authenticated: true },
	{ provider: "openai", id: "gpt-5.2-codex", name: "GPT-5.2 Codex", reasoning: true, authenticated: false },
	{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: false, authenticated: true },
] as never;

test("filterModels matches id, name, and provider, case-insensitive", () => {
	assert.deepEqual(
		filterModels(models, "sonnet").map((m) => m.id),
		["claude-sonnet-4.5"],
	);
	assert.deepEqual(
		filterModels(models, "GPT").map((m) => m.id),
		["gpt-5.2-codex"],
	);
	assert.deepEqual(
		filterModels(models, "anthropic").map((m) => m.id),
		["claude-sonnet-4.5"],
	);
	assert.deepEqual(filterModels(models, "zil"), []);
	assert.equal(filterModels(models, "").length, 3);
	assert.deepEqual(filterModels(models, "   ").length, 3);
});

test("filterModels is stable — keeps input order for empty queries", () => {
	const ids = filterModels(models, "").map((m) => m.id);
	assert.deepEqual(ids, ["claude-sonnet-4.5", "gpt-5.2-codex", "gemini-3-pro"]);
});

test("primaryButtonState follows the spec table (§5)", () => {
	assert.deepEqual(
		primaryButtonState({ isStreaming: false, isCompacting: false, retryActive: false, streaming: false }),
		{ label: "Send", kind: "send", tone: "primary" },
	);
	assert.deepEqual(
		primaryButtonState({ isStreaming: true, isCompacting: false, retryActive: false, streaming: true }),
		{ label: "Stop", kind: "stop", tone: "danger" },
	);
	assert.deepEqual(
		primaryButtonState({ isStreaming: false, isCompacting: true, retryActive: false, streaming: true }),
		{ label: "Stop", kind: "stop", tone: "danger" },
	);
	assert.deepEqual(
		primaryButtonState({ isStreaming: false, isCompacting: false, retryActive: true, streaming: true }),
		{ label: "Stop", kind: "stop", tone: "danger" },
	);
	assert.deepEqual(
		primaryButtonState({ isStreaming: false, isCompacting: false, retryActive: false, streaming: true }),
		{ label: "Stop", kind: "stop", tone: "danger" },
	);
});
