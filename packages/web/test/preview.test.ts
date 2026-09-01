import assert from "node:assert/strict";
import test from "node:test";
import { PreviewStore } from "../src/preview-store.ts";

test("open sets a loading state with path and session", () => {
	const store = new PreviewStore();
	store.open("src/app.ts", "session-1");
	const state = store.getState();
	assert.equal(state?.status, "loading");
	assert.equal(state?.path, "src/app.ts");
	assert.equal(state?.sessionId, "session-1");
});

test("setText marks the preview ready with text metadata", () => {
	const store = new PreviewStore();
	store.open("src/app.ts", undefined);
	store.setText({ kind: "text", text: "a\nb", totalLines: 5, shownLines: 2, truncated: true, truncatedBy: "lines" });
	const state = store.getState();
	assert.equal(state?.status, "ready");
	assert.equal(state?.kind, "text");
	assert.equal(state?.text, "a\nb");
	assert.equal(state?.totalLines, 5);
	assert.equal(state?.shownLines, 2);
	assert.equal(state?.truncated, true);
});

test("appendText concatenates chunks and replaces counters", () => {
	const store = new PreviewStore();
	store.open("big.txt", undefined);
	store.setText({ kind: "text", text: "a\nb", totalLines: 5, shownLines: 2, truncated: true, truncatedBy: "lines" });
	store.appendText({ kind: "text", text: "c\nd\ne", totalLines: 5, shownLines: 5, truncated: false });
	const state = store.getState();
	assert.equal(state?.text, "a\nb\nc\nd\ne");
	assert.equal(state?.shownLines, 5);
	assert.equal(state?.truncated, false);
});

test("appendText ignores previews that are not text", () => {
	const store = new PreviewStore();
	store.open("img.png", undefined);
	store.setImage({ kind: "image", data: "AAAA", mimeType: "image/png", size: 3 });
	store.appendText({ kind: "text", text: "x", totalLines: 1, shownLines: 1, truncated: false });
	const state = store.getState();
	assert.equal(state?.kind, "image");
	assert.equal(state?.text, undefined);
});

test("setImage builds a data URI", () => {
	const store = new PreviewStore();
	store.open("img.png", "s1");
	store.setImage({ kind: "image", data: "AAAA", mimeType: "image/png", size: 3 });
	const state = store.getState();
	assert.equal(state?.status, "ready");
	assert.equal(state?.imageSrc, "data:image/png;base64,AAAA");
	assert.equal(state?.size, 3);
});

test("setUnsupported records size and reason", () => {
	const store = new PreviewStore();
	store.open("blob.bin", undefined);
	store.setUnsupported({ kind: "unsupported", size: 4096, reason: undefined });
	const state = store.getState();
	assert.equal(state?.kind, "unsupported");
	assert.equal(state?.size, 4096);
});

test("setError keeps the path for retry", () => {
	const store = new PreviewStore();
	store.open("gone.txt", "s2");
	store.setError("File not found");
	const state = store.getState();
	assert.equal(state?.status, "error");
	assert.equal(state?.error, "File not found");
	assert.equal(state?.path, "gone.txt");
	assert.equal(state?.sessionId, "s2");
});

test("close clears the state and notifies subscribers", () => {
	const store = new PreviewStore();
	let notifications = 0;
	store.subscribe(() => {
		notifications++;
	});
	store.open("a.txt", undefined);
	store.close();
	assert.equal(store.getState(), undefined);
	assert.equal(notifications, 2);
});
