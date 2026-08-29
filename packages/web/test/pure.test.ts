import assert from "node:assert/strict";
import test from "node:test";
import { ansiToHtml, stripAnsi } from "../src/ansi.ts";
import { intraLineDiffHtml, parseDiffLine } from "../src/diff.ts";
import { buildFooterStats, computeCacheHitRate, formatCwdForFooter, formatTokens } from "../src/footer-format.ts";
import { fuzzyFilter, fuzzyScore } from "../src/fuzz.ts";
import { eventToKey } from "../src/keyboard.ts";

test("formatTokens matches the TUI formatting", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(9999), "10.0k");
	assert.equal(formatTokens(10000), "10k");
	assert.equal(formatTokens(999999), "1000k");
	assert.equal(formatTokens(1000000), "1.0M");
	assert.equal(formatTokens(9999999), "10.0M");
	assert.equal(formatTokens(10000000), "10M");
});

test("formatCwdForFooter compresses home", () => {
	assert.equal(formatCwdForFooter("/home/me/project", "/home/me"), "~/project");
	assert.equal(formatCwdForFooter("/home/me", "/home/me"), "~");
	assert.equal(formatCwdForFooter("/opt/other", "/home/me"), "/opt/other");
	assert.equal(formatCwdForFooter("/any", undefined), "/any");
});

test("buildFooterStats builds token stats and context class", () => {
	const result = buildFooterStats({
		totals: { input: 12000, output: 3000, cacheRead: 40000, cacheWrite: 5000, cost: 0.045 },
		latestCacheHitRate: 88,
		contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
		autoCompactionEnabled: true,
		usingSubscription: false,
	});
	assert.equal(result.statsLeft, "↑12k ↓3.0k R40k W5.0k CH88.0% $0.045 30.0%/200k (auto)");
	assert.equal(result.contextClass, "ok");

	const warning = buildFooterStats({
		totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
		contextUsage: { tokens: 150000, contextWindow: 200000, percent: 75 },
		autoCompactionEnabled: false,
		usingSubscription: false,
	});
	assert.equal(warning.contextClass, "warning");

	const error = buildFooterStats({
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		contextUsage: { tokens: 195000, contextWindow: 200000, percent: 97.5 },
		autoCompactionEnabled: false,
		usingSubscription: false,
	});
	assert.equal(error.contextClass, "error");
});

test("computeCacheHitRate", () => {
	assert.equal(computeCacheHitRate({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), 0);
	assert.equal(computeCacheHitRate({ input: 0, output: 0, cacheRead: 900, cacheWrite: 100, cost: 0 }), 90);
	assert.equal(computeCacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), undefined);
});

test("fuzzyScore orders word starts over scattered matches", () => {
	const wordStart = fuzzyScore("session-picker.ts", "sess");
	const scattered = fuzzyScore("some-file-with-scattered-letters.txt", "sess");
	assert.ok(wordStart > scattered);
	assert.equal(fuzzyScore("abc", "xyz"), -1);
	assert.equal(fuzzyScore("", "x"), -1);
});

test("fuzzyFilter sorts by score", () => {
	const items = ["settings.json", "sessions.ts", "styles.css"];
	const matches = fuzzyFilter(items, "sess", (item) => item);
	assert.equal(matches.length, 3);
	assert.equal(matches[0]!.item, "sessions.ts");
});

test("ansiToHtml converts colors and strips control sequences", () => {
	assert.equal(ansiToHtml("\x1b[31mred\x1b[0m plain"), '<span class="ansi-fg-red">red</span> plain');
	assert.equal(ansiToHtml("\x1b[1;32mbold green\x1b[0m"), '<span class="ansi-bold ansi-fg-green">bold green</span>');
	assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
});

test("parseDiffLine parses edit diff rows", () => {
	assert.deepEqual(parseDiffLine("+123 foo"), { prefix: "+", lineNum: "123", content: "foo" });
	assert.deepEqual(parseDiffLine("-45 bar"), { prefix: "-", lineNum: "45", content: "bar" });
	assert.deepEqual(parseDiffLine(" 77 ctx"), { prefix: " ", lineNum: "77", content: "ctx" });
	assert.equal(parseDiffLine("no prefix"), null);
});

test("intraLineDiffHtml highlights changed words", () => {
	const { removedLine, addedLine } = intraLineDiffHtml("foo bar", "foo baz");
	assert.ok(removedLine.includes("d-word-removed"), removedLine);
	assert.ok(addedLine.includes("d-word-added"), addedLine);
});

test("eventToKey normalizes modifiers", () => {
	assert.equal(eventToKey({ key: "p", ctrlKey: true } as KeyboardEvent), "ctrl+p");
	assert.equal(eventToKey({ key: "P", shiftKey: true, ctrlKey: true } as KeyboardEvent), "ctrl+shift+p");
	assert.equal(eventToKey({ key: "Enter", altKey: true } as KeyboardEvent), "alt+enter");
	assert.equal(eventToKey({ key: " " } as KeyboardEvent), "space");
});
