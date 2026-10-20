import assert from "node:assert/strict";
import test from "node:test";
import { resolveSection, SETTINGS_SECTIONS, settingsKbdRow, themeCardRows } from "../src/pages/settings.ts";
import type { RpcThemeInfo } from "../src/types.ts";

test("SETTINGS_SECTIONS lists the eight fixed sections in order", () => {
	assert.deepEqual(
		SETTINGS_SECTIONS.map((section) => section.id),
		["general", "models", "appearance", "keybindings", "mcp", "accounts", "trust", "about"],
	);
});

test("settingsKbdRow normalizes keys and trims descriptions", () => {
	assert.deepEqual(
		settingsKbdRow({ id: "core.abort", keys: ["Ctrl+C", "Escape", ""], description: "  Abort the run  " }),
		{ id: "core.abort", keys: ["Ctrl+C", "Escape"], description: "Abort the run" },
	);
	assert.deepEqual(settingsKbdRow({ keys: undefined as never }), { id: "", keys: [], description: "" });
	assert.deepEqual(settingsKbdRow({ id: "x", keys: "Ctrl+D" as never }), { id: "x", keys: [], description: "" });
});

test("themeCardRows maps theme vars to swatches with the dialog's fallback", () => {
	const themes: RpcThemeInfo[] = [
		{ name: "pi-dark", vars: { text: "#111111", accent: "#222222", red: "#333333", green: "#444444" } },
		{ name: "plain", vars: {} },
	];
	const rows = themeCardRows(themes, "plain");
	assert.deepEqual(rows[0], {
		name: "pi-dark",
		swatches: ["#111111", "#222222", "#333333", "#444444"],
		isCurrent: false,
	});
	assert.deepEqual(rows[1], {
		name: "plain",
		swatches: ["#888888", "#888888", "#888888", "#888888"],
		isCurrent: true,
	});
	assert.equal(rows.length, 2);
});

test("themeCardRows keeps source order and defaults isCurrent to false", () => {
	const rows = themeCardRows([{ name: "solo", vars: { accent: "#2DD4BF" } }]);
	assert.deepEqual(rows, [{ name: "solo", swatches: ["#888888", "#2DD4BF", "#888888", "#888888"], isCurrent: false }]);
});

test("resolveSection falls back to general for unknown or missing input", () => {
	assert.deepEqual(resolveSection(undefined), { id: "general", label: "General" });
	assert.deepEqual(resolveSection("nope"), { id: "general", label: "General" });
	assert.deepEqual(resolveSection("appearance"), { id: "appearance", label: "Appearance" });
	assert.deepEqual(resolveSection("trust"), { id: "trust", label: "Trust & Security" });
});
