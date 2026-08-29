/**
 * Dialog framework with an Esc stack, plus the concrete dialogs:
 * model/thinking selectors, session picker, tree, settings, themes,
 * extension UI, trust, login, share/import/export, info viewers.
 */

import type { PiConnection } from "./connection.ts";
import { h } from "./dom.ts";
import { fuzzyFilter } from "./fuzz.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Store } from "./state.ts";
import type {
	RpcKeybindingsPayload,
	RpcSessionSummary,
	RpcSettingsSnapshot,
	RpcThemeInfo,
	RpcTrustState,
} from "./types.ts";

export interface DialogHandle {
	close: () => void;
	element: HTMLElement;
}

export class DialogStack {
	private readonly stack: DialogHandle[] = [];

	private readonly container: HTMLElement;

	constructor(container: HTMLElement) {
		this.container = container;
	}

	open(builder: (close: () => void) => HTMLElement): DialogHandle {
		const overlay = h("div", { class: "dialog-overlay" });
		const close = () => {
			this.closeHandle(handle);
		};
		const handle: DialogHandle = {
			close,
			element: builder(close),
		};
		overlay.appendChild(handle.element);
		overlay.addEventListener("mousedown", (event) => {
			if (event.target === overlay) close();
		});
		overlay.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		});
		overlay.tabIndex = -1;
		this.container.appendChild(overlay);
		this.stack.push(handle);
		overlay.focus();
		const focusable = handle.element.querySelector("input, textarea, select, button, [tabindex]");
		if (focusable instanceof HTMLElement) focusable.focus();
		return handle;
	}

	private closeHandle(handle: DialogHandle): void {
		const index = this.stack.indexOf(handle);
		if (index === -1) return;
		this.stack.splice(index, 1);
		handle.element.parentElement?.remove();
		if (this.stack.length === 0) {
			// Return focus to the editor, matching the TUI behavior where
			// closing a dialog restores editor focus.
			const editor = document.querySelector("#app textarea");
			if (editor instanceof HTMLElement) {
				editor.focus();
			}
		}
	}

	closeTop(): boolean {
		if (this.stack.length === 0) return false;
		this.stack[this.stack.length - 1]!.close();
		return true;
	}

	isOpen(): boolean {
		return this.stack.length > 0;
	}
}

interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: { input?: number; output?: number };
}

export function openModelSelector(
	dialogs: DialogStack,
	connection: PiConnection,
	options: { onSaveDefault?: () => void },
): void {
	dialogs.open((close) => {
		const list = h("div", {});
		const search = h("input", {
			type: "text",
			placeholder: "Search models…",
			class: "dialog-search",
		}) as HTMLInputElement;
		let models: ModelInfo[] = [];
		let selected = 0;

		const render = () => {
			const query = search.value;
			const matches = fuzzyFilter(models, query, (model) => `${model.provider}/${model.id}`);
			while (list.firstChild) list.removeChild(list.firstChild);
			const visible = matches.slice(0, 40);
			selected = Math.min(selected, Math.max(0, visible.length - 1));
			for (const [index, match] of visible.entries()) {
				const model = match.item;
				const cost =
					model.cost?.input !== undefined && model.cost.output !== undefined
						? ` $${model.cost.input}/${model.cost.output}/M`
						: "";
				const row = h(
					"div",
					{ class: `list-item${index === selected ? " selected" : ""}` },
					h("span", { class: "item-label" }, `${model.provider}/${model.id}${model.reasoning ? " ✻" : ""}`),
					h(
						"span",
						{ class: "item-meta" },
						`${model.contextWindow ? Math.round(model.contextWindow / 1000) : "?"}k${cost}`,
					),
				);
				row.addEventListener("click", () => {
					void connection
						.request({ type: "set_model", provider: model.provider, modelId: model.id })
						.then(() => close())
						.catch(() => {});
				});
				list.appendChild(row);
			}
		};

		search.addEventListener("input", () => {
			selected = 0;
			render();
		});
		search.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				const rows = list.querySelectorAll(".list-item");
				selected = (selected + delta + rows.length) % Math.max(1, rows.length);
				render();
			} else if (event.key === "Enter") {
				event.preventDefault();
				const rows = list.querySelectorAll(".list-item");
				const row = rows[selected];
				if (row instanceof HTMLElement) row.click();
			} else if (event.key === "c" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
				event.preventDefault();
				options.onSaveDefault?.();
			}
		});

		void connection.request<{ models: ModelInfo[] }>({ type: "get_available_models" }).then((data) => {
			models = data.models ?? [];
			render();
		});

		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Select model (Ctrl+S to save as default)"),
			h(
				"div",
				{ class: "dialog-body" },
				search,
				list,
				h(
					"div",
					{ class: "dialog-footer-hint", style: "color: var(--color-dim); font-size: 11px; margin-top:6px" },
					"Enter selects · Esc cancels",
				),
			),
			h(
				"div",
				{ class: "dialog-footer" },
				h(
					"button",
					{
						onclick: () => {
							options.onSaveDefault?.();
						},
					},
					"Save default (Ctrl+S)",
				),
				h("button", { onclick: close }, "Close"),
			),
		);
	});
}

