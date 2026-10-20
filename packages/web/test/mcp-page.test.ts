import assert from "node:assert/strict";
import test from "node:test";
import { addServerRequest, controlOutcome, mcpCard, mcpTiles, toolRows } from "../src/pages/mcp.ts";
import type { McpServerWidgetEntry } from "../src/render/widget-data.ts";

const servers: McpServerWidgetEntry[] = [
	{ name: "github", status: "connected", toolCount: 12, resourceCount: 4 },
	{ name: "playwright", status: "connected", toolCount: 18 },
	{ name: "google-drive", status: "needs-auth", toolCount: 8 },
	{ name: "serpdive", status: "disabled", disabled: true, toolCount: 4 },
];

const totals = { servers: 4, connected: 2, enabled: 3, disabled: 1, tools: 42, resources: 16 };

test("mcpTiles derives the four stat tiles (mockup 04 grouping)", () => {
	const tiles = mcpTiles(servers, totals);
	assert.equal(tiles.length, 4);
	assert.deepEqual(tiles[0], { key: "servers", value: "4", sub: "3 enabled", tone: "neutral" });
	assert.deepEqual(tiles[1], { key: "connected", value: "2", sub: "connected now", tone: "warn" });
	assert.deepEqual(tiles[2], { key: "tools", value: "30/42", sub: "tools active", tone: "neutral" });
	assert.deepEqual(tiles[3], {
		key: "attention",
		value: "1",
		sub: "google-drive needs auth",
		reasons: ["google-drive needs auth"],
		tone: "warn",
	});
});

test("mcpTiles: healthy fleet becomes the ok case", () => {
	const healthy: McpServerWidgetEntry[] = [
		{ name: "github", status: "connected", toolCount: 9, resourceCount: 1 },
		{ name: "playwright", status: "connected", toolCount: 6 },
	];
	const tiles = mcpTiles(healthy, { servers: 2, connected: 2, enabled: 2, disabled: 0, tools: 15, resources: 1 });
	assert.equal(tiles[1].tone, "ok");
	assert.deepEqual(tiles[3], {
		key: "attention",
		value: "0",
		sub: "all healthy",
		reasons: [],
		tone: "ok",
	});
});

test("mcpTiles: failed servers outrank needs-auth on the attention tone", () => {
	const troubled: McpServerWidgetEntry[] = [
		{ name: "github", status: "failed", failedAgoSeconds: 10800 },
		{ name: "google-drive", status: "needs-auth" },
	];
	const troubledTotals = { servers: 2, connected: 0, enabled: 2, disabled: 0, tools: 0, resources: 0 };
	const tiles = mcpTiles(troubled, troubledTotals);
	assert.equal(tiles[3].tone, "danger");
	assert.deepEqual(tiles[3].reasons, ["github failed 3h ago", "google-drive needs auth"]);
	assert.equal(tiles[3].sub, "github failed 3h ago · google-drive needs auth");
	assert.equal(tiles[1].tone, "danger");
});

test("mcpTiles: zero connected turns the connected tile danger", () => {
	const tiles = mcpTiles([{ name: "x", status: "failed", failedAgoSeconds: 60 }], {
		servers: 1,
		connected: 0,
		enabled: 1,
		disabled: 0,
		tools: 0,
		resources: 0,
	});
	assert.equal(tiles[1].tone, "danger");
});

test("mcpTiles: missing totals fall back to entry-derived counts", () => {
	const tiles = mcpTiles(
		[
			{ name: "a", status: "connected", toolCount: 2 },
			{ name: "b", status: "not-connected" },
		],
		undefined,
	);
	assert.equal(tiles[0].value, "2");
	assert.equal(tiles[2].value, "2/2");
	assert.equal(tiles[1].value, "1");
});

test("mcpCard maps statuses to labels, tones, and meta", () => {
	assert.deepEqual(mcpCard(servers[0]!), {
		name: "github",
		transport: "—",
		statusLabel: "connected",
		tone: "ok",
		meta: "12 tools · 4 resources",
		enabled: true,
		actionLabel: "Disable",
		actionsAvailable: ["reconnect", "set-enabled"],
		canControl: true,
	});

	const needsAuth = mcpCard(servers[2]!);
	assert.equal(needsAuth.tone, "warn");
	assert.equal(needsAuth.statusLabel, "needs auth");
	assert.deepEqual(needsAuth.actionsAvailable, ["reconnect", "set-enabled", "sign-in"]);

	const disabled = mcpCard(servers[3]!);
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.actionLabel, "Enable");
	assert.equal(disabled.tone, "neutral");
	assert.equal(disabled.statusLabel, "disabled");

	const failed = mcpCard({ name: "serpdive", status: "failed", failedAgoSeconds: 10800 });
	assert.equal(failed.tone, "danger");
	assert.equal(failed.meta, "last failed 3h ago");

	const failedFresh = mcpCard({ name: "serpdive", status: "failed", failedAgoSeconds: 45 });
	assert.equal(failedFresh.meta, "last failed 45s ago");
});

