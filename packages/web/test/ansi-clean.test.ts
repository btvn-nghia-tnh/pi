import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeStatusText } from "../src/ansi-clean.ts";

test("strips SGR sequences and keeps label text", () => {
	const raw =
		"?/1.0M (auto)\u001b[38;2;181;189;104mⓂ build\u001b[39m\u001b[38;2;138;190;183m🔌 MCP: 3 servers enabled\u001b[39m";
	const out = sanitizeStatusText(raw);
	assert.equal(out.text, "?/1.0M (auto)Ⓜ build🔌 MCP: 3 servers enabled");
	// The blob contains the "MCP: 3 servers enabled" segment, so the rule for
	// info statuses applies (fixture correction: plan expected "neutral",
	// impossible with the plan's own tone rules — see task report).
	assert.equal(out.tone, "info");
	assert.ok(!out.text.includes("\u001b"));
});

test("maps common words to tones", () => {
	assert.equal(sanitizeStatusText("MCP: 3 servers enabled").tone, "info");
	assert.equal(sanitizeStatusText("✓ hooks ok").tone, "ok");
	assert.equal(sanitizeStatusText("⚠ deprecation").tone, "warn");
	assert.equal(sanitizeStatusText("✗ failure / error").tone, "danger");
	assert.equal(sanitizeStatusText("● running build").tone, "accent");
});

test("an empty or whitespace status stays neutral and trimmed", () => {
	assert.equal(sanitizeStatusText("   ").text, "");
	assert.equal(sanitizeStatusText("").tone, "neutral");
});

test("other control sequences are removed too", () => {
	// str.stripAnsi consumes the OSC chunk "\u001b]0;title\u0007" including its
	// payload, and stray C0 controls (BEL, bare ESC) vanish next — the plain
	// label words around them survive (fixture correction: see task report).
	const out = sanitizeStatusText("beep\u0007bell\u001bapi\u001b]0;title\u0007tail");
	assert.equal(out.text, "beepbellapitail");
	assert.ok(!/[\u0000-\u001f]/.test(out.text));
});