export function openThinkingSelector(
	dialogs: DialogStack,
	connection: PiConnection,
	options: { onSaveDefault?: () => void },
): void {
	dialogs.open((close) => {
		const list = h("div", {});
		let levels: string[] = [];
		const selected = 0;

		const render = () => {
			while (list.firstChild) list.removeChild(list.firstChild);
			for (const [index, level] of levels.entries()) {
				const row = h(
					"div",
					{ class: `list-item${index === selected ? " selected" : ""}` },
					h("span", { class: "item-label" }, level),
				);
				row.addEventListener("click", () => {
					void connection
						.request({ type: "set_thinking_level", level: level as never })
						.then(() => close())
						.catch(() => {});
				});
				list.appendChild(row);
			}
		};

		void connection.request<{ levels: string[] }>({ type: "get_available_thinking_levels" }).then((data) => {
			levels = data.levels ?? [];
			render();
		});

		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Thinking level"),
			h("div", { class: "dialog-body", onclick: () => {} }, list),
			h(
				"div",
				{ class: "dialog-footer" },
				h("button", { onclick: () => options.onSaveDefault?.() }, "Save default"),
				h("button", { onclick: close }, "Close"),
			),
		);
	});
}

export function openSessionSelector(
	dialogs: DialogStack,
	connection: PiConnection,
	options: { onResume: (sessionPath: string) => void },
): void {
	dialogs.open((close) => {
		let sessions: RpcSessionSummary[] = [];
		let scope: "cwd" | "all" = "cwd";
		let sortMode: "modified" | "created" = "modified";
		let namedOnly = false;
		let showPaths = false;
		let selected = 0;

		const search = h("input", {
			type: "text",
			placeholder: "Search sessions…",
			class: "dialog-search",
		}) as HTMLInputElement;
		const list = h("div", {});
		const meta = h("div", { style: "color: var(--color-dim); font-size: 11px; margin-top: 6px" }, "");

		const filtered = (): RpcSessionSummary[] => {
			let result = sessions;
			if (namedOnly) {
				result = result.filter((session) => session.name);
			}
			const query = search.value;
			if (query) {
				result = fuzzyFilter(result, query, (session) => `${session.name ?? ""} ${session.firstMessage}`).map(
					(m) => m.item,
				);
			}
			result = [...result].sort((a, b) => {
				if (sortMode === "modified") return b.modified.localeCompare(a.modified);
				return b.created.localeCompare(a.created);
			});
			return result;
		};

		const render = () => {
			const visible = filtered();
			while (list.firstChild) list.removeChild(list.firstChild);
			selected = Math.min(selected, Math.max(0, visible.length - 1));
			for (const [index, session] of visible.entries()) {
				const date = new Date(session.modified);
				const label = session.name ?? (session.firstMessage.slice(0, 60) || "(empty)");
				const meta2 = showPaths ? session.file : `${session.messageCount} msgs`;
				const row = h(
					"div",
					{ class: `list-item${index === selected ? " selected" : ""}` },
					h("span", { class: "item-label" }, label),
					h("span", { class: "item-meta" }, `${meta2} · ${date.toLocaleDateString()}`),
				);
				row.addEventListener("click", () => {
					options.onResume(session.file);
					close();
				});
				row.addEventListener("dblclick", () => {});
				list.appendChild(row);
			}
			meta.textContent = `${visible.length} sessions · sort: ${sortMode} · scope: ${scope}${namedOnly ? " · named only" : ""}`;
		};

		const load = () => {
			void connection.request<{ sessions: RpcSessionSummary[] }>({ type: "list_sessions", scope }).then((data) => {
				sessions = data.sessions ?? [];
				render();
			});
		};

		search.addEventListener("input", () => {
			selected = 0;
			render();
		});
		search.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				const rows = list.querySelectorAll(".list-item");
				selected = (selected + delta + rows.length) % Math.max(1, rows.length);
				render();
			} else if (event.key === "Enter") {
				event.preventDefault();
				const rows = list.querySelectorAll(".list-item");
				const row = rows[selected];
				if (row instanceof HTMLElement) row.click();
			} else if (event.key === "r" && (event.ctrlKey || event.metaKey)) {
				const visible = filtered();
				const session = visible[selected];
				if (session) {
					const input = window.prompt("New session name", session.name ?? "");
					if (input) {
						void connection
							.request({ type: "rename_session", sessionPath: session.file, name: input })
							.then(load);
					}
				}
			} else if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
				sortMode = sortMode === "modified" ? "created" : "modified";
				render();
			} else if (event.key === "n" && event.altKey) {
				namedOnly = !namedOnly;
				render();
			} else if (event.key === "p" && (event.ctrlKey || event.metaKey)) {
				showPaths = !showPaths;
				render();
			} else if (event.key === "d" && (event.ctrlKey || event.metaKey)) {
				const visible = filtered();
				const session = visible[selected];
				if (session && window.confirm(`Delete session ${session.name ?? session.id}?`)) {
					void connection.request({ type: "delete_session", sessionPath: session.file }).then(load);
				}
			}
		});

		load();

		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Resume session"),
			h(
				"div",
				{ class: "dialog-body" },
				search,
				list,
				meta,
				h(
					"div",
					{ style: "color: var(--color-dim); font-size: 11px; margin-top: 6px" },
					"Ctrl+S sort · Ctrl+R rename · Ctrl+D delete · Alt+N named only · Ctrl+P paths",
				),
			),
			h(
				"div",
				{ class: "dialog-footer" },
				h(
					"button",
					{
						onclick: () => {
							scope = scope === "cwd" ? "all" : "cwd";
							load();
						},
					},
					"Toggle scope",
				),
				h("button", { onclick: close }, "Close"),
			),
		);
	});
}

