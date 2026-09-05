import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/state.ts";

test("applyConnected seeds items from messages", () => {
	const store = new Store();
	store.applyConnected({
		type: "connected",
		version: "1.0.0",
		state: {
			model: { id: "m1", provider: "p" },
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionId: "s1",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		],
	});

	const state = store.getState();
	assert.equal(state.connected, true);
	assert.equal(state.version, "1.0.0");
	assert.equal(state.items.length, 2);
	assert.equal(state.items[0]!.kind, "user");
	assert.equal(state.items[1]!.kind, "assistant");
});

test("message_start and message_update assemble a streaming assistant message", () => {
	const store = new Store();
	store.applyConnected({ type: "connected", version: "1", messages: [] });

	store.applyAgentEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
	});
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
	});
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
	});
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "thinking hard" },
	});

	let state = store.getState();
	const streaming = state.items[0]!;
	assert.equal(streaming.kind, "assistant");
	assert.equal(streaming.streaming, true);
	const content = (streaming.message as { content: Array<Record<string, unknown>> }).content;
	assert.equal(content[0]!.text, "Hello world");
	assert.equal(content[1]!.thinking, "thinking hard");

	store.applyAgentEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "final" }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
			timestamp: 1,
		},
	});
	state = store.getState();
	const finished = state.items[0]!;
	assert.equal(finished.streaming, false);
	assert.deepEqual((finished.message as { content: Array<Record<string, unknown>> }).content[0]!.text, "final");
	assert.equal(state.footerUsage.input, 10);
	assert.equal(state.footerUsage.output, 5);
});

test("tool events attach to tool cards", () => {
	const store = new Store();
	store.applyConnected({ type: "connected", version: "1", messages: [] });
	store.applyAgentEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
	});
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' },
	});
	store.applyAgentEvent({
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "bash",
		args: { command: "ls" },
	});

	let state = store.getState();
	let card = state.items[0]!.toolCards.get("call_1");
	assert.ok(card);
	assert.equal(card!.toolName, "bash");
	assert.equal(card!.result, undefined);

	store.applyAgentEvent({
		type: "tool_execution_update",
		toolCallId: "call_1",
		partialResult: { content: [{ type: "text", text: "partial" }] },
	});
	state = store.getState();
	card = state.items[0]!.toolCards.get("call_1");
	assert.ok(card!.partialResult);

	store.applyAgentEvent({
		type: "tool_execution_end",
		toolCallId: "call_1",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	state = store.getState();
	card = state.items[0]!.toolCards.get("call_1");
	assert.equal((card!.result as { content: Array<{ text: string }> }).content[0]!.text, "done");
	assert.equal(card!.isError, false);
});

test("queue_update sets the queue", () => {
	const store = new Store();
	store.applyAgentEvent({ type: "queue_update", steering: ["a"], followUp: ["b"] });
	assert.deepEqual(store.getState().queue, { steering: ["a"], followUp: ["b"] });
});

test("compaction events produce a summary item and clear the indicator", () => {
	const store = new Store();
	store.applyAgentEvent({ type: "compaction_start", reason: "threshold" });
	assert.ok(store.getState().compaction);
	store.applyAgentEvent({
		type: "compaction_end",
		reason: "threshold",
		result: { summary: "Summarized!" },
		aborted: false,
	});
	const state = store.getState();
	assert.equal(state.compaction, undefined);
	const summary = state.items.find((item) => item.kind === "compaction");
	assert.ok(summary);
	assert.equal(summary!.notice!.text, "Summarized!");
});

test("retry events set and clear retry state", () => {
	const store = new Store();
	store.applyAgentEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "boom" });
	const retry = store.getState().retry;
	assert.ok(retry);
	assert.equal(retry!.attempt, 1);
	assert.ok(retry!.until > Date.now() - 1000);
	store.applyAgentEvent({ type: "auto_retry_end", success: true, attempt: 2 });
	assert.equal(store.getState().retry, undefined);
});

test("toggle tools and thinking", () => {
	const store = new Store();
	store.applyConnected({ type: "connected", version: "1", messages: [] });
	store.applyAgentEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
	store.applyAgentEvent({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { id: "c1", name: "read", arguments: {} },
		},
	});

	store.setToolsExpanded(true);
	assert.equal(store.getState().toolsExpanded, true);
	assert.equal(store.getState().items[0]!.toolCards.get("c1")!.expanded, true);

	store.setToolsExpanded(false);
	store.toggleToolCard("c1");
	assert.equal(store.getState().items[0]!.toolCards.get("c1")!.expanded, true);

	assert.equal(store.getState().thinkingVisible, false); // collapsed by default
	store.toggleThinkingVisible();
	assert.equal(store.getState().thinkingVisible, true); // Alt+T expands all
});

