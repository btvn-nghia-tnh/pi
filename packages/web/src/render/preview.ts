/**
 * File preview panel: right column of the app shell. Renders text with a
 * synced line-number gutter and highlight.js syntax coloring, images as
 * data URIs, and unsupported-binary notices. Content fetch lives in App;
 * this view only renders PreviewStore state.
 */

import { h } from "../dom.ts";
import { extensionToLanguage } from "../file-refs.ts";
import type { PreviewState, PreviewStore } from "../preview-store.ts";

export interface PreviewHandlers {
	/** Activate a tab (click on the tab strip). */
	onActivate(id: string): void;
	/** Close a specific tab (× on a tab). */
	onCloseTab(id: string): void;
	/** Load the next text chunk (Load more). */
	onLoadMore(): void;
	/** Re-run the failed fetch (Retry). */
	onRetry(): void;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

interface HighlightJs {
	highlight(code: string, options: { language: string }): { value: string };
	getLanguage?: (language: string) => unknown;
}

export class PreviewView {
	readonly element: HTMLElement;
	private readonly store: PreviewStore;
	private readonly handlers: PreviewHandlers;
	private unsubscribe: (() => void) | undefined;

	constructor(store: PreviewStore, handlers: PreviewHandlers) {
		this.store = store;
		this.handlers = handlers;
		this.element = h("div", { class: "app-preview" });
	}

	mount(): void {
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private render(): void {
		const state = this.store.getState();
		this.element.replaceChildren();
		this.element.classList.toggle("is-open", state !== undefined);
		if (!state) return;

		// Tab strip: one entry per open file, active highlighted, closable.
		const strip = h("div", { class: "preview-tabs" });
		for (const tab of this.store.getTabs()) {
			strip.appendChild(
				h(
					"div",
					{
						class: `preview-tab${tab.id === state.id ? " active" : ""}`,
						title: tab.path,
						onclick: () => this.handlers.onActivate(tab.id),
					},
					h("span", { class: "preview-tab-name" }, basename(tab.path)),
					h(
						"button",
						{
							class: "preview-tab-close",
							onclick: (event: Event) => {
								// Keep the × from also activating the tab.
								event.stopPropagation();
								this.handlers.onCloseTab(tab.id);
							},
						},
						"×",
					),
				),
			);
		}
		this.element.appendChild(strip);

		const header = h(
			"div",
			{ class: "preview-header" },
			h("span", { class: "preview-title", title: state.path }, basename(state.path)),
			h("span", { class: "preview-meta" }, this.metaText(state)),
		);
		this.element.appendChild(header);

		if (state.status === "loading") {
			this.element.appendChild(h("div", { class: "preview-status" }, "Loading…"));
			return;
		}
		if (state.status === "error") {
			this.element.appendChild(
				h(
					"div",
					{ class: "preview-error" },
					h("div", {}, state.error ?? "Failed to load file"),
					h("button", { class: "preview-more", onclick: () => this.handlers.onRetry() }, "Retry"),
				),
			);
			return;
		}
		if (state.kind === "image") {
			const body = h("div", { class: "preview-body" });
			body.appendChild(h("img", { class: "preview-image", src: state.imageSrc, alt: basename(state.path) }));
			this.element.appendChild(body);
			return;
		}
		if (state.kind === "unsupported") {
			const message =
				state.truncated === true
					? `File exceeds the preview size limit (${formatSize(state.size ?? 0)}).`
					: `Binary file (${formatSize(state.size ?? 0)}). Preview is not supported.`;
			this.element.appendChild(h("div", { class: "preview-status" }, message));
			return;
		}
		if (state.kind === "text") {
			const text = state.text ?? "";
			const lineCount = text.split("\n").length;
			const gutter = h(
				"pre",
				{ class: "preview-gutter", "aria-hidden": "true" },
				Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n"),
			);
			const code = h("pre", { class: "preview-code" });
			const language = extensionToLanguage(state.path);
			const hljs: HighlightJs | undefined =
				typeof window !== "undefined" ? (window as { hljs?: HighlightJs }).hljs : undefined;
			if (language && hljs?.getLanguage?.(language)) {
				code.innerHTML = hljs.highlight(text, { language }).value;
			} else {
				code.textContent = text;
			}
			const body = h("div", { class: "preview-body" }, h("div", { class: "preview-code-row" }, gutter, code));
			this.element.appendChild(body);
			if (state.truncated) {
				this.element.appendChild(
					h(
						"button",
						{ class: "preview-more", onclick: () => this.handlers.onLoadMore() },
						`Load more (showing ${state.shownLines ?? lineCount} of ${state.totalLines ?? lineCount} lines)`,
					),
				);
			}
		}
	}

	private metaText(state: PreviewState): string {
		if (state.status === "error") return "";
		if (state.kind === "image") return formatSize(state.size ?? 0);
		if (state.kind === "unsupported") return "binary";
		if (state.kind === "text")
			return `${state.totalLines ?? 0} lines${state.size !== undefined ? ` · ${formatSize(state.size)}` : ""}`;
		return "";
	}
}
