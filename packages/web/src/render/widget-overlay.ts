/**
 * Overlay widgets (setWidgetData display: "overlay") render as modals on top
 * of the app. Interactive overlays (questionnaires) collect structured
 * answers and send them back through the widget_response command; plain
 * overlays (status panels) close via their closeCommand.
 */

import { h } from "../dom.ts";
import type { Store } from "../state.ts";
import { type AskSubmitPayload, createQuestionnaireView, parseAskQuestionnaire } from "./questionnaire.ts";
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
	private readonly submitWidgetResponse: (key: string, payload: unknown) => void;
	private unsubscribe: (() => void) | undefined;
	private currentKey: string | undefined;
	private contentHost: HTMLElement | undefined;
	private titleElement: HTMLElement | undefined;
	/** Interactive questionnaire currently mounted — its DOM owns live state. */
	private questionnaireKey: string | undefined;
	/** Widget payload reference for the mounted questionnaire (change detection). */
	private questionnaireData: unknown;

	constructor(
		store: Store,
		sendCommand: (message: string) => void,
		submitWidgetResponse: (key: string, payload: unknown) => void,
	) {
		this.store = store;
		this.sendCommand = sendCommand;
		this.submitWidgetResponse = submitWidgetResponse;
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
			if (event.target !== this.element) return;
			// Accidental backdrop clicks must not cancel a pending
			// questionnaire — only Esc / the Cancel button do.
			const overlay = this.findOverlayWidget();
			if (overlay && this.questionnaireKey === overlay.key) return;
			this.closeCurrent();
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
			this.questionnaireKey = undefined;
			return;
		}

		const questionnaire = parseAskQuestionnaire(overlay.widget.data);

		if (this.currentKey !== overlay.key || !this.contentHost) {
			this.buildDialog(overlay, questionnaire);
		} else if (questionnaire && this.questionnaireKey === overlay.key) {
			// Interactive questionnaire: live DOM owns selections and typed
			// text — re-rendering would wipe them. Refresh only when the
			// extension pushes a new questionnaire payload.
			if (overlay.widget.data !== this.questionnaireData) {
				this.buildDialog(overlay, questionnaire);
			}
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

	private buildDialog(overlay: OverlayWidgetEntry, questionnaire: ReturnType<typeof parseAskQuestionnaire>): void {
		this.currentKey = overlay.key;
		this.element.replaceChildren();
		this.titleElement = h("div", { class: "dialog-title" }, overlay.title);
		this.contentHost = h("div", { class: "dialog-body widget-overlay-body" });

		if (questionnaire) {
			this.questionnaireKey = overlay.key;
			this.questionnaireData = overlay.widget.data;
			this.contentHost.appendChild(
				createQuestionnaireView(
					questionnaire,
					(payload: AskSubmitPayload) => {
						this.submitWidgetResponse(overlay.key, payload);
					},
					() => {
						this.submitWidgetResponse(overlay.key, { answers: [], cancelled: true });
					},
				),
			);
			// The questionnaire ships its own Cancel/Submit footer; a generic
			// Close button would read as a third action.
			this.element.appendChild(
				h("div", { class: "dialog widget-overlay-dialog" }, this.titleElement, this.contentHost),
			);
			return;
		}

		this.questionnaireKey = undefined;
		this.questionnaireData = undefined;
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
		if (this.questionnaireKey === overlay.key) {
			// Cancelling a questionnaire must resolve the pending tool call —
			// clear locally only after reporting, so the extension-side clear
			// and the local view agree.
			this.submitWidgetResponse(overlay.key, { answers: [], cancelled: true });
		} else if (overlay.closeCommand) {
			// Tell the extension first (it owns the open/close state), then clear
			// locally for instant feedback; the server's own clear is idempotent.
			this.sendCommand(overlay.closeCommand);
		}
		this.store.setWidgetData(overlay.key, undefined);
	}
}
