/**
 * File preview panel: right column of the app shell. Renders text with a
 * synced line-number gutter and highlight.js syntax coloring, images as
 * data URIs, and unsupported-binary notices. Content fetch lives in App;
 * this view only renders PreviewStore state.
 */

import { h } from "../dom.ts";
import { extensionToLanguage } from "../file-refs.ts";
import { renderMarkdown, sanitizeMarkdownHtml } from "../markdown.ts";
import type { PreviewState, PreviewStore } from "../preview-store.ts";
import type { NotebookCell, NotebookOutput } from "../types.ts";

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

function isHtmlFile(path: string): boolean {
	return /\.(?:html?|xhtml)$/i.test(path);
}

function isMarkdownFile(path: string): boolean {
	return /\.(?:md|markdown)$/i.test(path);
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
	/** HTML/markdown files toggle between rendered view and source; resets on tab switch. */
	private viewSource = false;
	private lastActiveTabId: string | undefined;

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

	private highlightInto(code: HTMLElement, text: string, language: string | undefined): void {
		const hljs: HighlightJs | undefined =
			typeof window !== "undefined" ? (window as { hljs?: HighlightJs }).hljs : undefined;
		if (language && hljs?.getLanguage?.(language)) {
			code.innerHTML = hljs.highlight(text, { language }).value;
		} else {
			code.textContent = text;
		}
	}

	private renderNotebookCell(cell: NotebookCell): HTMLElement {
		if (cell.type === "markdown") {
			const rendered = h("div", { class: "notebook-md md-body" });
			rendered.innerHTML = sanitizeMarkdownHtml(renderMarkdown(cell.source));
			return h("div", { class: "notebook-cell notebook-cell-md" }, rendered);
		}
		if (cell.type === "raw") {
			return h(
				"div",
				{ class: "notebook-cell notebook-cell-raw" },
				h("pre", { class: "notebook-raw" }, cell.source),
			);
		}
		const children: HTMLElement[] = [];
		if (cell.executionCount !== undefined) {
			children.push(h("span", { class: "notebook-exec" }, `In [${cell.executionCount}]`));
		}
		children.push(h("span", { class: "notebook-lang" }, cell.language ?? ""));
		const header = h("div", { class: "notebook-code-header" }, ...children);
		const code = h("pre", { class: "preview-code notebook-code" });
		this.highlightInto(code, cell.source, cell.language);
		const container = h("div", { class: "notebook-cell notebook-cell-code" }, header, code);
		for (const output of cell.outputs ?? []) {
			container.appendChild(this.renderNotebookOutput(output));
		}
		return container;
	}

	private renderNotebookOutput(output: NotebookOutput): HTMLElement {
		if (output.type === "stream") {
			return h(
				"pre",
				{ class: `notebook-output${output.name === "stderr" ? " notebook-stderr" : ""}` },
				output.text,
			);
		}
		if (output.type === "error") {
			return h(
				"div",
				{ class: "notebook-error" },
				h("div", { class: "notebook-error-name" }, `${output.name}: ${output.message}`),
				h("pre", { class: "notebook-traceback" }, output.traceback),
			);
		}
		if (output.type === "image") {
			return h("img", {
				class: "notebook-image",
				src: `data:${output.mimeType};base64,${output.data}`,
				alt: "notebook output",
			});
		}
		if (output.type === "text") {
			return h("pre", { class: "notebook-output" }, output.text);
		}
		return h("div", { class: "notebook-output-unsupported" }, `[unsupported output: ${output.mimeType}]`);
	}

	private render(): void {
		const state = this.store.getState();
		this.element.replaceChildren();
		this.element.classList.toggle("is-open", state !== undefined);
		if (!state) return;
		if (state.id !== this.lastActiveTabId) {
			this.lastActiveTabId = state.id;
			this.viewSource = false;
		}

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

		const headerChildren: HTMLElement[] = [
			h("span", { class: "preview-title", title: state.path }, basename(state.path)),
			h("span", { class: "preview-meta" }, this.metaText(state)),
		];
		if (state.kind === "text" && (isHtmlFile(state.path) || isMarkdownFile(state.path))) {
			headerChildren.push(
				h(
					"button",
					{
						class: "preview-toggle",
						onclick: () => {
							this.viewSource = !this.viewSource;
							this.render();
						},
					},
					this.viewSource ? "Preview" : "Source",
				),
			);
		}
		this.element.appendChild(h("div", { class: "preview-header" }, ...headerChildren));

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
		if (state.kind === "notebook") {
			const body = h("div", { class: "preview-body notebook-body" });
			for (const cell of state.cells ?? []) {
				body.appendChild(this.renderNotebookCell(cell));
			}
			this.element.appendChild(body);
			return;
		}
		if (state.kind === "text") {
			const text = state.text ?? "";
			if (isHtmlFile(state.path) && !this.viewSource) {
				// Sandboxed render: scripts run, but no same-origin access to the
				// pi app (opaque origin). srcdoc has no base URL, so relative
				// resources do not resolve — self-contained pages only.
				const body = h("div", { class: "preview-body preview-html-body" });
				body.appendChild(
					h("iframe", {
						class: "preview-html-frame",
						sandbox: "allow-scripts allow-modals",
						srcdoc: text,
						title: basename(state.path),
					}),
				);
				this.element.appendChild(body);
				this.appendLoadMore(state);
				return;
			}
			if (isMarkdownFile(state.path) && !this.viewSource) {
				// File markdown is untrusted content: sanitize the rendered HTML
				// before it enters this origin (agent transcript keeps raw path).
				const rendered = h("div", { class: "md-body preview-md" });
				rendered.innerHTML = sanitizeMarkdownHtml(renderMarkdown(text));
				this.element.appendChild(h("div", { class: "preview-body preview-md-body" }, rendered));
				this.appendLoadMore(state);
				return;
			}
			const lineCount = text.split("\n").length;
			const gutter = h(
				"pre",
				{ class: "preview-gutter", "aria-hidden": "true" },
				Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n"),
			);
			const code = h("pre", { class: "preview-code" });
			this.highlightInto(code, text, extensionToLanguage(state.path));
			const body = h("div", { class: "preview-body" }, h("div", { class: "preview-code-row" }, gutter, code));
			this.element.appendChild(body);
			this.appendLoadMore(state);
		}
	}

	private appendLoadMore(state: PreviewState): void {
		if (!state.truncated) return;
		const fallbackLines = (state.text ?? "").split("\n").length;
		this.element.appendChild(
			h(
				"button",
				{ class: "preview-more", onclick: () => this.handlers.onLoadMore() },
				`Load more (showing ${state.shownLines ?? fallbackLines} of ${state.totalLines ?? fallbackLines} lines)`,
			),
		);
	}

	private metaText(state: PreviewState): string {
		if (state.status === "error") return "";
		if (state.kind === "image") return formatSize(state.size ?? 0);
		if (state.kind === "unsupported") return "binary";
		if (state.kind === "notebook")
			return `${state.cells?.length ?? 0} cells${state.size !== undefined ? ` · ${formatSize(state.size)}` : ""}`;
		if (state.kind === "text")
			return `${state.totalLines ?? 0} lines${state.size !== undefined ? ` · ${formatSize(state.size)}` : ""}`;
		return "";
	}
}
