/**
 * Stub pages so every route resolves while the remaining console pages
 * (Home / Projects / MCP / Usage / Settings) land in the next slice.
 * Plan B replaces each entry with a real pages/<name>.ts module.
 */
import { h } from "../dom.ts";
import type { PageId } from "../router.ts";
import type { ShellPage } from "../shell.ts";

export const STUB_PAGES: Partial<Record<PageId, { title: string; blurb: string }>> = {
	home: { title: "Home", blurb: "Quick start + your day at a glance." },
	projects: { title: "Projects", blurb: "Every working directory with its sessions and stats." },
	mcp: { title: "MCP", blurb: "Servers, tools and health at a glance." },
	usage: { title: "Usage", blurb: "Cost and tokens across sessions, days, models." },
	settings: { title: "Settings", blurb: "Keys, auth, themes and defaults." },
};

export function createStubPage(id: PageId): ShellPage | undefined {
	const meta = STUB_PAGES[id];
	if (!meta) return undefined;
	const element = h(
		"div",
		{ class: "c-page stub-page" },
		h("div", { class: "c-page-header" }, h("span", { class: "c-page-title" }, meta.title)),
		h(
			"div",
			{ class: "stub-body" },
			h(
				"div",
				{ class: "c-card" },
				h("div", { class: "c-card-title" }, meta.title),
				h("p", {}, meta.blurb),
				h(
					"p",
					{ class: "dim" },
					"This page ships in the next slice of the console redesign. Chat is fully usable today.",
				),
			),
		),
	);
	return { id, title: meta.title, element, mount() {}, unmount() {} };
}
