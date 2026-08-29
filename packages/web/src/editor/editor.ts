/**
 * Editor: multi-line textarea with queueing, slash commands, @-files,
 * shell mode, image paste, and autocomplete.
 */

import { h } from "../dom.ts";
import { fuzzyFilter } from "../fuzz.ts";
import type { ImageContent, RpcSlashCommandUi } from "../types.ts";

export interface BuiltinCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: "Quit pi" },
];

export interface EditorSubmitEvent {
	text: string;
	images: ImageContent[];
	mode: "prompt" | "steer" | "followUp" | "bash" | "bashHidden";
	bashCommand?: string;
}

export interface EditorOptions {
	isStreaming: () => boolean;
	submit: (event: EditorSubmitEvent) => void;
	onEscape: () => void;
	onClear: () => void;
	searchFiles: (query: string) => Promise<string[]>;
	commands: () => RpcSlashCommandUi[];
}

interface Attachment {
	data: string;
	mimeType: string;
}

interface AutocompleteEntry {
	label: string;
	description?: string;
	source: string;
	insert: (textarea: HTMLTextAreaElement) => void;
}

export class EditorController {
	readonly element: HTMLElement;
	readonly textarea: HTMLTextAreaElement;
	private readonly options: EditorOptions;
	private attachments: Attachment[] = [];
	private autocompleteEntries: AutocompleteEntry[] = [];
	private autocompleteIndex = 0;
	private autocompleteActive = false;
	private searchDebounce: ReturnType<typeof setTimeout> | undefined;
	private autocompleteElement: HTMLElement;

	constructor(options: EditorOptions) {
		this.options = options;
		this.textarea = h("textarea", {
			placeholder: "Message pi… (Enter to send, / for commands, @ for files, ! for shell)",
		}) as HTMLTextAreaElement;
		this.autocompleteElement = h("div", { class: "autocomplete", style: "display:none" });
		this.element = h(
			"div",
			{ class: "editor-container" },
			h("div", { class: "attachments-bar" }),
			this.textarea,
			this.autocompleteElement,
		);
		this.wireEvents();
	}

	setText(text: string): void {
		this.textarea.value = text;
		this.autoSize();
		this.textarea.focus();
	}

	getText(): string {
		return this.textarea.value;
	}

	clear(): void {
		this.textarea.value = "";
		this.attachments = [];
		this.renderAttachments();
		this.hideAutocomplete();
		this.autoSize();
	}

	restoreQueue(messages: string[]): void {
		this.setText(messages.join("\n"));
	}

	addAttachment(data: string, mimeType: string): void {
		this.attachments.push({ data, mimeType });
		this.renderAttachments();
	}

	getAttachments(): ImageContent[] {
		return this.attachments.map((attachment) => ({
			type: "image" as const,
			data: attachment.data,
			mimeType: attachment.mimeType,
		}));
	}

	focus(): void {
		this.textarea.focus();
	}

	// ------------------------------------------------------------------

	private wireEvents(): void {
		this.textarea.addEventListener("input", () => {
			this.autoSize();
			this.updateAutocomplete();
		});
		this.textarea.addEventListener("paste", (event) => {
			this.handlePaste(event);
		});
		this.textarea.addEventListener("dragover", (event) => {
			event.preventDefault();
		});
		this.textarea.addEventListener("drop", (event) => {
			this.handleDrop(event);
		});
		this.textarea.addEventListener("keydown", (event) => {
			this.handleKeydown(event);
		});
	}