export function openChangelog(dialogs: DialogStack, connection: PiConnection): void {
	dialogs.open((close) => {
		const body = h("div", { class: "changelog-body" });
		void connection.request<{ markdown: string }>({ type: "get_changelog" }).then((data) => {
			body.innerHTML = renderMarkdown(data.markdown ?? "");
		});
		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Changelog"),
			h("div", { class: "dialog-body" }, body),
			h("div", { class: "dialog-footer" }, h("button", { class: "primary", onclick: close }, "Close")),
		);
	});
}

export function openHotkeys(dialogs: DialogStack, keybindings: RpcKeybindingsPayload | undefined): void {
	dialogs.open((close) => {
		const table = h("table", { class: "hotkeys-table" });
		for (const binding of keybindings?.bindings ?? []) {
			if (!binding.description) continue;
			table.appendChild(
				h("tr", {}, h("td", {}, binding.keys.map((key) => key).join(", ")), h("td", {}, binding.description)),
			);
		}
		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Keyboard shortcuts"),
			h("div", { class: "dialog-body" }, table),
			h("div", { class: "dialog-footer" }, h("button", { class: "primary", onclick: close }, "Close")),
		);
	});
}

export function openThemeSelector(dialogs: DialogStack, connection: PiConnection, store: Store): void {
	dialogs.open((close) => {
		const list = h("div", {});
		let themes: RpcThemeInfo[] = [];
		let selected = 0;

		const render = () => {
			while (list.firstChild) list.removeChild(list.firstChild);
			for (const [index, theme] of themes.entries()) {
				const row = h(
					"div",
					{ class: `list-item${index === selected ? " selected" : ""}` },
					h("span", { class: "item-label" }, theme.name),
					h(
						"span",
						{ class: "item-meta" },
						h("span", { style: `color: ${theme.vars.text ?? "#888"}` }, "▮"),
						h("span", { style: `color: ${theme.vars.accent ?? "#888"}` }, "▮"),
						h("span", { style: `color: ${theme.vars.red ?? "#888"}` }, "▮"),
						h("span", { style: `color: ${theme.vars.green ?? "#888"}` }, "▮"),
					),
				);
				row.addEventListener("click", () => {
					void connection.request({ type: "set_theme", name: theme.name }).then(() => {
						store.applyThemeChanged(theme.name);
						applyThemeVars(theme.vars);
						close();
					});
				});
				list.appendChild(row);
			}
		};

		void connection.request<{ themes: RpcThemeInfo[]; current: string }>({ type: "get_themes" }).then((data) => {
			themes = data.themes ?? [];
			selected = Math.max(
				0,
				themes.findIndex((theme) => theme.name === data.current),
			);
			render();
		});

		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Theme"),
			h("div", { class: "dialog-body" }, list),
			h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Close")),
		);
	});
}

