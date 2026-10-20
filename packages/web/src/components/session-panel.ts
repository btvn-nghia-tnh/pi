/**
 * Right session panel (spec §3.2.6): Session details card, structured widget
 * cards (todo, MCP status, …) reusing renderWidget, Usage—today card, and
 * ANSI-sanitized extension-status chips.
 *
 * Phase-1 note: AppState tracks only footerUsage/latestUsage — no per-session
 * usage history — so the Usage card renders totals + context progress only
 * (brief-sanctioned fallback). The sparkline lands in Plan B with dailyUsage.
 */

import { sanitizeStatusText } from "../ansi-clean.ts";
import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import { renderWidget } from "../render/widget-data.ts";
import type { AppState, Store } from "../state.ts";
import { cacheHitPct, contextLabel, formatCost, totalsLine } from "../usage-text.ts";
import { chipEl, type ProgressHandle, pillEl, progressEl } from "./kit.ts";

/** Alias for the store state shape (mirrors status-bar.ts). */
export type StoreState = AppState;

export interface PanelCard {
	title: string;
	kind: "details" | "ext-statuses";
}

/**
 * Pure card grouping: the details card always renders; the extension-statuses
 * card only exists when at least one status survives sanitization.
 */
export function panelCards(state: StoreState): PanelCard[] {
	const cards: PanelCard[] = [{ title: "Session details", kind: "details" }];
	let hasStatus = false;
	for (const text of state.extensionStatuses?.values() ?? []) {
		if (sanitizeStatusText(text).text.length > 0) {
			hasStatus = true;
			break;
		}
	}
	if (hasStatus) cards.push({ title: "Extension statuses", kind: "ext-statuses" });
	return cards;
}

/** R11: model display convention shared with the status bar and editor toolbar. */
export function modelShortName(model: { id: string; name?: string } | undefined): string {
	if (!model) return "no-model";
	return model.name || (model.id.split("/").pop() ?? model.id);
}

export interface SessionPanelOpts {
	store: Store;
	/** Reserved for future panel actions; the panel itself is display-only in phase 1. */
	connection: PiConnection;
	/** R3 anchor pattern: the clicked chip is the popover anchor (Task 12 wires the model picker). */
	onOpenModels: (anchor: HTMLElement) => void;
	/** Opens the usage view (Task 12: router navigate). */
	onOpenUsage: () => void;
}

export class SessionPanel {
	readonly element: HTMLElement;
	private readonly opts: SessionPanelOpts;
	private unsubscribe: (() => void) | undefined;
	/** Widget-slot memoization (identity-keyed, mirrors footer.ts's WidgetAreaView). */
	private lastWidgets: ReadonlyMap<string, unknown> | undefined;
	private lastCollapsed: ReadonlySet<string> | undefined;
	private widgetSlots: HTMLElement[] = [];
	/** True after a widget-slot rebuild — caches the empty list too. */
	private widgetSlotsMemoized = false;
	private progress: ProgressHandle | undefined;

	constructor(opts: SessionPanelOpts) {
		this.opts = opts;
		this.element = h("div", { class: "c-right-panel" });
	}

	mount(): void {
		if (this.unsubscribe) return; // idempotent across double-mount cycles
		this.unsubscribe = this.opts.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.lastWidgets = undefined;
		this.lastCollapsed = undefined;
		this.widgetSlots = [];
		this.widgetSlotsMemoized = false;
		this.progress = undefined;
	}

	private render(): void {
		const state = this.opts.store.getState();
		clearElement(this.element);
		this.element.appendChild(this.detailsCard(state));
		this.element.append(...this.widgetCards(state));
		this.element.appendChild(this.usageCard(state));
		if (panelCards(state).some((card) => card.kind === "ext-statuses")) {
			this.element.appendChild(this.extStatusesCard(state));
		}
	}

