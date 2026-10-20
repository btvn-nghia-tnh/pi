/** Per-assistant-message usage row (spec §3.2.2). */
import { h } from "../dom.ts";
import { formatTokens } from "../footer-format.ts";
import { formatCost, usageLine } from "../usage-text.ts";

export interface UsageShape {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total: number };
}

export function usageDetails(usage: UsageShape): Array<[string, string]> {
	return [
		["input", formatTokens(usage.input)],
		["output", formatTokens(usage.output)],
		["cache read", formatTokens(usage.cacheRead)],
		["cache write", formatTokens(usage.cacheWrite)],
		["cost", formatCost(usage.cost?.total ?? 0)],
	];
}

function usageGrid(usage: UsageShape): HTMLElement {
	return h(
		"div",
		{ class: "c-usage-grid" },
		...usageDetails(usage).map(([key, value]) =>
			h("span", { class: "c-usage-cell" }, `${key}: `, h("span", { class: "mono" }, value)),
		),
	);
}

export function buildUsageRow(usage: UsageShape, opts: { compact: boolean; onToggle: () => void }): HTMLElement {
	const line = usageLine({ ...usage, cost: { total: usage.cost?.total ?? 0 } });
	const row = h(
		"button",
		{
			class: `c-usage-row${opts.compact ? "" : " is-open"}`,
			type: "button",
			"data-open": String(!opts.compact),
			onclick: opts.onToggle,
		},
		h("span", { class: "c-usage-glyph" }, "⌁"),
		h("span", { class: "c-usage-line mono" }, line),
		h("span", { class: "c-usage-caret" }, opts.compact ? "⌄" : "⌃"),
	);
	if (!opts.compact) {
		row.appendChild(usageGrid(usage));
	}
	return row;
}

export { usageGrid };