export function openTrustDialog(
	dialogs: DialogStack,
	connection: PiConnection,
	trust: RpcTrustState,
	options: { onTrusted: () => void },
): void {
	dialogs.open((close) => {
		const list = h("div", {});
		for (const [index, option] of trust.options.entries()) {
			const row = h(
				"div",
				{ class: "list-item" },
				h("span", { class: "item-label" }, option.label),
				h("span", { class: "item-meta" }, option.trusted ? "trust" : "deny"),
			);
			row.addEventListener("click", () => {
				void connection
					.request({ type: "set_trust", trusted: option.trusted, optionIndex: index })
					.then(() => {
						options.onTrusted();
						close();
					})
					.catch(() => close());
			});
			list.appendChild(row);
		}
		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Project trust"),
			h(
				"div",
				{ class: "dialog-body" },
				h(
					"p",
					{},
					`This project has local pi resources (settings, extensions, skills). Trust "${trust.trustPath}"?`,
				),
				list,
			),
			h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Not now")),
		);
	});
}

/**
 * Apply resolved theme colors to CSS custom properties. `vars` uses the
 * ThemeColor names produced by the server's getResolvedThemeColors().
 */
export function applyThemeVars(vars: Record<string, string>): void {
	const root = document.documentElement;
	const mapping: Record<string, string> = {
		text: "--color-text",
		muted: "--color-muted",
		dim: "--color-dim",
		accent: "--color-accent",
		success: "--color-success",
		error: "--color-error",
		warning: "--color-warning",
		border: "--color-border",
		borderAccent: "--color-border-accent",
		borderMuted: "--color-border-muted",
		selectedBg: "--color-selected-bg",
		userMessageBg: "--color-user-bg",
		customMessageBg: "--color-custom-bg",
		toolPendingBg: "--color-tool-pending-bg",
		toolSuccessBg: "--color-tool-success-bg",
		toolErrorBg: "--color-tool-error-bg",
		toolDiffAdded: "--color-diff-add",
		toolDiffRemoved: "--color-diff-remove",
		toolDiffContext: "--color-diff-context",
		thinkingOff: "--color-thinking-off",
		thinkingMinimal: "--color-thinking-minimal",
		thinkingLow: "--color-thinking-low",
		thinkingMedium: "--color-thinking-medium",
		thinkingHigh: "--color-thinking-high",
		thinkingXhigh: "--color-thinking-xhigh",
		thinkingMax: "--color-thinking-max",
	};
	for (const [name, cssVar] of Object.entries(mapping)) {
		const value = vars[name];
		if (value) {
			root.style.setProperty(cssVar, value);
		}
	}
	// Thinking blocks fall back to the generic thinking color.
	const thinkingFallback = vars.thinkingText ?? vars.muted;
	if (thinkingFallback) {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			const cssVar = `--color-thinking-${level}`;
			if (!vars[`thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`]) {
				root.style.setProperty(cssVar, thinkingFallback);
			}
		}
	}
	// The page background derives from the user message background, mirroring
	// the export-html derivation: light themes get a slightly darker page,
	// dark themes a slightly lighter card tone.
	const base = vars.userMessageBg;
	if (base) {
		const light = isLightColor(base);
		const pageBg = adjustBrightness(base, light ? 0.95 : 0.92);
		const cardBg = adjustBrightness(base, light ? 0.97 : 1.12);
		const codeBg = adjustBrightness(base, light ? 0.93 : 0.8);
		root.style.setProperty("--color-page-bg", pageBg);
		root.style.setProperty("--color-card-bg", cardBg);
		root.style.setProperty("--color-code-bg", codeBg);
		// Light palettes from the server can be too faint for hairline
		// separators; derive a stronger border tone for them.
		if (light) {
			const borderMuted = vars.borderMuted;
			if (!borderMuted || isLightColor(borderMuted)) {
				root.style.setProperty("--color-border-muted", adjustBrightness(base, 0.72));
			}
			const dim = vars.dim;
			if (!dim || isLightColor(dim)) {
				root.style.setProperty("--color-dim", adjustBrightness(base, 0.55));
			}
		}
	}
}

