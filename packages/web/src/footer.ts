/**
 * Control-stack views: banners (retry/compaction/queue), docked widget areas,
 * toasts. The legacy footer was retired (phase 1); live usage now renders in
 * ChatPage's status bar (status-bar.ts).
 */

import { chipEl } from "./components/kit.ts";
import type { PiConnection } from "./connection.ts";
import { h } from "./dom.ts";
import { renderWidget } from "./render/widget-data.ts";
import type { Store } from "./state.ts";

export class ToastsView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private unsubscribe: (() => void) | undefined;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(store: Store) {
		this.store = store;
		this.element = h("div", { class: "toasts" });
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		for (const timer of this.timers.values()) clearTimeout(timer);
	}

	private render(): void {
		const state = this.store.getState();
		while (this.element.firstChild) {
			this.element.removeChild(this.element.firstChild);
		}
		for (const notification of state.notifications) {
			const toast = h("div", { class: `toast ${notification.level}` }, notification.text);
			toast.addEventListener("click", () => {
				this.store.dismissNotification(notification.id);
			});
			this.element.appendChild(toast);
			if (!this.timers.has(notification.id)) {
				this.timers.set(
					notification.id,
					setTimeout(() => {
						this.store.dismissNotification(notification.id);
						this.timers.delete(notification.id);
					}, 6000),
				);
			}
		}
	}
}

/**
 * Docked-widget blocklist (batch-4 B3 + batch-6): widget keys whose lines-only
 * docked copy renders as noise above the composer.
 * - "pi-modes" (pi-agent-modes extension) pushes the active mode name (e.g.
 *   "ask") as a one-line widget right on top of the chat input while the
 *   status bar already renders the mode chip (`Ⓜ ask 🔒`).
 * - "subagent-async" (pi-subagents extension) pushes the raw
 *   `PI_SUBAGENT_ASYNC_JSON:{…}` snapshot line — machine-readable JSON is not
 *   UI. The right-panel Subagents card renders the same state session-scoped
 *   (components/session-panel.ts).
 * Extend the set if more line widgets prove noisy on the composer.
 */
export const DOCK_WIDGET_BLOCKLIST: ReadonlySet<string> = new Set(["pi-modes", "subagent-async"]);

export class WidgetAreaView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private unsubscribe: (() => void) | undefined;

	private readonly placement: "aboveEditor" | "belowEditor";
	/**
	 * Render memoization. Streaming re-renders the transcript on every
	 * message chunk; rebuilding the widget DOM on each one makes docked
	 * panels (the todo list) jitter and resets their scroll position. The
	 * store replaces the widgets Map / collapsedWidgets set identities only
	 * when widget state actually changes, so identity comparison is enough.
	 */
	private lastWidgets: ReadonlyMap<string, unknown> | undefined;
	private lastCollapsed: ReadonlySet<string> | undefined;

	constructor(store: Store, placement: "aboveEditor" | "belowEditor") {
		this.placement = placement;
		this.store = store;
		this.element = h("div", { class: `widget-area widget-${placement}` });
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
	}

	private render(): void {
		const state = this.store.getState();
		if (
			state.widgets === this.lastWidgets &&
			state.collapsedWidgets === this.lastCollapsed &&
			this.element.childElementCount > 0
		) {
			return;
		}
		this.lastWidgets = state.widgets;
		this.lastCollapsed = state.collapsedWidgets;
		// Keep the visible scroll offsets of scrollable panel bodies across
		// re-renders (e.g. a todo list that gains a task mid-read).
		const scrollOffsets = new Map<string, number>();
		for (const panel of this.element.children) {
			if (panel instanceof HTMLElement) {
				const scroller = panel.querySelector(".widget-body, .todo-list");
				if (scroller instanceof HTMLElement && scroller.scrollTop > 0) {
					scrollOffsets.set(panel.title ?? "", scroller.scrollTop);
				}
			}
		}
		while (this.element.firstChild) {
			this.element.removeChild(this.element.firstChild);
		}
		for (const [key, widget] of state.widgets) {
			if (widget.placement !== this.placement) continue;
			// Batch-4 B3: blocklisted docked keys (currently "pi-modes") duplicate
			// state the status bar already carries — skip them entirely.
			if (DOCK_WIDGET_BLOCKLIST.has(key)) continue;
			// Structured widgets (any widget.data — including overlay Display) live
			// in the right session panel / overlay view (spec §3.2.6); the docked
			// area renders lines-only widgets (Task 12, R12).
			if (widget.data) continue;
			// Defense in depth against ghost entries: a widget with no fallback
			// lines renders as an empty box. Skip it entirely.
			if ((widget.lines ?? []).every((line) => line.trim().length === 0)) continue;
			const panel = renderWidget(widget, key, {
				collapsed: state.collapsedWidgets.has(key),
				onToggle: () => this.store.toggleWidgetCollapsed(key),
			});
			panel.classList.add("widget-registered");
			panel.title = key;
			this.element.appendChild(panel);
			const offset = scrollOffsets.get(key);
			if (offset !== undefined) {
				const scroller = panel.querySelector(".widget-body, .todo-list");
				if (scroller instanceof HTMLElement) scroller.scrollTop = offset;
			}
		}
	}
}

