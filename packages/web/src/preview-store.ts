/**
 * App-level preview state for the file preview panel. Deliberately outside
 * the per-session Store: the panel survives session switches and any
 * session's transcript can drive it.
 */

import type { ReadFileData } from "./types.ts";

export interface PreviewState {
	/** Raw path as clicked (relative paths resolve server-side against the session cwd). */
	path: string;
	/** Session whose transcript was clicked; used to route read_file. */
	sessionId: string | undefined;
	status: "loading" | "ready" | "error";
	kind?: "text" | "image" | "unsupported";
	/** text kind */
	text?: string;
	/** image kind */
	imageSrc?: string;
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
	private state: PreviewState | undefined;
	private readonly listeners = new Set<PreviewListener>();

	getState(): PreviewState | undefined {
		return this.state;
	}

	subscribe(listener: PreviewListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Start previewing a path (loading state until the fetch resolves). */
	open(path: string, sessionId: string | undefined): void {
		this.set({ path, sessionId, status: "loading" });
	}

	/** Replace content with the first text chunk. */
	setText(data: ReadFileData): void {
		const current = this.state;
		if (!current || current.status !== "loading") return;
		this.set({
			...current,
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
	appendText(data: ReadFileData): void {
		const current = this.state;
		if (!current || current.status !== "ready" || current.kind !== "text") return;
		this.set({
			...current,
			text: `${current.text ?? ""}\n${data.text ?? ""}`,
			totalLines: data.totalLines,
			shownLines: data.shownLines,
			truncated: data.truncated,
			truncatedBy: data.truncatedBy ?? undefined,
		});
	}

	setImage(data: ReadFileData): void {
		const current = this.state;
		if (!current || current.status !== "loading") return;
		this.set({
			...current,
			status: "ready",
			kind: "image",
			imageSrc: `data:${data.mimeType ?? "application/octet-stream"};base64,${data.data ?? ""}`,
			mimeType: data.mimeType,
			size: data.size,
			error: undefined,
		});
	}

	setUnsupported(data: ReadFileData): void {
		const current = this.state;
		if (!current || current.status !== "loading") return;
		this.set({
			...current,
			status: "ready",
			kind: "unsupported",
			size: data.size,
			mimeType: data.mimeType,
			truncated: data.reason === "too-large",
			error: undefined,
		});
	}

	setError(message: string): void {
		const current = this.state;
		if (!current) return;
		this.set({ ...current, status: "error", error: message });
	}

	close(): void {
		this.set(undefined);
	}

	private set(next: PreviewState | undefined): void {
		this.state = next;
		for (const listener of this.listeners) {
			listener();
		}
	}
}