test("mcpCard: transport hint is honored, canControl defaults on", () => {
	const card = mcpCard(servers[0]!, { transport: "http", canControl: false });
	assert.equal(card.transport, "http");
	assert.equal(card.canControl, false);
});

test("mcpCard: cached and unknown statuses degrade to neutral", () => {
	assert.equal(mcpCard({ name: "a", status: "cached" }).statusLabel, "cached");
	assert.equal(mcpCard({ name: "a", status: "cached" }).tone, "neutral");
	const unknown = mcpCard({ name: "a", status: "connecting" });
	assert.equal(unknown.statusLabel, "connecting");
	assert.equal(unknown.tone, "neutral");
});

test("controlOutcome: delivered true always toasts the handoff", () => {
	for (const action of ["reconnect", "start-auth", "set-enabled"] as const) {
		assert.deepEqual(controlOutcome({ action, server: "github" }, true), {
			kind: "toast",
			message: "MCP control delivered",
		});
	}
});

test("controlOutcome: undelivered set-enabled falls back to the config writer", () => {
	const enable = controlOutcome({ action: "set-enabled", server: "serpdive", value: true }, false);
	assert.deepEqual(enable, {
		kind: "config-write",
		enabled: true,
		toast: "written to .pi/mcp.json — applies on next session start",
	});
	const disable = controlOutcome({ action: "set-enabled", server: "github", value: false }, false);
	assert.equal(disable.kind, "config-write");
	assert.equal((disable as { enabled: boolean }).enabled, false);
});

test("controlOutcome: undelivered reconnect/start-auth degrade with the exact banner", () => {
	assert.deepEqual(controlOutcome({ action: "reconnect", server: "github" }, false), {
		kind: "degraded",
		banner: "Adapter reconnect needs a pi-mcp-adapter update. Toggle changes fall back to editing .mcp.json on disk.",
	});
	assert.deepEqual(controlOutcome({ action: "start-auth", server: "google-drive" }, false), {
		kind: "degraded",
		banner:
			"Adapter start-auth needs a pi-mcp-adapter update. Toggle changes fall back to editing .mcp.json on disk.",
	});
});

test("toolRows: absent tool metadata yields null (read-only note path)", () => {
	assert.equal(toolRows(servers[0]!), null);
});

test("toolRows: future tool-list data maps to read-only rows", () => {
	const future = {
		name: "github",
		status: "connected",
		tools: [
			{ name: "octo_list_issues", description: "list issues with filters", active: true },
			{ name: "web_search", description: "search the web", active: false },
		],
	} as unknown as McpServerWidgetEntry;
	assert.deepEqual(toolRows(future), [
		{ name: "octo_list_issues", description: "list issues with filters", active: true },
		{ name: "web_search", description: "search the web", active: false },
	]);
});

// ---------------------------------------------------------------------------
// addServerRequest (mcp_config_add form validation)
// ---------------------------------------------------------------------------

const baseForm = {
	name: "my-tools",
	transport: "stdio" as const,
	scope: "project" as const,
	command: "npx -y my-mcp-server",
	argsText: "",
	url: "",
};

test("addServerRequest: empty name errors", () => {
	assert.deepEqual(addServerRequest({ ...baseForm, name: "   " }), { error: "server name is required" });
});

test("addServerRequest: stdio without command errors", () => {
	assert.deepEqual(addServerRequest({ ...baseForm, command: "  " }), {
		error: "command is required for stdio servers",
	});
});

test("addServerRequest: http without url errors", () => {
	assert.deepEqual(addServerRequest({ ...baseForm, transport: "http", url: " " }), {
		error: "url is required for http servers",
	});
});

test("addServerRequest: stdio happy path with comma-split args", () => {
	const request = addServerRequest({
		...baseForm,
		argsText: " --scope repo ,  ,extra ,  spaced ",
		scope: "global",
	});
	assert.deepEqual(request, {
		scope: "global",
		server: "my-tools",
		definition: { command: "npx -y my-mcp-server", args: ["--scope repo", "extra", "spaced"] },
	});
});

test("addServerRequest: stdio with no args omits the args key", () => {
	assert.deepEqual(addServerRequest({ ...baseForm, argsText: " , , " }), {
		scope: "project",
		server: "my-tools",
		definition: { command: "npx -y my-mcp-server" },
	});
});

test("addServerRequest: http happy path, name trimmed, env/headers not sent", () => {
	const request = addServerRequest({
		...baseForm,
		name: "  search \n",
		transport: "http",
		url: "  https://mcp.example.test/api ",
	});
	assert.deepEqual(request, {
		scope: "project",
		server: "search",
		definition: { url: "https://mcp.example.test/api" },
	});
});
