import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_TYPE_LABELS, customMessageBody, customMessageDetailsText } from "../src/render/messages.ts";

test("customMessageBody returns the markdown string content", () => {
	const body = customMessageBody({ content: "**From alice** (~/proj)\n\nhello there" });
	assert.equal(body, "**From alice** (~/proj)\n\nhello there");
});

test("customMessageBody joins text blocks from an array content", () => {
	const body = customMessageBody({
		content: [
			{ type: "text", text: "block one " },
			{ type: "text", text: "block two" },
		],
	});
	assert.equal(body, "block one block two");
});

test("customMessageBody ignores non-text blocks in an array content", () => {
	const body = customMessageBody({
		content: [
			{ type: "image", data: "abc" },
			{ type: "text", text: "only text" },
		],
	});
	assert.equal(body, "only text");
});

test("customMessageBody returns null for empty or missing content", () => {
	assert.equal(customMessageBody({ content: "" }), null);
	assert.equal(customMessageBody({ content: "   " }), null);
	assert.equal(customMessageBody({ content: [] }), null);
	assert.equal(customMessageBody({}), null);
	assert.equal(customMessageBody({ content: null }), null);
});

test("customMessageDetailsText serializes objects as JSON", () => {
	const text = customMessageDetailsText({ from: { id: "abc" }, note: "x" });
	assert.match(text, /"from"/);
	assert.match(text, /"abc"/);
});

test("customMessageDetailsText passes strings through", () => {
	assert.equal(customMessageDetailsText("raw string"), "raw string");
});

test("customMessageDetailsText handles null details", () => {
	assert.equal(customMessageDetailsText(null), "null");
});

test("customMessageDetailsText handles circular references without throwing", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const text = customMessageDetailsText(circular);
	assert.equal(typeof text, "string");
});

test("label map covers the known intercom and subagent types", () => {
	const expected: Record<string, string> = {
		intercom_message: "Intercom",
		subagent_control_notice: "Subagent",
		subagent_steering_notice: "Steering",
		"subagent-slash-result": "Subagent result",
		"subagent-slash-text-result": "Subagent result",
		subagent_supervisor_request: "Subagent supervisor",
		"subagent-compaction-resume": "Subagent compaction",
	};
	for (const [key, label] of Object.entries(expected)) {
		assert.equal(CUSTOM_TYPE_LABELS[key], label, `label for ${key}`);
	}
});
