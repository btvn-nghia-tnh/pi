import assert from "node:assert/strict";
import test from "node:test";
import { PreviewStore } from "../src/preview-store.ts";

test("open creates a loading tab and returns its id", () => {
	const store = new PreviewStore();
	const id = store.open("src/app.ts", "session-1");
	const state = store.getState();
	assert.equal(state?.id, id);
	assert.equal(state?.status, "loading");
	assert.equal(state?.path, "src/app.ts");
	assert.equal(state?.sessionId, "session-1");
	assert.equal(store.getTabs().length, 1);
});

test("re-opening the same path refreshes the tab with a new id", () => {
	const store = new PreviewStore();
	const first = store.open("src/app.ts", "s1");
	store.setText({ kind: "text", text: "old", totalLines: 1, shownLines: 1, truncated: false }, first);
	const second = store.open("src/app.ts", "s1");
	assert.notEqual(second, first);
	assert.equal(store.getTabs().length, 1);
	assert.equal(store.getState()?.id, second);
	assert.equal(store.getState()?.status, "loading");
	assert.equal(store.getTab(first), undefined);
	assert.equal(store.getTab(second)?.status, "loading");
});

test("stale responses for a previous tab generation are dropped", () => {
	const store = new PreviewStore();
	const first = store.open("src/app.ts", "s1");
	const second = store.open("src/app.ts", "s1");
	store.setText({ kind: "text", text: "stale", totalLines: 1, shownLines: 1, truncated: false }, first);
	assert.equal(store.getTab(second)?.status, "loading");
	store.setText({ kind: "text", text: "fresh", totalLines: 1, shownLines: 1, truncated: false }, second);
	assert.equal(store.getTab(second)?.text, "fresh");
});

test("opening different paths creates separate tabs and activates the newest", () => {
	const store = new PreviewStore();
	store.open("a.txt", "s1");
	const bId = store.open("b.txt", "s1");
	assert.equal(store.getTabs().length, 2);
	assert.equal(store.getState()?.path, "b.txt");
	assert.equal(store.getState()?.id, bId);
});

test("responses apply to their own tab even when another is active", () => {
	const store = new PreviewStore();
	const aId = store.open("a.txt", "s1");
	store.open("b.txt", "s1");
	store.setText({ kind: "text", text: "A", totalLines: 1, shownLines: 1, truncated: false }, aId);
	const aTab = store.getTab(aId);
	assert.equal(aTab?.status, "ready");
	assert.equal(aTab?.text, "A");
	assert.equal(store.getState()?.path, "b.txt");
	assert.equal(store.getState()?.text, undefined);
});

test("setText marks the addressed tab ready with text metadata", () => {
	const store = new PreviewStore();
	const id = store.open("src/app.ts", undefined);
	store.setText(
		{ kind: "text", text: "a\nb", totalLines: 5, shownLines: 2, truncated: true, truncatedBy: "lines", size: 12 },
		id,
	);
	const state = store.getTab(id);
	assert.equal(state?.status, "ready");
	assert.equal(state?.kind, "text");
	assert.equal(state?.text, "a\nb");
	assert.equal(state?.totalLines, 5);
	assert.equal(state?.shownLines, 2);
	assert.equal(state?.truncated, true);
	assert.equal(state?.size, 12);
});

test("appendText concatenates chunks and replaces counters on the addressed tab", () => {
	const store = new PreviewStore();
	const id = store.open("big.txt", undefined);
	store.setText({ kind: "text", text: "a\nb", totalLines: 5, shownLines: 2, truncated: true }, id);
	store.appendText({ kind: "text", text: "c\nd\ne", totalLines: 5, shownLines: 5, truncated: false }, id);
	const state = store.getTab(id);
	assert.equal(state?.text, "a\nb\nc\nd\ne");
	assert.equal(state?.shownLines, 5);
	assert.equal(state?.truncated, false);
});