	private autoSize(): void {
		this.textarea.style.height = "auto";
		this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, window.innerHeight * 0.4)}px`;
	}

	private handlePaste(event: ClipboardEvent): void {
		const items = event.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					event.preventDefault();
					void this.addImageFile(file);
				}
			}
		}
	}

	private handleDrop(event: DragEvent): void {
		const files = event.dataTransfer?.files;
		if (!files) return;
		let handled = false;
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				event.preventDefault();
				void this.addImageFile(file);
				handled = true;
			}
		}
		if (!handled && files.length === 1) {
			const file = files[0]!;
			event.preventDefault();
			this.setText(`${this.textarea.value}${this.textarea.value ? " " : ""}@${file.name ?? ""}`);
		}
	}

	private async addImageFile(file: File): Promise<void> {
		const data = await fileToBase64(file);
		if (data) {
			this.addAttachment(data, file.type || "image/png");
		}
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (this.autocompleteActive) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				this.moveAutocomplete(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				this.moveAutocomplete(-1);
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.altKey)) {
				event.preventDefault();
				this.applyAutocomplete();
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.hideAutocomplete();
				return;
			}
		}

		if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
			if (event.altKey) {
				event.preventDefault();
				this.submitCurrent("followUp");
			} else {
				event.preventDefault();
				this.submitCurrent(this.options.isStreaming() ? "steer" : "prompt");
			}
			return;
		}
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
			event.preventDefault();
			this.submitCurrent("prompt");
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.options.onEscape();
			return;
		}
		if (event.key === "c" && event.ctrlKey && !event.shiftKey) {
			event.preventDefault();
			this.options.onClear();
			this.clear();
			return;
		}
		if (event.key === "d" && event.ctrlKey && this.textarea.value === "") {
			event.preventDefault();
			this.options.onEscape();
			return;
		}
		if (event.key === "Tab") {
			event.preventDefault();
			this.tabCompletePath();
		}
	}

	private submitCurrent(mode: EditorSubmitEvent["mode"]): void {
		const text = this.textarea.value.trim();
		if (!text && this.attachments.length === 0) return;

		if (text.startsWith("!!")) {
			const command = text.slice(2).trim();
			if (command) {
				this.options.submit({
					text,
					images: this.getAttachments(),
					mode: "bashHidden",
					bashCommand: command,
				});
				this.clear();
			}
			return;
		}
		if (text.startsWith("!")) {
			const command = text.slice(1).trim();
			if (command) {
				this.options.submit({
					text,
					images: this.getAttachments(),
					mode: "bash",
					bashCommand: command,
				});
				this.clear();
			}
			return;
		}

		this.options.submit({ text, images: this.getAttachments(), mode });
		this.clear();
	}

	// ------------------------------------------------------------------
	// Autocomplete
	// ------------------------------------------------------------------

	private updateAutocomplete(): void {
		const value = this.textarea.value;
		const caret = this.textarea.selectionStart;
		const beforeCaret = value.slice(0, caret);

		const slashMatch = /(?:^|\s)\/([\w:-]*)$/.exec(beforeCaret);
		if (slashMatch) {
			this.showCommandAutocomplete(slashMatch[1] ?? "");
			return;
		}

		const atMatch = /(?:^|\s)@([\w/.-]*)$/.exec(beforeCaret);
		if (atMatch) {
			this.showFileAutocomplete(atMatch[1] ?? "");
			return;
		}

		this.hideAutocomplete();
	}

	private showCommandAutocomplete(query: string): void {
		const entries: AutocompleteEntry[] = [];
		const effectiveQuery = query.startsWith("/") ? query.slice(1) : query;

		const all = [
			...BUILTIN_COMMANDS.map((command) => ({
				label: `/${command.name}`,
				description: command.description,
				source: "builtin",
				argumentHint: command.argumentHint,
			})),
			...this.options.commands().map((command) => ({
				label: `/${command.name}`,
				description: command.description,
				source: command.source,
				argumentHint: undefined,
			})),
		];

		const matches = fuzzyFilter(all, effectiveQuery, (item) => item.label);
		for (const match of matches.slice(0, 12)) {
			const label = match.item.label;
			entries.push({
				label,
				description: match.item.description,
				source: match.item.source,
				insert: (textarea) => {
					replaceTokenBeforeCaret(textarea, /\/?[\w:/-]*$/, label);
				},
			});
		}

		this.showAutocomplete(entries);
	}

	private showFileAutocomplete(query: string): void {
		if (this.searchDebounce) clearTimeout(this.searchDebounce);
		this.searchDebounce = setTimeout(() => {
			void this.options.searchFiles(query).then((files) => {
				const entries: AutocompleteEntry[] = files.slice(0, 12).map((file) => ({
					label: file,
					description: "",
					source: "file",
					insert: (textarea) => {
						replaceTokenBeforeCaret(textarea, /@[\w/.-]*$/, `@${file}`);
					},
				}));
				this.showAutocomplete(entries);
			});
		}, 150);
	}

	private tabCompletePath(): void {
		const caret = this.textarea.selectionStart;
		const beforeCaret = this.textarea.value.slice(0, caret);
		const pathMatch = /(?:^|\s)([\w/.-]+)$/.exec(beforeCaret);
		if (!pathMatch) return;
		const query = pathMatch[1]!;
		void this.options.searchFiles(query).then((files) => {
			if (files.length === 0) return;
			const file = files[0]!;
			const replaced = beforeCaret.replace(
				/(?:^|\s)([\w/.-]+)$/,
				(full) => full.slice(0, full.length - query.length) + file,
			);
			const after = this.textarea.value.slice(caret);
			this.textarea.value = replaced + after;
			const newCaret = replaced.length;
			this.textarea.setSelectionRange(newCaret, newCaret);
		});
	}

	private showAutocomplete(entries: AutocompleteEntry[]): void {
		this.autocompleteEntries = entries;
		this.autocompleteIndex = 0;
		this.autocompleteActive = entries.length > 0;

		while (this.autocompleteElement.firstChild) {
			this.autocompleteElement.removeChild(this.autocompleteElement.firstChild);
		}
		if (entries.length === 0) {
			this.autocompleteElement.appendChild(h("div", { class: "autocomplete-empty" }, "No matches"));
		}
		for (const [index, entry] of entries.entries()) {
			const item = h(
				"div",
				{ class: `autocomplete-item${index === 0 ? " selected" : ""}` },
				h("span", { class: "ac-name" }, entry.label),
				h("span", { class: "ac-desc" }, entry.description ?? ""),
				h("span", { class: "ac-source" }, entry.source),
			);
			item.addEventListener("click", () => {
				this.autocompleteIndex = index;
				this.applyAutocomplete();
			});
			this.autocompleteElement.appendChild(item);
		}
		this.autocompleteElement.style.display = "block";
	}

	private hideAutocomplete(): void {
		this.autocompleteActive = false;
		this.autocompleteEntries = [];
		this.autocompleteElement.style.display = "none";
	}

	private moveAutocomplete(delta: number): void {
		if (this.autocompleteEntries.length === 0) return;
		this.autocompleteIndex =
			(this.autocompleteIndex + delta + this.autocompleteEntries.length) % this.autocompleteEntries.length;
		const items = this.autocompleteElement.querySelectorAll(".autocomplete-item");
		items.forEach((item, index) => {
			item.classList.toggle("selected", index === this.autocompleteIndex);
		});
		const selected = items[this.autocompleteIndex];
		if (selected instanceof HTMLElement) {
			selected.scrollIntoView({ block: "nearest" });
		}
	}

	private applyAutocomplete(): void {
		const entry = this.autocompleteEntries[this.autocompleteIndex];
		if (!entry) {
			this.hideAutocomplete();
			return;
		}
		entry.insert(this.textarea);
		this.hideAutocomplete();
		this.autoSize();
		this.textarea.focus();
	}

	private renderAttachments(): void {
		const bar = this.element.querySelector(".attachments-bar");
		if (!(bar instanceof HTMLElement)) return;
		while (bar.firstChild) {
			bar.removeChild(bar.firstChild);
		}
		for (const [index, attachment] of this.attachments.entries()) {
			const chip = h(
				"div",
				{ class: "attachment-chip" },
				h("img", { src: `data:${attachment.mimeType};base64,${attachment.data}`, alt: "attachment" }),
				h("button", { onclick: () => this.removeAttachment(index) }, "×"),
			);
			bar.appendChild(chip);
		}
	}

	private removeAttachment(index: number): void {
		this.attachments.splice(index, 1);
		this.renderAttachments();
	}
}

function replaceTokenBeforeCaret(textarea: HTMLTextAreaElement, tokenPattern: RegExp, replacement: string): void {
	const caret = textarea.selectionStart;
	const before = textarea.value.slice(0, caret);
	const after = textarea.value.slice(caret);
	const replaced = before.replace(tokenPattern, replacement);
	textarea.value = replaced + after;
	const newCaret = replaced.length;
	textarea.setSelectionRange(newCaret, newCaret);
}

async function fileToBase64(file: File): Promise<string | undefined> {
	try {
		const buffer = await file.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		let binary = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		return btoa(binary);
	} catch {
		return undefined;
	}
}