function parseHex(color: string): { r: number; g: number; b: number } | undefined {
	const match = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (!match) return undefined;
	return {
		r: Number.parseInt(match[1]!, 16),
		g: Number.parseInt(match[2]!, 16),
		b: Number.parseInt(match[3]!, 16),
	};
}

function isLightColor(color: string): boolean {
	const rgb = parseHex(color);
	if (!rgb) return true;
	return (rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722) / 255 > 0.5;
}

function adjustBrightness(color: string, factor: number): string {
	const rgb = parseHex(color);
	if (!rgb) return color;
	const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * factor)));
	return `rgb(${channel(rgb.r)}, ${channel(rgb.g)}, ${channel(rgb.b)})`;
}

/** Extension UI dialogs (select/confirm/input/editor) and auth prompts. */
export function openExtensionUiDialog(
	dialogs: DialogStack,
	request: {
		id: string;
		method: string;
		title?: string;
		message?: string;
		options?: Array<{ id: string; label: string; description?: string }>;
		placeholder?: string;
		prefill?: string;
		promptType?: string;
	},
	respond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void,
): void {
	const method = request.method;
	if (method === "auth_prompt" && request.promptType === "select") {
		dialogs.open((close) => {
			const list = h("div", {});
			for (const option of request.options ?? []) {
				const row = h(
					"div",
					{ class: "list-item" },
					h("span", { class: "item-label" }, option.label),
					h("span", { class: "item-meta" }, option.description ?? ""),
				);
				row.addEventListener("click", () => {
					respond({ value: option.id });
					close();
				});
				list.appendChild(row);
			}
			return h(
				"div",
				{ class: "dialog" },
				h("div", { class: "dialog-title" }, request.title ?? request.message ?? "Select"),
				h("div", { class: "dialog-body" }, list),
			);
		});
		return;
	}

	if (method === "select") {
		dialogs.open((close) => {
			const list = h("div", {});
			for (const option of request.options ?? []) {
				const row = h("div", { class: "list-item" }, h("span", { class: "item-label" }, option.label));
				row.addEventListener("click", () => {
					respond({ value: option.label });
					close();
				});
				list.appendChild(row);
			}
			return h(
				"div",
				{ class: "dialog" },
				h("div", { class: "dialog-title" }, request.title ?? "Select"),
				h("div", { class: "dialog-body" }, list),
			);
		});
		return;
	}

	if (method === "confirm") {
		dialogs.open((close) => {
			return h(
				"div",
				{ class: "dialog" },
				h("div", { class: "dialog-title" }, request.title ?? "Confirm"),
				h("div", { class: "dialog-body" }, h("p", {}, request.message ?? "")),
				h(
					"div",
					{ class: "dialog-footer" },
					h(
						"button",
						{
							class: "primary",
							onclick: () => {
								respond({ confirmed: true });
								close();
							},
						},
						"Yes",
					),
					h(
						"button",
						{
							onclick: () => {
								respond({ confirmed: false });
								close();
							},
						},
						"No",
					),
				),
			);
		});
		return;
	}

	if (method === "input" || method === "auth_prompt") {
		dialogs.open((close) => {
			const input = h("input", {
				type: request.promptType === "secret" ? "password" : "text",
				placeholder: request.placeholder ?? "",
			}) as HTMLInputElement;
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					respond({ value: input.value });
					close();
				}
			});
			return h(
				"div",
				{ class: "dialog" },
				h("div", { class: "dialog-title" }, request.title ?? request.message ?? "Input"),
				h("div", { class: "dialog-body" }, h("p", {}, request.message ?? ""), input),
				h(
					"div",
					{ class: "dialog-footer" },
					h(
						"button",
						{
							class: "primary",
							onclick: () => {
								respond({ value: input.value });
								close();
							},
						},
						"OK",
					),
					h(
						"button",
						{
							onclick: () => {
								respond({ cancelled: true });
								close();
							},
						},
						"Cancel",
					),
				),
			);
		});
		return;
	}

	if (method === "editor") {
		dialogs.open((close) => {
			const textarea = h("textarea", {}) as HTMLTextAreaElement;
			textarea.value = request.prefill ?? "";
			textarea.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					respond({ value: textarea.value });
					close();
				}
			});
			return h(
				"div",
				{ class: "dialog" },
				h("div", { class: "dialog-title" }, request.title ?? "Edit"),
				h("div", { class: "dialog-body" }, textarea),
				h(
					"div",
					{ class: "dialog-footer" },
					h(
						"button",
						{
							class: "primary",
							onclick: () => {
								respond({ value: textarea.value });
								close();
							},
						},
						"OK (Ctrl+Enter)",
					),
					h(
						"button",
						{
							onclick: () => {
								respond({ cancelled: true });
								close();
							},
						},
						"Cancel",
					),
				),
			);
		});
	}
}

