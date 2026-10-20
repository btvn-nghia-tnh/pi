import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The mobile pass is CSS-gated on real media queries; these tests pin the
 * breakpoints and the shell chrome classes so a refactor cannot silently
 * drop mobile support (Plan B Task 9-10 acceptance). Source css files are
 * plain assets — reading them from node is the same trick main.css units
 * would use; nothing browser-tainted runs here.
 */
const read = (name: string): string => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");
const combined = `${read("pages.css")}\n${read("components.css")}`;

test("mobile and tablet breakpoints exist", () => {
	assert.ok(combined.includes("@media (max-width: 767px)"), "phone breakpoint");
	assert.ok(combined.includes("@media (max-width: 1279px)"), "tablet breakpoint");
});

test("phone shell chrome: tab bar, rail hand-off, drawer, scrim", () => {
	assert.ok(/\.c-tabbar\s*\{[^}]*display:\s*none/.test(combined), "tabbar hidden on desktop");
	assert.ok(combined.includes(".c-rail { display: none; }"), "rail hidden on phone");
	assert.ok(combined.includes(".c-tabbar-btn"), "tab buttons");
	assert.ok(combined.includes(".c-tabbar-badge"), "running badge on chats tab");
	assert.ok(/\.c-drawer-toggle\s*\{[^}]*display:\s*none/.test(combined), "hamburger hidden on desktop");
	assert.ok(combined.includes(".c-scrim.is-open"), "scrim open state");
	assert.ok(combined.includes("transform: translateX(-100%)"), "off-canvas drawer");
	assert.ok(combined.includes(".chat-page.drawer-open > .chat-sidebar"), "chat drawer opens");
	assert.ok(combined.includes(".c-page.drawer-open .projects-body > .chat-sidebar"), "projects drawer opens");
});

test("phone surfaces collapse per mockup 07", () => {
	assert.ok(combined.includes(".c-sb-left"), "status bar left hidden");
	assert.ok(combined.includes(".dialog::before"), "sheet grip bar");
	assert.ok(combined.includes("align-items: flex-end"), "sheets dock to bottom");
});
