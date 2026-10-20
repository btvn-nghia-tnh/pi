/**
 * Right session panel (spec §3.2.6, issue-batch slim-down): ONLY structured
 * widget cards (todo, MCP status, …) reusing renderWidget. The Session
 * details / Usage—today / Extension statuses cards were removed as
 * duplicates of the chat status bar — the column hides entirely while no
 * widget card exists (`.chat-right.is-empty`).
 */

import { clearElement, h } from "../dom.ts";
import { renderWidget } from "../render/widget-data.ts";
import type { AppState, Store } from "../state.ts";

/** Alias for the store state shape (mirrors status-bar.ts). */
export type StoreState = AppState;

/**
 * Pure presence check: true when at least one structured (non-overlay)
 * widget has data — gates the `.chat-right.is-empty` class in chat.ts.
 */
export function hasWidgets(state: StoreState): boolean {
	for (const widget of state.widgets?.values() ?? []) {
		if (widget.data && widget.data.display !== "overlay") return true;
	}
	return false;
}

/** R11: model display convention shared with the status bar and editor toolbar. */
export function modelShortName(model: { id: string; name?: string } | undefined): string {
	if (!model) return "no-model";
	return model.name || (model.id.split("/").pop() ?? model.id);
}

export interface SessionPanelOpts {
	store: Store;
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
	}

	private render(): void {
		const state = this.opts.store.getState();
		const cards = this.widgetCards(state);
		const empty = cards.length === 0;
		this.element.classList.toggle("is-empty", empty);
		// The host column hides with the panel (chat page owns .chat-right).
		this.element.closest(".chat-right")?.classList.toggle("is-empty", empty);
		clearElement(this.element);
		this.element.append(...cards);
	}

	/** Structured widgets (widget.data present) as standalone cards. Lines-only
	 * widgets stay docked under the editor (spec §3.2.6) — app keeps those hosts. */
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
}
