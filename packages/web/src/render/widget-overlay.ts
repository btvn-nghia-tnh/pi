/**
 * Overlay widget rendering. Extensions can register on-demand panels through
 * setWidgetData payloads carrying `display: "overlay"` (plus `title` and
 * `closeCommand`): those render as modal dialogs instead of docked cards,
 * mirroring the TUI's interactive overlays like the /mcp panel.
 */

import { h } from "../dom.ts";
import type { Store } from "../state.ts";
import { renderWidget } from "./widget-data.ts";

interface OverlayWidgetEntry {
	key: string;
	title: string;
	closeCommand?: string;
	widget: { lines: string[]; placement: "aboveEditor" | "belowEditor"; data?: Record<string, unknown> };
}

export class WidgetOverlayView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private readonly sendCommand: (message: string) => void;
	private unsubscribe: (() => void) | undefined;
	private currentKey: string | undefined;
	private contentHost: HTMLElement | undefined;
	private titleElement: HTMLElement | undefined;

	constructor(store: Store, sendCommand: (message: string) => void) {
		this.store = store;
		this.sendCommand = sendCommand;
		this.element = h("div", { class: "dialog-overlay widget-overlay", style: "display:none" });
		this.element.tabIndex = -1;
		this.element.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.closeCurrent();
			}
		});
		this.element.addEventListener("mousedown", (event) => {
			if (event.target === this.element) {
				this.closeCurrent();
			}
		});
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
	}

	private findOverlayWidget(): OverlayWidgetEntry | undefined {
		for (const [key, widget] of this.store.getState().widgets) {
			if (widget.data?.display === "overlay") {
				return {
					key,
					title: String(widget.data.title ?? key),
					closeCommand: widget.data.closeCommand !== undefined ? String(widget.data.closeCommand) : undefined,
					widget,
				};
			}
		}
		return undefined;
	}

	private render(): void {
		const overlay = this.findOverlayWidget();

		if (!overlay) {
			this.element.style.display = "none";
			this.element.replaceChildren();
			this.currentKey = undefined;
			this.contentHost = undefined;
			this.titleElement = undefined;
			return;
		}

		if (this.currentKey !== overlay.key || !this.contentHost) {
			this.buildDialog(overlay);
		} else {
			// Live refresh while open: rebuild only the content.
			this.contentHost.replaceChildren(renderWidget(overlay.widget, overlay.key));
			if (this.titleElement) {
				this.titleElement.textContent = overlay.title;
			}
		}
		this.element.style.display = "flex";
		// Focus after the element is visible — focus() on a display:none
		// element is a no-op, and focus lets Escape close the panel.
		this.element.focus();
	}

	private buildDialog(overlay: OverlayWidgetEntry): void {
		this.currentKey = overlay.key;
		this.element.replaceChildren();
		this.titleElement = h("div", { class: "dialog-title" }, overlay.title);
		this.contentHost = h("div", { class: "dialog-body widget-overlay-body" });
		this.contentHost.appendChild(renderWidget(overlay.widget, overlay.key));

		const closeButton = h("button", { class: "primary" }, "Close (Esc)");
		closeButton.addEventListener("click", () => this.closeCurrent());

		this.element.appendChild(
			h(
				"div",
				{ class: "dialog widget-overlay-dialog" },
				this.titleElement,
				this.contentHost,
				h("div", { class: "dialog-footer" }, closeButton),
			),
		);
	}

	private closeCurrent(): void {
		const overlay = this.findOverlayWidget();
		if (!overlay) return;
		// Tell the extension first (it owns the open/close state), then clear
		// locally for instant feedback; the server's own clear is idempotent.
		if (overlay.closeCommand) {
			this.sendCommand(overlay.closeCommand);
		}
		this.store.setWidgetData(overlay.key, undefined);
	}
}
