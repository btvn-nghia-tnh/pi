import assert from "node:assert/strict";
import test from "node:test";
import { scopedGroupKeys } from "../src/render/sidebar.ts";

test("scope=all passes every group key through, order preserved", () => {
	const keys = ["/a/proj1", "/b/proj2", "(no project)"];
	assert.deepEqual(scopedGroupKeys(keys, { scope: "all", activeCwd: "/b/proj1" }), keys);
});

test("scope=project keeps only the active project group", () => {
	const keys = ["/a/proj1", "/b/proj2", "(no project)"];
	assert.deepEqual(scopedGroupKeys(keys, { scope: "project", activeCwd: "/a/proj1" }), ["/a/proj1"]);
});

test("scope=project without a known active cwd degrades to all", () => {
	const keys = ["/a/proj1", "/b/proj2"];
	assert.deepEqual(scopedGroupKeys(keys, { scope: "project", activeCwd: undefined }), keys);
});

test("scope=project tolerates a zero-session project (empty list)", () => {
	assert.deepEqual(scopedGroupKeys([], { scope: "project", activeCwd: "/a/proj1" }), []);
});