/** Pure retry banner text: countdown + 80-char error truncation. */
export function retryBannerText(
	retry: { attempt: number; maxAttempts: number; until: number; errorMessage?: string },
	now: number,
): string {
	const seconds = Math.max(0, Math.ceil((retry.until - now) / 1000));
	const message =
		(retry.errorMessage ?? "").length > 80
			? `${(retry.errorMessage ?? "").slice(0, 80)}…`
			: (retry.errorMessage ?? "");
	return `Retrying (${retry.attempt}/${retry.maxAttempts}) in ${seconds}s${message ? ` — ${message}` : ""}`;
}

export class StatusRowsView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private readonly connection: PiConnection;
	private unsubscribe: (() => void) | undefined;
	private tickTimer: ReturnType<typeof setInterval> | undefined;

	constructor(store: Store, connection: PiConnection) {
		this.store = store;
		this.connection = connection;
		this.element = h("div", { class: "status-rows" });
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.tickTimer = setInterval(() => {
			// Retry countdown refresh
			if (this.store.getState().retry) this.render();
		}, 500);
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		if (this.tickTimer) clearInterval(this.tickTimer);
	}

	private render(): void {
		const state = this.store.getState();
		while (this.element.firstChild) {
			this.element.removeChild(this.element.firstChild);
		}

		if (state.compaction) {
			this.element.appendChild(
				h(
					"div",
					{ class: "c-banner c-banner--info" },
					h("span", { class: "c-banner-text" }, "Compacting context…"),
				),
			);
		}

		if (state.retry) {
			const row = h(
				"div",
				{ class: "c-banner c-banner--warn" },
				h("span", { class: "c-banner-text" }, retryBannerText(state.retry, Date.now())),
				h(
					"button",
					{ class: "c-banner-action", onclick: () => this.connection.send({ type: "abort_retry" }) },
					"Cancel",
				),
			);
			this.element.appendChild(row);
		}
	}
}

export class QueueView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private unsubscribe: (() => void) | undefined;

	private readonly onRemove: (kind: "steering" | "followUp", index: number) => void;

	constructor(store: Store, onRemove: (kind: "steering" | "followUp", index: number) => void) {
		this.onRemove = onRemove;
		this.store = store;
		this.element = h("div", { class: "queue-display" });
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
	}

	private render(): void {
		const state = this.store.getState();
		while (this.element.firstChild) {
			this.element.removeChild(this.element.firstChild);
		}
		for (const [index, text] of state.queue.steering.entries()) {
			this.element.appendChild(this.queueRow("steering", index, text));
		}
		for (const [index, text] of state.queue.followUp.entries()) {
			this.element.appendChild(this.queueRow("followUp", index, text));
		}
	}

	private queueRow(kind: "steering" | "followUp", index: number, text: string): HTMLElement {
		const row = h(
			"div",
			{ class: "c-banner c-banner--queue" },
			chipEl(kind),
			h("span", { class: "c-banner-text" }, text),
			h("button", { class: "c-banner-action", title: "Remove", onclick: () => this.onRemove(kind, index) }, "×"),
		);
		return row;
	}
}
