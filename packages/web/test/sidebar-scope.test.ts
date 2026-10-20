import assert from "node:assert/strict";
import test from "node:test";
import { isFlatScope, scopedGroupKeys } from "../src/render/sidebar.ts";

// The chat sidebar is PERMANENTLY project-scoped (mid-flight spec update:
// no "All projects" toggle — the Projects page owns cross-project views).

test("scopedGroupKeys keeps only the active project's group", () => {
	const keys = ["/a/proj1", "/b/proj2", "(no project)"];
	assert.deepEqual(scopedGroupKeys(keys, { activeCwd: "/a/proj1" }), ["/a/proj1"]);
	assert.deepEqual(scopedGroupKeys(keys, { activeCwd: "/b/proj2" }), ["/b/proj2"]);
});

test("scopedGroupKeys without an active cwd (pre-connect) passes everything through", () => {
	const keys = ["/a/proj1", "/b/proj2"];
	assert.deepEqual(scopedGroupKeys(keys, { activeCwd: undefined }), keys);
});

test("a zero-session project yields an empty key list", () => {
	assert.deepEqual(scopedGroupKeys([], { activeCwd: "/a/proj1" }), []);
});

test("isFlatScope is flat whenever a scoping cwd exists", () => {
	assert.equal(isFlatScope("/home/u/pi"), true);
	assert.equal(isFlatScope(undefined), false);
});