/** Auth events: show URL, device code, info, progress inside a dialog. */
export function openAuthEventDialog(
	dialogs: DialogStack,
	event: {
		event?: string;
		url?: string;
		instructions?: string;
		userCode?: string;
		verificationUri?: string;
		message?: string;
		links?: Array<{ url: string; label?: string }>;
	},
): void {
	dialogs.open((close) => {
		const body = h("div", { class: "dialog-body" });
		if (event.event === "auth_url" && event.url) {
			body.appendChild(h("p", {}, event.instructions ?? "Open this URL to authenticate:"));
			body.appendChild(h("p", {}, h("a", { href: event.url, target: "_blank", rel: "noopener" }, event.url)));
		} else if (event.event === "device_code" && event.userCode) {
			body.appendChild(h("p", {}, `Enter code ${event.userCode} at ${event.verificationUri ?? ""}`));
			body.appendChild(h("p", {}, "Waiting for authentication…"));
		} else if (event.message) {
			body.appendChild(h("p", {}, event.message));
			for (const link of event.links ?? []) {
				body.appendChild(
					h("p", {}, h("a", { href: link.url, target: "_blank", rel: "noopener" }, link.label ?? link.url)),
				);
			}
		}
		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Provider login"),
			body,
			h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Dismiss")),
		);
	});
}