test("appendText ignores tabs that are not text", () => {
	const store = new PreviewStore();
	const id = store.open("img.png", undefined);
	store.setImage({ kind: "image", data: "AAAA", mimeType: "image/png", size: 3 }, id);
	store.appendText({ kind: "text", text: "x", totalLines: 1, shownLines: 1, truncated: false }, id);
	const state = store.getTab(id);
	assert.equal(state?.kind, "image");
	assert.equal(state?.text, undefined);
});

test("setImage builds a data URI", () => {
	const store = new PreviewStore();
	const id = store.open("img.png", "s1");
	store.setImage({ kind: "image", data: "AAAA", mimeType: "image/png", size: 3 }, id);
	const state = store.getTab(id);
	assert.equal(state?.status, "ready");
	assert.equal(state?.imageSrc, "data:image/png;base64,AAAA");
	assert.equal(state?.size, 3);
});

test("setUnsupported records size and reason", () => {
	const store = new PreviewStore();
	const id = store.open("blob.bin", undefined);
	store.setUnsupported({ kind: "unsupported", size: 4096, reason: undefined }, id);
	const state = store.getTab(id);
	assert.equal(state?.kind, "unsupported");
	assert.equal(state?.size, 4096);
});

test("setError keeps the tab for retry", () => {
	const store = new PreviewStore();
	const id = store.open("gone.txt", "s2");
	store.setError("File not found", id);
	const state = store.getTab(id);
	assert.equal(state?.status, "error");
	assert.equal(state?.error, "File not found");
	assert.equal(state?.path, "gone.txt");
	assert.equal(state?.sessionId, "s2");
});

test("activate switches the active tab", () => {
	const store = new PreviewStore();
	const aId = store.open("a.txt", "s1");
	store.open("b.txt", "s1");
	store.activate(aId);
	assert.equal(store.getState()?.path, "a.txt");
});

test("close closes the active tab and activates the left neighbor", () => {
	const store = new PreviewStore();
	store.open("a.txt", "s1");
	const bId = store.open("b.txt", "s1");
	store.open("c.txt", "s1");
	store.close();
	assert.equal(store.getTabs().length, 2);
	assert.equal(store.getState()?.id, bId);
	assert.equal(store.getState()?.path, "b.txt");
});

test("closeTab on a non-active tab keeps the active tab", () => {
	const store = new PreviewStore();
	const aId = store.open("a.txt", "s1");
	store.open("b.txt", "s1");
	store.closeTab(aId);
	assert.equal(store.getTabs().length, 1);
	assert.equal(store.getState()?.path, "b.txt");
});

test("closing the first of two tabs keeps the second active", () => {
	const store = new PreviewStore();
	store.open("a.txt", "s1");
	const bId = store.open("b.txt", "s1");
	store.closeTab(store.getTabs()[0]!.id);
	assert.equal(store.getState()?.id, bId);
});

test("closing the last tab empties the panel and notifies subscribers", () => {
	const store = new PreviewStore();
	let notifications = 0;
	store.subscribe(() => {
		notifications++;
	});
	store.open("a.txt", undefined);
	store.close();
	assert.equal(store.getState(), undefined);
	assert.equal(store.getTabs().length, 0);
	assert.equal(notifications, 2);
});

test("setNotebook marks the tab ready with cells", () => {
	const store = new PreviewStore();
	const id = store.open("demo.ipynb", "s1");
	store.setNotebook(
		{
			kind: "notebook",
			size: 2048,
			cells: [
				{ type: "markdown", source: "# hi" },
				{ type: "code", source: "print(1)", language: "python", executionCount: 1, outputs: [] },
			],
		},
		id,
	);
	const state = store.getTab(id);
	assert.equal(state?.status, "ready");
	assert.equal(state?.kind, "notebook");
	assert.equal(state?.cells?.length, 2);
	assert.equal(state?.cells?.[1]?.language, "python");
	assert.equal(state?.size, 2048);
});