	private detailsCard(state: StoreState): HTMLElement {
		const { sessionState: session, contextInfo } = state;
		const rows = h("div", { class: "c-kv-rows" });
		const kvRow = (key: string, value: Node | string): void => {
			rows.appendChild(h("div", { class: "c-kv-row" }, h("span", { class: "c-kv-key" }, key), value));
		};

		const modelChip = chipEl(modelShortName(session?.model), {
			mono: true,
			tone: session?.model ? "accent" : "neutral",
			title: "Switch model / thinking level",
		});
		if (session?.model) {
			modelChip.addEventListener("click", () => this.opts.onOpenModels(modelChip));
		}
		kvRow("Model", h("span", { class: "c-kv-val" }, modelChip));
		kvRow("Thinking", session?.thinkingLevel ?? "—");
		kvRow("Branch", contextInfo?.gitBranch || "—");
		kvRow("Compaction", h("span", { class: "c-kv-val mono" }, compactionText(state)));
		const trusted = contextInfo?.isTrusted === true;
		kvRow(
			"Trust",
			trusted
				? pillEl("trusted", "ok")
				: pillEl(contextInfo ? "untrusted" : "unknown", contextInfo ? "warn" : "neutral"),
		);

		return h("div", { class: "c-card" }, h("div", { class: "c-card-title" }, "Session details"), rows);
	}

	/** Structured widgets (widget.data present) as standalone cards. Lines-only widgets
	 * stay docked under the editor (spec §3.2.6) — Task 12 keeps those hosts. */
	private widgetCards(state: StoreState): HTMLElement[] {
		if (
			state.widgets === this.lastWidgets &&
			state.collapsedWidgets === this.lastCollapsed &&
			this.widgetSlotsMemoized
		) {
			return this.widgetSlots;
		}
		this.lastWidgets = state.widgets;
		this.lastCollapsed = state.collapsedWidgets;
		this.widgetSlots = [];
		for (const [key, widget] of state.widgets) {
			if (!widget.data) continue;
			if (widget.data.display === "overlay") continue;
			const panel = renderWidget(widget, key, {
				collapsed: state.collapsedWidgets.has(key),
				onToggle: () => this.opts.store.toggleWidgetCollapsed(key),
			});
			this.widgetSlots.push(h("div", { class: "c-widget-slot" }, panel));
		}
		this.widgetSlotsMemoized = true;
		return this.widgetSlots;
	}

	private usageCard(state: StoreState): HTMLElement {
		const hit = state.latestUsage ? cacheHitPct(state.latestUsage) : null;
		const totals = totalsLine(
			{
				input: state.footerUsage.input,
				output: state.footerUsage.output,
				cost: state.footerUsage.cost,
			},
			hit,
		);
		const contextWindow = state.contextUsage?.contextWindow ?? state.sessionState?.model?.contextWindow ?? 0;
		const context = {
			percent: state.contextUsage?.percent ?? null,
			window: contextWindow,
			auto: state.sessionState?.autoCompactionEnabled ?? false,
		};
		if (!this.progress) this.progress = progressEl(context.percent ?? 0, 260);
		this.progress.update(context.percent ?? 0);

		const title = h(
			"button",
			{ class: "c-card-title c-card-link", title: "Open the usage view" },
			h("span", {}, "Usage — today"),
			h("span", { class: "c-card-title-arrow" }, "→"),
		);
		title.addEventListener("click", () => this.opts.onOpenUsage());

		return h(
			"div",
			{ class: "c-card" },
			title,
			h("div", { class: "c-usage-hero mono" }, formatCost(state.footerUsage.cost)),
			h("div", { class: "c-usage-sub mono" }, totals),
			h("div", { class: "c-usage-ctx" }, this.progress.el),
			h("div", { class: "c-usage-ctx-label mono" }, contextLabel(context)),
		);
	}

	private extStatusesCard(state: StoreState): HTMLElement {
		const chips = h("div", { class: "c-ext-chips" });
		for (const [key, text] of state.extensionStatuses) {
			const clean = sanitizeStatusText(text);
			if (!clean.text) continue;
			// kit's chip tones lack "info" — map to blue as the status bar does.
			const tone = clean.tone === "info" ? ("blue" as const) : clean.tone;
			chips.appendChild(chipEl(clean.text, { tone, title: `extension: ${key}` }));
		}
		return h("div", { class: "c-card" }, h("div", { class: "c-card-title" }, "Extension statuses"), chips);
	}
}

function compactionText(state: StoreState): string {
	if (state.sessionState?.autoCompactionEnabled !== true) return "manual";
	const percent = state.contextUsage?.percent;
	if (percent === null || percent === undefined) return "auto · on";
	return `auto · ${Math.round(percent)}% ctx`;
}