/** Settings dialog over the settings snapshot. */
export function openSettingsDialog(dialogs: DialogStack, connection: PiConnection, store: Store): void {
	dialogs.open((close) => {
		const grid = h("div", { class: "settings-grid" });
		let snapshot: RpcSettingsSnapshot | undefined;
		let scope: "global" | "project" = "global";
		const setScope = (next: "global" | "project"): void => {
			scope = next;
		};

		const editable: Array<{
			key: string;
			label: string;
			kind: "boolean" | "number" | "string" | "select" | "paths" | "button";
			options?: string[];
			buttonText?: string;
		}> = [
			{ key: "theme", label: "Theme", kind: "button", buttonText: "Choose…" },
			{ key: "steeringMode", label: "Steering mode", kind: "select", options: ["all", "one-at-a-time"] },
			{ key: "followUpMode", label: "Follow-up mode", kind: "select", options: ["all", "one-at-a-time"] },
			{
				key: "transport",
				label: "Transport",
				kind: "select",
				options: ["auto", "sse", "websocket", "websocket-cached"],
			},
			{ key: "httpIdleTimeoutMs", label: "HTTP idle timeout (ms)", kind: "number" },
			{ key: "hideThinkingBlock", label: "Hide thinking blocks", kind: "boolean" },
			{ key: "showCacheMissNotices", label: "Cache miss notices", kind: "boolean" },
			{ key: "quietStartup", label: "Quiet startup", kind: "boolean" },
			{ key: "collapseChangelog", label: "Collapse changelog", kind: "boolean" },
			{ key: "enableInstallTelemetry", label: "Install telemetry", kind: "boolean" },
			{ key: "enableAnalytics", label: "Analytics", kind: "boolean" },
			{
				key: "defaultProjectTrust",
				label: "Default project trust",
				kind: "select",
				options: ["ask", "always", "never"],
			},
			{
				key: "doubleEscapeAction",
				label: "Double-escape action",
				kind: "select",
				options: ["tree", "fork", "none"],
			},
			{
				key: "treeFilterMode",
				label: "Tree filter mode",
				kind: "select",
				options: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{ key: "editorPaddingX", label: "Editor padding X", kind: "number" },
			{ key: "outputPad", label: "Output padding", kind: "number" },
			{ key: "autocompleteMaxVisible", label: "Autocomplete max visible", kind: "number" },
			{ key: "mermaidRenderingMode", label: "Mermaid rendering", kind: "select", options: ["ascii", "code", "off"] },
			{ key: "showImages", label: "Show images", kind: "boolean" },
			{ key: "imageWidthCells", label: "Image width (cells)", kind: "number" },
			{ key: "imagesAutoResize", label: "Auto-resize images", kind: "boolean" },
			{ key: "imagesBlockImages", label: "Block images to LLM", kind: "boolean" },
			{ key: "shellPath", label: "Shell path", kind: "string" },
			{ key: "shellCommandPrefix", label: "Shell command prefix", kind: "string" },
			{ key: "npmCommand", label: "npm command", kind: "string" },
			{ key: "enabledModels", label: "Scoped models (patterns)", kind: "string" },
		];

		const dirty = new Map<string, unknown>();

		const render = () => {
			while (grid.firstChild) grid.removeChild(grid.firstChild);
			for (const field of editable) {
				const current = dirty.has(field.key)
					? dirty.get(field.key)
					: (snapshot?.effective as Record<string, unknown> | undefined)?.[field.key];
				grid.appendChild(h("label", {}, field.label));
				if (field.kind === "boolean") {
					const checkbox = h("input", { type: "checkbox" }) as HTMLInputElement;
					checkbox.checked = current === true;
					checkbox.addEventListener("change", () => dirty.set(field.key, checkbox.checked));
					grid.appendChild(checkbox);
				} else if (field.kind === "select" && field.options) {
					const select = h("select", {}) as HTMLSelectElement;
					for (const option of field.options) {
						const optionElement = h("option", { value: option }, option) as HTMLOptionElement;
						if (current === option) optionElement.selected = true;
						select.appendChild(optionElement);
					}
					select.addEventListener("change", () => dirty.set(field.key, select.value));
					grid.appendChild(select);
				} else if (field.kind === "button") {
					const button = h(
						"button",
						{
							onclick: () => {
								openThemeSelector(dialogs, connection, store);
							},
						},
						field.buttonText ?? "Open",
					);
					grid.appendChild(button);
				} else {
					const input = h("input", { type: field.kind === "number" ? "number" : "text" }) as HTMLInputElement;
					input.value =
						current === undefined || current === null
							? ""
							: Array.isArray(current)
								? current.join(", ")
								: String(current);
					input.addEventListener("change", () => {
						let value: unknown = input.value;
						if (field.kind === "number") value = Number(input.value);
						if (field.key === "npmCommand" || field.key === "enabledModels") {
							value = input.value
								? input.value
										.split(",")
										.map((part) => part.trim())
										.filter(Boolean)
								: undefined;
						}
						if (input.value === "") value = undefined;
						dirty.set(field.key, value);
					});
					grid.appendChild(input);
				}
			}
		};

		void connection.request<RpcSettingsSnapshot>({ type: "get_settings" }).then((data) => {
			snapshot = data;
			store.setSettingsSnapshot(data);
			render();
		});

		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Settings"),
			h(
				"div",
				{ class: "dialog-body" },
				h(
					"div",
					{ class: "settings-scope" },
					h("button", { onclick: () => setScope("global") }, "Global"),
					h("button", { onclick: () => setScope("project") }, "Project"),
				),
				grid,
			),
			h(
				"div",
				{ class: "dialog-footer" },
				h(
					"button",
					{
						class: "primary",
						onclick: () => {
							if (dirty.size === 0) {
								close();
								return;
							}
							const values: Record<string, unknown> = {};
							for (const [key, value] of dirty) {
								if (value !== undefined) values[key] = value;
							}
							void connection
								.request({ type: "set_settings", scope, values })
								.then(() => {
									void connection.request<RpcSettingsSnapshot>({ type: "get_settings" }).then((data) => {
										store.setSettingsSnapshot(data);
									});
									close();
								})
								.catch((error: Error) => {
									window.alert(`Failed to save settings: ${error.message}`);
								});
						},
					},
					"Save",
				),
				h("button", { onclick: close }, "Cancel"),
			),
		);
	});
}

/** Session info (/session). */
export function openSessionInfo(dialogs: DialogStack, connection: PiConnection): void {
	dialogs.open((close) => {
		const body = h("div", { class: "dialog-body" });
		void connection.request<Record<string, unknown>>({ type: "get_session_stats" }).then((stats) => {
			const rows: Array<[string, string]> = [];
			for (const [key, value] of Object.entries(stats ?? {})) {
				rows.push([key, typeof value === "object" ? JSON.stringify(value) : String(value)]);
			}
			for (const [key, value] of rows) {
				body.appendChild(h("div", {}, h("strong", {}, `${key}: `), value));
			}
		});
		return h(
			"div",
			{ class: "dialog" },
			h("div", { class: "dialog-title" }, "Session info"),
			body,
			h("div", { class: "dialog-footer" }, h("button", { class: "primary", onclick: close }, "Close")),
		);
	});
}
