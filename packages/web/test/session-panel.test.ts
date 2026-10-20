import assert from "node:assert/strict";
import test from "node:test";
import { panelCards } from "../src/components/session-panel.ts";

test("panelCards includes details and ext-statuses when data exists", () => {
	const cards = panelCards({
		sessionState: { model: { id: "x" } },
		contextInfo: { cwd: "/x" },
		extensionStatuses: new Map([["mcp", "🔌 MCP: 3 servers enabled"]]),
	} as never);
	assert.deepEqual(cards, [
		{ title: "Session details", kind: "details" },
		{ title: "Extension statuses", kind: "ext-statuses" },
	]);
	const bare = panelCards({ sessionState: undefined, contextInfo: undefined, extensionStatuses: new Map() } as never);
	assert.deepEqual(bare, [{ title: "Session details", kind: "details" }]);
});

test("ext-statuses card requires at least one sanitizable status", () => {
	const whitespaceOnly = panelCards({
		sessionState: undefined,
		contextInfo: undefined,
		extensionStatuses: new Map([["quiet", "   \u001b[0m  "]]),
	} as never);
	assert.deepEqual(whitespaceOnly, [{ title: "Session details", kind: "details" }]);
});
