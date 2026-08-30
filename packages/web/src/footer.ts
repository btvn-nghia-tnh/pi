/**
 * Footer, status rows, widgets, toasts, working indicator.
 */

import type { PiConnection } from "./connection.ts";
import { h } from "./dom.ts";
import { buildFooterStats, formatCwdForFooter } from "./footer-format.ts";
import { renderWidget } from "./render/widget-data.ts";
import type { Store } from "./state.ts";

const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class FooterView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private unsubscribe: (() => void) | undefined;
	private spinnerFrame = 0;
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;

	constructor(store: Store) {
		this.store = store;
		this.element = h(
			"div",
			{ class: "app-footer" },
			h("div", { class: "footer-left" }),
			h("div", { class: "footer-stats" }),
			h("div", { class: "footer-right" }),
		);
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame++;
			this.renderSpinner();
		}, 120);
	}

	unmount(): void {
		this.unsubscribe?.();
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
	}

	private renderSpinner(): void {
		const spinner = this.element.querySelector(".spinner");
		if (spinner) {
			const state = this.store.getState();
			const frames = state.workingIndicator?.frames ?? DEFAULT_SPINNER_FRAMES;
			if (frames.length > 0) {
				spinner.textContent = frames[this.spinnerFrame % frames.length]!;
			}
		}
	}

	private render(): void {
		const state = this.store.getState();
		const sessionState = state.sessionState;
		if (!sessionState) return;

		const left = this.element.querySelector(".footer-left")!;
		const stats = this.element.querySelector(".footer-stats")!;
		const right = this.element.querySelector(".footer-right")!;

		let leftText = formatCwdForFooter(state.contextInfo?.cwd ?? "", guessHome());
		if (state.contextInfo?.gitBranch) {
			leftText += ` (${state.contextInfo.gitBranch})`;
		}
		if (sessionState.sessionName) {
			leftText += ` • ${sessionState.sessionName}`;
		}
		left.textContent = leftText;

		const contextWindow = sessionState.model?.contextWindow ?? 0;
		const contextUsage = state.contextUsage ?? {
			tokens: null,
			contextWindow,
			percent: null,
		};
		const result = buildFooterStats({
			totals: state.footerUsage,
			latestCacheHitRate: computeHitRate(state.latestUsage),
			contextUsage,
			autoCompactionEnabled: sessionState.autoCompactionEnabled,
			usingSubscription: state.contextInfo?.isUsingSubscription === true,
		});

		const statsParts: HTMLElement[] = [];
		if (sessionState.isStreaming || sessionState.isCompacting) {
			statsParts.push(h("span", { class: "spinner" }, DEFAULT_SPINNER_FRAMES[0]!));
		}
		if (state.compaction) {
			statsParts.push(h("span", {}, "compacting…"));
		}
		statsParts.push(h("span", { class: `ctx-${result.contextClass}` }, result.statsLeft));
		if (state.contextInfo?.experimental) {
			statsParts.push(h("span", { class: "ctx-warning" }, "• xp"));
		}
		for (const [key, text] of state.extensionStatuses) {
			statsParts.push(h("span", { class: "ext-status", title: key }, text));
		}
		while (stats.firstChild) stats.removeChild(stats.firstChild);
		for (const part of statsParts) stats.appendChild(part);

		const model = sessionState.model;
		let rightText = model?.id ?? "no-model";
		if (model?.reasoning) {
			rightText += ` • ${sessionState.thinkingLevel}`;
		}
		right.textContent = rightText;
	}
}

function guessHome(): string | undefined {
	return undefined;
}

function computeHitRate(
	usage: { input: number; cacheRead: number; cacheWrite: number } | undefined,
): number | undefined {
	if (!usage) return undefined;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return (usage.cacheRead / promptTokens) * 100;
}

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

export class WidgetAreaView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private unsubscribe: (() => void) | undefined;

	private readonly placement: "aboveEditor" | "belowEditor";

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
		while (this.element.firstChild) {
			this.element.removeChild(this.element.firstChild);
		}
		for (const [key, widget] of state.widgets) {
			if (widget.placement !== this.placement) continue;
			// Overlay widgets (display: "overlay") render as modals in the
			// WidgetOverlayView — do not duplicate them as empty docked panels.
			if (widget.data?.display === "overlay") continue;
			// Defense in depth against ghost entries: a widget with no
			// structured payload and no fallback lines renders as an empty
			// box. Skip it entirely.
			if (!widget.data && (widget.lines ?? []).every((line) => line.trim().length === 0)) continue;
			const panel = renderWidget(widget, key, {
				collapsed: state.collapsedWidgets.has(key),
				onToggle: () => this.store.toggleWidgetCollapsed(key),
			});
			panel.classList.add("widget-registered");
			panel.title = key;
			this.element.appendChild(panel);
		}
	}
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
					{ class: "status-row" },
					h("span", { class: "spinner" }, "⠿"),
					h("span", {}, "Compacting context…"),
				),
			);
		}

		if (state.retry) {
			const seconds = Math.max(0, Math.ceil((state.retry.until - Date.now()) / 1000));
			const row = h(
				"div",
				{ class: "status-row retry-row" },
				h(
					"span",
					{},
					`Retrying (${state.retry.attempt}/${state.retry.maxAttempts}) in ${seconds}s — ${truncate(state.retry.errorMessage, 120)}`,
				),
				h("button", { onclick: () => this.connection.send({ type: "abort_retry" }) }, "Abort"),
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
			{ class: "queue-item" },
			h("span", { class: "queue-kind" }, kind),
			h("span", { class: "queue-text" }, text),
			h("button", { title: "Remove", onclick: () => this.onRemove(kind, index) }, "×"),
		);
		return row;
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
