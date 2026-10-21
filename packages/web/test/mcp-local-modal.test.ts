import assert from "node:assert/strict";
import test from "node:test";
import { localMcpRows, rowOffersSignIn } from "../src/components/mcp-local-modal.ts";
import type { McpConfigEntry } from "../src/pages/mcp.ts";

const entries: McpConfigEntry[] = [
	{
		scope: "project",
		cwd: "/w/pi",
		path: "/w/pi/.pi/mcp.json",
		name: "zeta",
		definition: { url: "https://zeta.test/mcp" },
	},
	{
		scope: "project",
		cwd: "/w/pi",
		path: "/w/pi/.pi/mcp.json",
		name: "alpha",
		definition: { command: "node", args: ["srv.js"], disabled: true },
	},
	{
		scope: "project",
		cwd: "/w/other",
		path: "/w/other/.pi/mcp.json",
		name: "ghost-for-pi",
		definition: { command: "noop" },
	},
	{
		scope: "global",
		path: "/home/u/.pi/agent/mcp.json",
		name: "bioturing",
		definition: { url: "https://api.bioturing.test/mcp" },
	},
];

test("localMcpRows: only the requested cwd's project entries, sorted, with tags", () => {
	const rows = localMcpRows(entries, "/w/pi", ["alpha"]);
	assert.deepEqual(rows, [
		{ name: "alpha", transport: "stdio", disabled: true, live: true },
		{ name: "zeta", transport: "http", disabled: false, live: false },
	]);
});

test("localMcpRows: no cwd yields nothing even with project entries", () => {
	assert.deepEqual(localMcpRows(entries, undefined, ["alpha"]), []);
});

test("localMcpRows: live flag matches by name across all cwds, disabled stays in rows", () => {
	const rows = localMcpRows(entries, "/w/other", ["ghost-for-pi", "alpha"]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].live, true);
	assert.equal(rows[0].transport, "stdio");
	assert.equal(rows[0].disabled, false);
});

test("rowOffersSignIn: needs-auth and failed offer sign-in; remote rows keep it without live status", () => {
	// Owner bug rounds 1+2: failed auth left the row without an auth affordance;
	// then the gate turned out to depend on adapter live status — the adapter
	// only publishes statuses while its /mcp panel is open, so a fresh session
	// (server answering 401) showed NO auth path at all. Remote rows now keep
	// Sign in reachable whenever they are enabled and not live-connected.
	const httpDef = { url: "https://srv.test/mcp" };
	assert.equal(rowOffersSignIn({ status: "needs-auth", needsAuth: true }, httpDef), true);
	assert.equal(rowOffersSignIn({ status: "failed", needsAuth: false }, httpDef), true);
	assert.equal(rowOffersSignIn({ status: "connected", needsAuth: false }, httpDef), false);
	assert.equal(rowOffersSignIn({ status: "cached", needsAuth: false }, httpDef), true);
	assert.equal(rowOffersSignIn(undefined, httpDef), true);
	assert.equal(rowOffersSignIn({ status: "failed", needsAuth: true }, { command: "npx", args: [] }), false);
	assert.equal(rowOffersSignIn(undefined, { url: "https://srv.test/mcp", disabled: true }), false);
});
