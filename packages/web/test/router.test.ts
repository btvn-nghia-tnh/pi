import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeToHash } from "../src/router.ts";

test("empty and unknown hashes fall back to home", () => {
	assert.deepEqual(parseRoute(""), { page: "home" });
	assert.deepEqual(parseRoute("#/"), { page: "home" });
	assert.deepEqual(parseRoute("#/nope/x"), { page: "home" });
});

test("plain pages round-trip", () => {
	for (const page of ["chat", "projects", "mcp", "usage"] as const) {
		assert.equal(routeToHash({ page }), `#/${page}`);
		assert.deepEqual(parseRoute(`#/${page}`), { page });
	}
});

test("chat session deep links round-trip", () => {
	const hash = "#/chat/abc-123";
	assert.deepEqual(parseRoute(hash), { page: "chat", sessionId: "abc-123" });
	assert.equal(routeToHash({ page: "chat", sessionId: "abc-123" }), hash);
});

test("project paths are uri-encoded", () => {
	const route = { page: "projects" as const, pathArg: "/home/u/my project" };
	const hash = routeToHash(route);
	assert.equal(hash, "#/projects/%2Fhome%2Fu%2Fmy%20project");
	assert.deepEqual(parseRoute(hash), route);
});

test("settings sections round-trip with a default", () => {
	assert.deepEqual(parseRoute("#/settings"), { page: "settings", section: "general" });
	assert.deepEqual(parseRoute("#/settings/appearance"), { page: "settings", section: "appearance" });
	assert.equal(routeToHash({ page: "settings", section: "keybindings" }), "#/settings/keybindings");
});