test("extension statuses, widgets, notifications, working indicator", () => {
	const store = new Store();
	store.setExtensionStatus("ext", "running");
	assert.equal(store.getState().extensionStatuses.get("ext"), "running");
	store.setExtensionStatus("ext", undefined);
	assert.equal(store.getState().extensionStatuses.has("ext"), false);

	store.setWidget("w", ["line"], "aboveEditor");
	assert.deepEqual(store.getState().widgets.get("w"), { lines: ["line"], placement: "aboveEditor", data: undefined });
	store.setWidgetData("w", { kind: "rpiv-todo", tasks: [] });
	assert.deepEqual(store.getState().widgets.get("w"), {
		lines: ["line"],
		placement: "aboveEditor",
		data: { kind: "rpiv-todo", tasks: [] },
	});
	store.setWidgetData("w", undefined);
	assert.deepEqual(store.getState().widgets.get("w"), { lines: ["line"], placement: "aboveEditor", data: undefined });
	store.setWidget("w", undefined, "aboveEditor");
	assert.equal(store.getState().widgets.has("w"), false);
	store.setWidgetData("orphan", { kind: "x" });
	assert.deepEqual(store.getState().widgets.get("orphan"), {
		lines: [],
		placement: "aboveEditor",
		data: { kind: "x" },
	});

	store.pushNotification("oops", "error");
	assert.equal(store.getState().notifications.length, 1);
	store.dismissNotification(store.getState().notifications[0]!.id);
	assert.equal(store.getState().notifications.length, 0);

	store.setWorkingIndicator(["a", "b"], 50);
	assert.deepEqual(store.getState().workingIndicator, { frames: ["a", "b"], intervalMs: 50 });
	store.setWorkingIndicator(undefined, undefined);
	assert.equal(store.getState().workingIndicator, undefined);
});

test("applyConnected without a widgets field preserves current widgets", () => {
	const store = new Store();
	store.applyConnected({ type: "connected", version: "1", messages: [] });
	store.setWidget("w", ["line"], "aboveEditor");
	store.setWidgetData("w", { kind: "rpiv-todo", tasks: [] });
	store.setExtensionStatus("ext", "running");

	// Minimal payload (as sent by syncAfterSessionSwitch): no widgets/statuses.
	store.applyConnected({ type: "connected", version: "1", messages: [{ role: "user", content: "x", timestamp: 1 }] });
	const state = store.getState();
	assert.deepEqual(state.widgets.get("w"), {
		lines: ["line"],
		placement: "aboveEditor",
		data: { kind: "rpiv-todo", tasks: [] },
	});
	assert.equal(state.extensionStatuses.get("ext"), "running");

	// A full payload with an empty widgets array clears them.
	store.applyConnected({ type: "connected", version: "1", messages: [], widgets: [], statuses: [] });
	assert.equal(store.getState().widgets.size, 0);
	assert.equal(store.getState().extensionStatuses.size, 0);
});

test("applyConnected pairs toolResult messages with tool cards", () => {
	const store = new Store();
	store.applyConnected({
		type: "connected",
		version: "1",
		messages: [
			{ role: "user", content: "edit this", timestamp: 1 },
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "toolCall", id: "call_1", name: "edit", arguments: { path: "/f" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				details: { diff: "-1 old\n+1 new" },
				isError: false,
				timestamp: 3,
			},
		] as never,
	});
	const state = store.getState();
	// toolResult must NOT create its own transcript item...
	assert.equal(state.items.length, 2);
	// ...but its data must land on the edit tool card.
	const card = state.items[1]!.toolCards.get("call_1");
	assert.ok(card);
	assert.equal((card!.result as { details?: { diff?: string } }).details?.diff, "-1 old\n+1 new");
	assert.equal(card!.isError, false);
});

test("widget collapse state toggles per key", () => {
	const store = new Store();
	assert.equal(store.isWidgetCollapsed("rpiv-todos"), false);
	store.toggleWidgetCollapsed("rpiv-todos");
	assert.equal(store.isWidgetCollapsed("rpiv-todos"), true);
	assert.equal(store.isWidgetCollapsed("other-widget"), false);
	store.toggleWidgetCollapsed("rpiv-todos");
	assert.equal(store.isWidgetCollapsed("rpiv-todos"), false);
});

test("markDisconnected clears transient state", () => {
	const store = new Store();
	store.applyConnected({ type: "connected", version: "1", messages: [] });
	store.applyAgentEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: "x" });
	store.markDisconnected();
	const state = store.getState();
	assert.equal(state.connected, false);
	assert.equal(state.retry, undefined);
});

test("streaming updates keep the widgets map identity (render memoization)", () => {
	const store = new Store();
	store.setWidget("rpiv-todos", ["Todos (0/1)"], "aboveEditor");
	const widgetsBefore = store.getState().widgets;

	// A streaming assistant message fires many updates; none may replace the
	// widgets map, or the docked widget area would rebuild (and jitter) on
	// every chunk.
	store.applyAgentEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
	store.applyAgentEvent({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "chunk" }], timestamp: 1 },
	});
	assert.equal(store.getState().widgets, widgetsBefore);

	store.setWidget("rpiv-todos", ["Todos (1/1)"], "aboveEditor");
	assert.notEqual(store.getState().widgets, widgetsBefore);
});
