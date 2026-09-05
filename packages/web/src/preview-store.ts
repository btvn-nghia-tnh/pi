/**
 * App-level preview state for the file preview panel. Deliberately outside
 * the per-session Store: the panel survives session switches and any
 * session's transcript can drive it. Holds one tab per opened file
 * (VSCode-style); every `open` mints a fresh tab id, so responses that
 * address a previous generation of a tab are dropped by the setters.
 */

import type { DocumentBlock, NotebookCell, ReadFileData, SpreadsheetSheet } from "./types.ts";

export interface PreviewState {
	/** Tab id; changes every time the tab is re-opened (refresh). */
	id: string;
	/** Raw path as clicked (relative paths resolve server-side against the session cwd). */
	path: string;
	/** Session whose transcript was clicked; used to route read_file. */
	sessionId: string | undefined;
	status: "loading" | "ready" | "error";
	kind?: "text" | "image" | "unsupported" | "notebook" | "spreadsheet" | "document";
	/** text kind */
	text?: string;
	/** image kind */
	imageSrc?: string;
	/** notebook kind */
	cells?: NotebookCell[];
	/** spreadsheet kind */
	sheets?: SpreadsheetSheet[];
	/** document kind */
	blocks?: DocumentBlock[];
	mimeType?: string;
	size?: number;
	totalLines?: number;
	shownLines?: number;
	truncated?: boolean;
	truncatedBy?: string;
	error?: string;
}

export type PreviewListener = () => void;

export class PreviewStore {
	private tabs: PreviewState[] = [];
	private activeId: string | undefined;
	private readonly listeners = new Set<PreviewListener>();
	private tabCounter = 0;

	/** The active tab (what the panel body renders). */
	getState(): PreviewState | undefined {
		return this.tabs.find((tab) => tab.id === this.activeId);
	}

	/** All open tabs, oldest first. */
	getTabs(): PreviewState[] {
		return this.tabs;
	}

	/** Look up a tab by id (drops to undefined once the id was superseded). */
	getTab(id: string): PreviewState | undefined {
		return this.tabs.find((tab) => tab.id === id);
	}

	subscribe(listener: PreviewListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Open (or refresh) a tab for `path` and activate it. Re-opening an
	 * existing path mints a new tab id, so stale responses for the previous
	 * generation no longer address it. Returns the tab id to address
	 * follow-up responses with.
	 */
	open(path: string, sessionId: string | undefined): string {
		const id = this.nextTabId();
		const existingIndex = this.tabs.findIndex((tab) => tab.path === path);
		if (existingIndex >= 0) {
			this.tabs[existingIndex] = { id, path, sessionId, status: "loading" };
		} else {
			this.tabs.push({ id, path, sessionId, status: "loading" });
		}
		this.activeId = id;
		this.emit();
		return id;
	}

	activate(id: string): void {
		if (this.activeId === id || !this.tabs.some((tab) => tab.id === id)) return;
		this.activeId = id;
		this.emit();
	}

	/** Close the active tab (Esc); activates the neighbor, VSCode-style. */
	close(): void {
		if (this.activeId === undefined) return;
		this.closeTab(this.activeId);
	}

	/** Close a specific tab; the active tab stays active unless it was closed. */
	closeTab(id: string): void {
		const index = this.tabs.findIndex((tab) => tab.id === id);
		if (index < 0) return;
		this.tabs.splice(index, 1);
		if (this.activeId === id) {
			// Neighbor preference: the tab to the left, else the one that
			// shifted into place; when the strip empties, the panel hides.
			this.activeId = this.tabs[Math.max(0, index - 1)]?.id;
		}
		this.emit();
	}

	/** Replace content with the first text chunk. */
	setText(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "loading") return;
		this.patch(tab, {
			status: "ready",
			kind: "text",
			text: data.text ?? "",
			totalLines: data.totalLines,
			shownLines: data.shownLines,
			truncated: data.truncated,
			truncatedBy: data.truncatedBy ?? undefined,
			size: data.size,
			error: undefined,
		});
	}

	/** Append a follow-up text chunk (Load more). */
	appendText(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "ready" || tab.kind !== "text") return;
		this.patch(tab, {
			text: `${tab.text ?? ""}\n${data.text ?? ""}`,
			totalLines: data.totalLines,
			shownLines: data.shownLines,
			truncated: data.truncated,
			truncatedBy: data.truncatedBy ?? undefined,
		});
	}

	setImage(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "loading") return;
		this.patch(tab, {
			status: "ready",
			kind: "image",
			imageSrc: `data:${data.mimeType ?? "application/octet-stream"};base64,${data.data ?? ""}`,
			mimeType: data.mimeType,
			size: data.size,
			error: undefined,
		});
	}

	setUnsupported(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "loading") return;
		this.patch(tab, {
			status: "ready",
			kind: "unsupported",
			size: data.size,
			mimeType: data.mimeType,
			truncated: data.reason === "too-large",
			error: undefined,
		});
	}

	setNotebook(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "loading") return;
		this.patch(tab, {
			status: "ready",
			kind: "notebook",
			cells: data.cells ?? [],
			size: data.size,
			error: undefined,
		});
	}

	setSpreadsheet(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "loading") return;
		this.patch(tab, {
			status: "ready",
			kind: "spreadsheet",
			sheets: data.sheets ?? [],
			size: data.size,
			error: undefined,
		});
	}

	setDocument(data: ReadFileData, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab || tab.status !== "loading") return;
		this.patch(tab, {
			status: "ready",
			kind: "document",
			blocks: data.blocks ?? [],
			size: data.size,
			error: undefined,
		});
	}

	setError(message: string, tabId: string): void {
		const tab = this.getTab(tabId);
		if (!tab) return;
		this.patch(tab, { status: "error", error: message });
	}

	private patch(tab: PreviewState, changes: Partial<PreviewState>): void {
		this.tabs = this.tabs.map((candidate) => (candidate.id === tab.id ? { ...tab, ...changes } : candidate));
		this.emit();
	}

	private nextTabId(): string {
		this.tabCounter++;
		return `tab-${this.tabCounter}`;
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
