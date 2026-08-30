/**
 * App shell: startup header, slash command routing, keyboard shortcuts,
 * tree browser, share/import/export, reconnect overlay, transcript search.
 */

import { connect, extensionUiResponse, type PiConnection } from "./connection.ts";
import {
	applyThemeVars,
	DialogStack,
	openAuthEventDialog,
	openChangelog,
	openExtensionUiDialog,
	openHotkeys,
	openModelSelector,
	openSessionInfo,
	openSessionSelector,
	openSettingsDialog,
	openThinkingSelector,
	openTrustDialog,
} from "./dialogs.ts";
import { h } from "./dom.ts";
import { EditorController, type EditorSubmitEvent } from "./editor/editor.ts";
import { FooterView, QueueView, StatusRowsView, ToastsView, WidgetAreaView } from "./footer.ts";
import { registerGlobalKeyboard, type ShortcutAction } from "./keyboard.ts";
import { SidebarView } from "./render/sidebar.ts";
import { TranscriptView } from "./render/transcript.ts";
import { WidgetOverlayView } from "./render/widget-overlay.ts";
import { Store } from "./state.ts";
import type {
	AgentEventMessage,
	ConnectedPayload,
	ConnectedSession,
	ExtensionUiRequestMessage,
	RpcTrustState,
	ServerMessage,
	SessionClosedMessage,
	SessionOpenedMessage,
	SessionReplacedMessage,
} from "./types.ts";

/** Session-bound view bundle — rebuilt when the active session changes. */
interface SessionViews {
	header: HTMLElement;
	transcript: TranscriptView;
	footer: FooterView;
	widgetsAbove: WidgetAreaView;
	widgetsBelow: WidgetAreaView;
	overlay: WidgetOverlayView;
	statusRows: StatusRowsView;
	queue: QueueView;
	unmount(): void;
}

export class App {
	readonly element: HTMLElement;
	/** Store for the pre-connect phase and the never-empty fallback. */
	private readonly fallbackStore = new Store();
	/** One store per open session, keyed by session id. */
	private readonly sessionStores = new Map<string, Store>();
	private activeSessionId: string | undefined;
	/** Editor drafts per session, preserved across switches. */
	private readonly editorDrafts = new Map<string, string>();
	/** Mount hosts for the session views (persistent across switches). */
	private transcriptHost!: HTMLElement;
	private footerHost!: HTMLElement;
	private views: SessionViews | undefined;
	private sidebar: SidebarView | undefined;
	private connection: PiConnection | undefined;
	private dialogs!: DialogStack;
	private editor!: EditorController;
	private reconnectOverlay: HTMLElement | undefined;
	private searchOverlay: HTMLElement | undefined;

	/** The active session's store (fallback before the first connect). */
	private get store(): Store {
		if (this.activeSessionId !== undefined) {
			return this.sessionStores.get(this.activeSessionId) ?? this.fallbackStore;
		}
		return this.fallbackStore;
	}

	constructor() {
		this.element = h("div", { id: "app" });
	}

	async start(): Promise<void> {
		const root = document.getElementById("app");
		if (root) {
			root.replaceWith(this.element);
		} else {
			document.body.appendChild(this.element);
		}

		// Layout (one column of rows):
		//   [ [ sidebar | transcript + editor ] footer ]
		// The shell is a row (sidebar beside main); the main column keeps the
		// original stacking (transcript grows, editor dock under it) and the
		// footer spans the full width below the shell.
		const shell = h("div", { class: "app-shell" });
		const main = h("div", { class: "app-main" });
		const transcriptWrap = h("div", { class: "transcript-wrap" });
		this.transcriptHost = h("div", { class: "transcript-host" });
		transcriptWrap.appendChild(this.transcriptHost);

		const editorDock = h("div", { class: "editor-dock" });
		const editorInner = h("div", { class: "editor-inner" });
		const statusRowsHost = h("div", {});
		const queueHost = h("div", {});
		const widgetsHost = h("div", {});
		const widgetsBelowHost = h("div", {});
		editorInner.appendChild(statusRowsHost);
		editorInner.appendChild(queueHost);
		editorInner.appendChild(widgetsHost);
		editorInner.appendChild(h("div", {}, this.buildEditorHost()));
		editorInner.appendChild(widgetsBelowHost);
		editorDock.appendChild(editorInner);

		this.footerHost = h("div", {});
		main.appendChild(transcriptWrap);
		main.appendChild(editorDock);
		shell.appendChild(main);
		this.element.appendChild(shell);
		this.element.appendChild(this.footerHost);

		// Global (session-independent) chrome. Toasts render notifications pushed
		// to the active session's store, so the view is rebuilt with the other
		// session views.
		this.toastsHost = h("div", {});
		this.overlayHost = h("div", {});
		document.body.appendChild(this.toastsHost);
		document.body.appendChild(this.overlayHost);
		this.dialogs = new DialogStack(document.body);

		// The multi-session sidebar (session list, groups, running spinners).
		this.sidebar = new SidebarView({
			getRunning: (sessionId) => {
				const store = this.sessionStores.get(sessionId);
				return (
					store !== undefined && (store.isTurnRunning() || (store.getState().sessionState?.isStreaming ?? false))
				);
			},
			onActivate: (sessionId) => void this.setActiveSession(sessionId),
			onOpen: (sessionPath) => {
				void this.connection
					?.request<{ sessionId?: string }>({ type: "open_session", sessionPath })
					.then((data) => {
						if (typeof data?.sessionId === "string") {
							// The pane is built by the session_opened broadcast; this
							// just records the intent to focus it.
							this.pendingFocus = data.sessionId;
						}
					})
					.catch(() => {});
			},
			onNew: (cwd?: string) => {
				void this.connection
					?.request<{ sessionId?: string }>({ type: "new_session", cwd })
					.then((data) => {
						if (typeof data?.sessionId === "string") {
							this.pendingFocus = data.sessionId;
						}
					})
					.catch(() => {});
			},
			onReload: () => {
				this.refreshSessionsList();
			},
			onClose: (sessionId) => {
				void this.connection?.request({ type: "close_session", sessionId }).catch(() => {});
			},
		});
		shell.prepend(this.sidebar.element);
		this.sidebar.mount();

		this.wireConnection();
	}

	/** Session to focus once its pane exists (open/new in flight). */
	private pendingFocus: string | undefined;
	/** Toast host — the view inside is rebuilt with the session views. */
	private toastsHost!: HTMLElement;
	/** Overlay-widget modal host, likewise rebuilt per active session. */
	private overlayHost!: HTMLElement;

	/** Rebuild the session-bound views for the active store. */
	private rebuildSessionViews(): void {
		this.views?.unmount();
		const store = this.store;
		const editorInner = this.element.querySelector(".editor-inner");
		if (!editorInner) return;
		const statusRowsHost = editorInner.firstElementChild as HTMLElement | null;
		const queueHost = statusRowsHost?.nextElementSibling as HTMLElement | null;
		const widgetsHost = queueHost?.nextElementSibling as HTMLElement | null;
		const widgetsBelowHost = editorInner.lastElementChild as HTMLElement | null;

		const header = this.buildHeader();
		const transcript = new TranscriptView({ store, showImages: true });
		const footer = new FooterView(store);
		const widgetsAbove = new WidgetAreaView(store, "aboveEditor");
		const widgetsBelow = new WidgetAreaView(store, "belowEditor");
		const statusRows = new StatusRowsView(store, this.connection!);
		const overlay = new WidgetOverlayView(
			store,
			(message) => {
				this.connection?.send({ type: "prompt", message });
			},
			(key, payload) => {
				void this.connection?.request({ type: "widget_response", key, payload }).catch(() => {});
			},
		);

		// Overlay widgets (questionnaires, MCP panels) render as modals on
		// top of the app; their element lives on the body, remounted per switch.
		this.overlayHost.replaceChildren(overlay.element);
		this.transcriptHost.replaceChildren(header, transcript.element);
		this.footerHost.replaceChildren(footer.element);
		if (statusRowsHost) statusRowsHost.replaceChildren(statusRows.element);
		if (widgetsHost) widgetsHost.replaceChildren(widgetsAbove.element);
		if (widgetsBelowHost) widgetsBelowHost.replaceChildren(widgetsBelow.element);

		transcript.mount(this.element.querySelector(".transcript-wrap") ?? this.transcriptHost);
		footer.mount();
		widgetsAbove.mount();
		widgetsBelow.mount();
		overlay.mount();
		if (queueHost) {
			const queue = new QueueView(store, (kind, index) => {
				void this.connection!.request<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" }).then(
					(result) => {
						const keep = [...(result.steering ?? []), ...(result.followUp ?? [])];
						if (kind === "steering" && result.steering) {
							const removed = result.steering[index];
							const next = keep.filter((message) => message !== removed);
							for (const message of next) {
								this.connection!.send({ type: "prompt", message, streamingBehavior: "steer" });
							}
						} else if (result.followUp) {
							const removed = result.followUp[index];
							const next = keep.filter((message) => message !== removed);
							for (const message of next) {
								this.connection!.send({ type: "prompt", message, streamingBehavior: "followUp" });
							}
						}
					},
				);
			});
			queue.mount();
			queueHost.replaceChildren(queue.element);
		}

		const toasts = new ToastsView(store);
		this.toastsHost.replaceChildren(toasts.element);
		toasts.mount();

		this.views = {
			header,
			transcript,
			footer,
			widgetsAbove,
			widgetsBelow,
			overlay,
			statusRows,
			queue: queueHost?.firstElementChild as unknown as QueueView,
			unmount: () => {
				transcript.unmount();
				footer.unmount();
				widgetsAbove.unmount();
				widgetsBelow.unmount();
				overlay.unmount();
				toasts.unmount();
			},
		};
	}

	// ------------------------------------------------------------------
	// Header
	// ------------------------------------------------------------------

	private buildHeader(): HTMLElement {
		const header = h("div", { class: "app-header" });
		header.appendChild(
			h(
				"div",
				{ class: "header-line" },
				h("span", { class: "version" }, "pi"),
				h("span", {}, " "),
				h(
					"span",
					{ class: "hotkey-hints" },
					h("kbd", {}, "Esc"),
					" interrupt · ",
					h("kbd", {}, "Ctrl+C"),
					"/",
					h("kbd", {}, "Ctrl+D"),
					" clear/exit · ",
					h("kbd", {}, "/"),
					" commands · ",
					h("kbd", {}, "!"),
					" bash · ",
					h("kbd", {}, "Ctrl+O"),
					" more",
				),
			),
		);
		const loadedSection = h("div", { class: "loaded-section" });
		header.appendChild(loadedSection);
		this.store.subscribe(() => {
			const state = this.store.getState();
			if (!state.contextInfo) return;
			const info = state.contextInfo;
			const parts: string[] = [];
			if (info.contextFiles.length > 0) {
				parts.push(`Context: ${info.contextFiles.map((file) => file.path.split(/[\\/]/).pop()).join(", ")}`);
			}
			if (info.skills.length > 0) {
				parts.push(`Skills: ${info.skills.map((skill) => skill.name).join(", ")}`);
			}
			if (info.promptTemplates.length > 0) {
				parts.push(`Prompts: ${info.promptTemplates.map((template) => template.name).join(", ")}`);
			}
			if (info.extensions.length > 0) {
				parts.push(`Extensions: ${info.extensions.map((extension) => extension.name).join(", ")}`);
			}
			while (loadedSection.firstChild) {
				loadedSection.removeChild(loadedSection.firstChild);
			}
			for (const part of parts) {
				loadedSection.appendChild(h("div", { class: "loaded-line" }, part));
			}
			if (state.version) {
				const versionElement = header.querySelector(".version");
				if (versionElement) versionElement.textContent = `pi v${state.version}`;
			}
		});
		return header;
	}

	// ------------------------------------------------------------------
	// Editor
	// ------------------------------------------------------------------

	private buildEditorHost(): HTMLElement {
		this.editor = new EditorController({
			isStreaming: () => this.store.getState().sessionState?.isStreaming ?? false,
			submit: (event) => this.handleSubmit(event),
			onEscape: () => this.handleEscape(),
			onClear: () => {},
			searchFiles: async (query) => {
				try {
					const data = await this.connection!.request<{ files: string[] }>({ type: "search_files", query });
					return data.files ?? [];
				} catch {
					return [];
				}
			},
			commands: () => this.store.getState().commands,
		});
		return this.editor.element;
	}

	private handleSubmit(event: EditorSubmitEvent): void {
		const connection = this.connection;
		if (!connection) return;
		if (event.mode === "bash" || event.mode === "bashHidden") {
			connection.send({
				type: "bash",
				command: event.bashCommand ?? "",
				excludeFromContext: event.mode === "bashHidden",
			});
			return;
		}
		if (event.mode === "steer") {
			connection.send({ type: "prompt", message: event.text, images: event.images, streamingBehavior: "steer" });
			return;
		}
		if (event.mode === "followUp") {
			connection.send({ type: "prompt", message: event.text, images: event.images, streamingBehavior: "followUp" });
			return;
		}
		this.handlePromptText(event.text, event.images);
	}

	private handlePromptText(text: string, images?: EditorSubmitEvent["images"]): void {
		const connection = this.connection;
		if (!connection) return;

		// Built-in slash commands are handled by the GUI itself.
		if (text.startsWith("/")) {
			const trimmed = text.trim();
			const name = trimmed.split(/\s+/, 1)[0]!.slice(1);
			const args = trimmed.slice(name.length + 2).trim();
			if (this.runBuiltinCommand(name, args)) {
				return;
			}
		}
		connection.send({ type: "prompt", message: text, images });
	}

	private handleEscape(): void {
		const connection = this.connection;
		if (!connection) return;
		const state = this.store.getState();
		if (state.queue.steering.length > 0 || state.queue.followUp.length > 0) {
			void connection
				.request<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" })
				.then((queue) => {
					connection.send({ type: "abort" });
					this.editor.restoreQueue([...(queue.steering ?? []), ...(queue.followUp ?? [])]);
				})
				.catch(() => {
					connection.send({ type: "abort" });
				});
			return;
		}
		connection.send({ type: "abort" });
	}

	// ------------------------------------------------------------------
	// Built-in slash commands
	// ------------------------------------------------------------------

	private runBuiltinCommand(name: string, args: string): boolean {
		const connection = this.connection;
		if (!connection) return false;
		const store = this.store;

		switch (name) {
			case "settings":
				openSettingsDialog(this.dialogs, connection, store);
				return true;
			case "model":
				if (args) {
					const [provider, modelId] = args.split("/");
					if (provider && modelId) {
						void connection
							.request<never>({ type: "set_model", provider, modelId })
							.then((model) => {
								store.setModel(model);
							})
							.catch((error: Error) => {
								store.pushNotification(error.message, "error");
							});
						return true;
					}
				}
				openModelSelector(this.dialogs, connection, this.store, {
					onSaveDefault: () => this.saveModelDefault(),
				});
				return true;
			case "thinking":
				if (args) {
					void connection
						.request({ type: "set_thinking_level", level: args as never })
						.then(() => {
							store.setThinkingLevel(args as never);
						})
						.catch(() => {
							store.pushNotification(`Invalid thinking level: ${args}`, "error");
						});
					return true;
				}
				openThinkingSelector(this.dialogs, connection, this.store, {
					onSaveDefault: () => this.saveThinkingDefault(),
				});
				return true;
			case "scoped-models":
				store.pushNotification("Use /settings → Scoped models to edit the model cycle set", "info");
				return true;
			case "tree":
				this.openTreeBrowser();
				return true;
			case "export": {
				const path = args || "session.html";
				void connection
					.request<{ path: string }>({ type: "export_session", path })
					.then((data) => {
						store.pushNotification(`Exported to: ${data.path}`, "info");
					})
					.catch((error: Error) => {
						store.pushNotification(`Export failed: ${error.message}`, "error");
					});
				return true;
			}
			case "import": {
				if (!args) {
					store.pushNotification("Usage: /import <path.jsonl>", "warning");
					return true;
				}
				void connection
					.request<{ cancelled: boolean }>({ type: "import_session", path: args })
					.then(() => {
						store.pushNotification(`Session imported from: ${args}`, "info");
						return this.syncAfterSessionSwitch();
					})
					.catch((error: Error & { missingCwd?: boolean }) => {
						if (error.missingCwd) {
							const cwd = window.prompt("Imported session cwd not found. Enter the project directory:");
							if (cwd) {
								void connection
									.request({ type: "import_session", path: args, cwd })
									.then(() => this.syncAfterSessionSwitch())
									.catch(() => {});
							}
						} else {
							store.pushNotification(`Import failed: ${error.message}`, "error");
						}
					});
				return true;
			}
			case "share":
				store.pushNotification("Sharing session…", "info");
				void connection
					.request<{ url?: string; gistUrl?: string }>({ type: "share_session" })
					.then((data) => {
						if (data.url) {
							store.pushNotification(`Share URL: ${data.url}`, "info");
						} else if (data.gistUrl) {
							store.pushNotification(`Gist: ${data.gistUrl}`, "info");
						}
					})
					.catch((error: Error) => {
						store.pushNotification(`Share failed: ${error.message}`, "error");
					});
				return true;
			case "copy":
				void connection
					.request<{ text: string | null }>({ type: "get_last_assistant_text" })
					.then((data) => {
						void navigator.clipboard.writeText(data.text ?? "");
						store.pushNotification("Copied last assistant message", "info");
					})
					.catch(() => {});
				return true;
			case "name":
				if (!args) {
					store.pushNotification("Usage: /name <name>", "warning");
					return true;
				}
				void connection.request({ type: "set_session_name", name: args }).then(() => {
					void this.refreshState();
				});
				return true;
			case "session":
				openSessionInfo(this.dialogs, connection);
				return true;
			case "changelog":
				openChangelog(this.dialogs, connection);
				return true;
			case "hotkeys":
				openHotkeys(this.dialogs, this.store.getState().keybindings);
				return true;
			case "fork":
				this.openForkPicker();
				return true;
			case "clone":
				void connection.request({ type: "clone" }).then(() => this.syncAfterSessionSwitch());
				return true;
			case "trust": {
				void connection.request<RpcTrustState>({ type: "get_trust" }).then((trust) => {
					openTrustDialog(this.dialogs, connection, trust, {
						onTrusted: () => {
							void connection.request({ type: "reload" }).then(() => this.syncAfterSessionSwitch());
						},
					});
				});
				return true;
			}
			case "login":
				this.openLogin(args);
				return true;
			case "logout":
				this.openLogout(args);
				return true;
			case "new":
				void connection.request({ type: "new_session" }).then(() => this.syncAfterSessionSwitch());
				return true;
			case "compact":
				void connection
					.request({ type: "compact", customInstructions: args || undefined })
					.catch((error: Error) => {
						store.pushNotification(`Compaction failed: ${error.message}`, "error");
					});
				return true;
			case "resume":
				openSessionSelector(this.dialogs, connection, {
					onResume: (sessionPath) => {
						void connection
							.request({ type: "switch_session", sessionPath })
							.then(() => this.syncAfterSessionSwitch());
					},
				});
				return true;
			case "reload":
				void connection.request({ type: "reload" }).then(() => this.syncAfterSessionSwitch());
				store.pushNotification("Reloaded", "info");
				return true;
			case "quit":
				if (window.confirm("Quit pi?")) {
					window.close();
				}
				return true;
			default:
				return false;
		}
	}

	private saveModelDefault(): void {
		const model = this.store.getState().sessionState?.model;
		if (model && this.connection) {
			void this.connection
				.request({
					type: "set_settings",
					scope: "global",
					values: { defaultProvider: model.provider, defaultModel: model.id },
				})
				.then(() => {
					this.store.pushNotification(`Saved default model: ${model.id}`, "info");
				})
				.catch((error: Error) => {
					this.store.pushNotification(error.message, "error");
				});
		}
	}

	private saveThinkingDefault(): void {
		const level = this.store.getState().sessionState?.thinkingLevel;
		if (level && this.connection) {
			void this.connection
				.request({ type: "set_settings", scope: "global", values: { defaultThinkingLevel: level } })
				.then(() => {
					this.store.pushNotification(`Saved default thinking level: ${level}`, "info");
				})
				.catch((error: Error) => {
					this.store.pushNotification(error.message, "error");
				});
		}
	}

	private openForkPicker(): void {
		const connection = this.connection;
		if (!connection) return;
		void connection
			.request<{ messages: Array<{ entryId: string; text: string }> }>({ type: "get_fork_messages" })
			.then((data) => {
				this.dialogs.open((close) => {
					const list = h("div", {});
					for (const message of data.messages ?? []) {
						const row = h(
							"div",
							{ class: "list-item" },
							h("span", { class: "item-label" }, message.text.slice(0, 80)),
						);
						row.addEventListener("click", () => {
							void connection.request({ type: "fork", entryId: message.entryId }).then(() => {
								void this.syncAfterSessionSwitch();
								close();
							});
						});
						list.appendChild(row);
					}
					return h(
						"div",
						{ class: "dialog" },
						h("div", { class: "dialog-title" }, "Fork from a previous user message"),
						h("div", { class: "dialog-body" }, list),
						h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Close")),
					);
				});
			})
			.catch(() => {});
	}

	private openTreeBrowser(): void {
		const connection = this.connection;
		if (!connection) return;
		interface TreeNode {
			entry: { type: string; id: string; message?: { role?: string; content?: unknown; command?: string } };
			children: TreeNode[];
			label?: string;
			labelTimestamp?: string;
		}
		void connection
			.request<{ tree: TreeNode[]; leafId: string | null }>({ type: "get_tree" })
			.then((data) => {
				this.dialogs.open((close) => {
					const list = h("div", {});
					const renderNode = (node: TreeNode, depth: number): void => {
						const entry = node.entry;
						let label = node.label ?? entry.type;
						if (entry.type === "message" && entry.message?.role === "user") {
							const content = entry.message.content;
							label = typeof content === "string" ? content : JSON.stringify(content ?? "");
							label = label.slice(0, 60);
						} else if (entry.type === "message" && entry.message?.role === "assistant") {
							label = "assistant";
						} else if (entry.type === "message" && entry.message?.role === "toolResult") {
							label = "tool result";
						}
						const row = h(
							"div",
							{
								class: `tree-row${entry.id === data.leafId ? " selected" : ""}`,
								style: `padding-left: ${depth * 18}px`,
							},
							h("span", { class: "tree-label" }, label),
							h("span", { class: "tree-id" }, entry.id.slice(0, 8)),
						);
						row.addEventListener("click", () => {
							const summarize = window.confirm("Summarize the abandoned branch before switching?");
							void connection
								.request({ type: "navigate_tree", targetId: entry.id, summarize })
								.then((result) => {
									void this.syncAfterSessionSwitch();
									const editorText = (result as { editorText?: string }).editorText;
									if (editorText) {
										this.editor.setText(editorText);
									}
									close();
								})
								.catch((error: Error) => {
									this.store.pushNotification(error.message, "error");
								});
						});
						list.appendChild(row);
						for (const child of node.children ?? []) {
							renderNode(child, depth + 1);
						}
					};
					for (const node of data.tree ?? []) {
						renderNode(node, 0);
					}
					return h(
						"div",
						{ class: "dialog" },
						h("div", { class: "dialog-title" }, "Session tree"),
						h("div", { class: "dialog-body" }, list),
						h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Close")),
					);
				});
			})
			.catch(() => {});
	}

	private openLogin(args: string): void {
		const connection = this.connection;
		if (!connection) return;
		void connection
			.request<{ providers: Array<{ id: string; authenticated: boolean }> }>({ type: "auth_status" })
			.then((data) => {
				this.dialogs.open((close) => {
					const list = h("div", {});
					const providers = data.providers ?? [];
					if (!args && providers.length > 0) {
						for (const provider of providers) {
							const row = h(
								"div",
								{ class: "list-item" },
								h("span", { class: "item-label" }, provider.id),
								h("span", { class: "item-meta" }, provider.authenticated ? "authenticated" : ""),
							);
							row.addEventListener("click", () => {
								this.startLogin(provider.id);
								close();
							});
							list.appendChild(row);
						}
					}
					return h(
						"div",
						{ class: "dialog" },
						h("div", { class: "dialog-title" }, "Login to provider"),
						h("div", { class: "dialog-body" }, list),
						h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Close")),
					);
				});
			})
			.catch(() => {
				if (args) this.startLogin(args);
			});
		if (args) this.startLogin(args);
	}

	private startLogin(provider: string): void {
		const connection = this.connection;
		if (!connection) return;
		const method = window.confirm(`Login to ${provider} via OAuth?\n\nCancel = use API key.`) ? "oauth" : "api_key";
		void connection
			.request({ type: "auth_login", provider, method })
			.then(() => {
				this.store.pushNotification(`Logged in to ${provider}`, "success" as never);
			})
			.catch((error: Error) => {
				if (error.message !== "Login cancelled") {
					this.store.pushNotification(`Login failed: ${error.message}`, "error");
				}
			});
	}

	private openLogout(args: string): void {
		const connection = this.connection;
		if (!connection) return;
		if (args) {
			void connection.request({ type: "auth_logout", provider: args }).then(() => {
				this.store.pushNotification(`Logged out of ${args}`, "info");
			});
			return;
		}
		void connection
			.request<{ providers: Array<{ id: string; authenticated: boolean }> }>({ type: "auth_status" })
			.then((data) => {
				this.dialogs.open((close) => {
					const list = h("div", {});
					for (const provider of (data.providers ?? []).filter((entry) => entry.authenticated)) {
						const row = h("div", { class: "list-item" }, h("span", { class: "item-label" }, provider.id));
						row.addEventListener("click", () => {
							void connection.request({ type: "auth_logout", provider: provider.id }).then(() => {
								this.store.pushNotification(`Logged out of ${provider.id}`, "info");
								close();
							});
						});
						list.appendChild(row);
					}
					return h(
						"div",
						{ class: "dialog" },
						h("div", { class: "dialog-title" }, "Logout of provider"),
						h("div", { class: "dialog-body" }, list),
						h("div", { class: "dialog-footer" }, h("button", { onclick: close }, "Close")),
					);
				});
			})
			.catch(() => {});
	}

	// ------------------------------------------------------------------
	// Connection wiring
	// ------------------------------------------------------------------

	private wireConnection(): void {
		this.connection = connect({
			onMessage: (message) => this.handleServerMessage(message),
			onDisconnect: () => this.showReconnectOverlay(),
			onReconnect: () => {
				this.hideReconnectOverlay();
			},
			getSessionId: () => this.activeSessionId,
		});
		this.wireKeyboard();
	}

	private handleServerMessage(message: ServerMessage): void {
		const type = (message as { type?: string }).type;
		switch (type) {
			case "connected": {
				const connected = message as never as ConnectedPayload;
				this.connectedBase = connected;
				// Multi-session payload: build a store per open session and
				// activate the remembered (or primary) one.
				this.hydrateSessions(connected);
				if (connected.themes && connected.theme) {
					this.store.setThemes(connected.themes, connected.theme.name);
					applyThemeVars(connected.theme.vars);
				}
				this.maybeShowTrustDialog();
				break;
			}
			case "session_opened": {
				const opened = message as never as SessionOpenedMessage;
				this.registerSession(opened.id, opened, true);
				this.refreshSessionsList();
				break;
			}
			case "session_closed": {
				const closed = message as never as SessionClosedMessage;
				this.sessionStores.delete(closed.sessionId);
				this.editorDrafts.delete(closed.sessionId);
				this.sidebar?.removeSession(closed.sessionId);
				if (this.activeSessionId === closed.sessionId) {
					// Fall back to the primary (or any open session).
					const remaining = [...this.sessionStores.keys()];
					this.setActiveSession(remaining[0]);
				}
				break;
			}
			case "session_replaced": {
				const replaced = message as never as SessionReplacedMessage;
				const store = this.sessionStores.get(replaced.oldSessionId);
				if (store) {
					this.sessionStores.delete(replaced.oldSessionId);
					this.sessionStores.set(replaced.newSessionId, store);
					const draft = this.editorDrafts.get(replaced.oldSessionId);
					if (draft !== undefined) {
						this.editorDrafts.delete(replaced.oldSessionId);
						this.editorDrafts.set(replaced.newSessionId, draft);
					}
					if (this.activeSessionId === replaced.oldSessionId) {
						this.activeSessionId = replaced.newSessionId;
					}
					this.sidebar?.renameSession(replaced.oldSessionId, replaced.newSessionId, replaced.sessionPath);
				}
				break;
			}
			case "server_shutdown":
				this.showShutdownOverlay(String((message as { reason?: string }).reason ?? ""));
				break;
			case "theme_changed": {
				const themeChange = message as { name: string; vars: Record<string, string> };
				for (const store of this.sessionStores.values()) {
					store.applyThemeChanged(themeChange.name);
				}
				applyThemeVars(themeChange.vars);
				break;
			}
			case "auth_changed":
				// Refresh header/provider info lazily.
				break;
			case "extension_ui_request": {
				const request = message as never as ExtensionUiRequestMessage;
				this.handleExtensionUiRequest(request);
				break;
			}
			case "response":
				break;
			default: {
				// Agent events route to the tagged session's store.
				const tagged = message as { sessionId?: string };
				const store =
					(typeof tagged.sessionId === "string" ? this.sessionStores.get(tagged.sessionId) : undefined) ??
					this.store;
				store.applyAgentEvent(message as AgentEventMessage);
				break;
			}
		}
	}

	/** Build stores for every open session in a connected payload. */
	private hydrateSessions(connected: ConnectedPayload): void {
		const sessions = connected.sessions ?? [];
		const previousIds = new Set(this.sessionStores.keys());
		for (const session of sessions) {
			if (!this.sessionStores.has(session.id)) {
				this.registerSession(session.id, session, false);
			} else {
				// Reconnect: rehydrate the existing store in place.
				const store = this.sessionStores.get(session.id)!;
				store.applyConnected(this.sessionPayload(connected, session));
				this.sidebar?.updateSession(session.id, {
					sessionPath: session.sessionPath,
					cwd: session.cwd,
					primary: session.id === connected.primarySessionId,
				});
			}
			previousIds.delete(session.id);
		}
		for (const gone of previousIds) {
			this.sessionStores.delete(gone);
			this.editorDrafts.delete(gone);
			this.sidebar?.removeSession(gone);
		}
		if (this.sessionStores.size === 0 && sessions.length === 0) {
			// Single-session legacy fallback.
			this.fallbackStore.applyConnected(connected);
			this.rebuildSessionViews();
		}
		const remembered = window.localStorage.getItem("pi-web-active-session") ?? undefined;
		const active =
			remembered !== undefined && this.sessionStores.has(remembered)
				? remembered
				: (connected.primarySessionId ?? sessions[0]?.id);
		if (active !== undefined) {
			this.setActiveSession(active);
		}
		this.refreshSessionsList();
	}

	/** Adapt a per-session payload into the shape applyConnected expects. */
	private sessionPayload(connected: ConnectedPayload, session: ConnectedSession): ConnectedPayload {
		return {
			type: "connected",
			version: connected.version,
			state: session.state,
			messages: session.messages,
			contextInfo: session.contextInfo,
			trust: session.trust,
			widgets: session.widgets,
			statuses: session.statuses,
			themes: connected.themes,
			theme: connected.theme,
			keybindings: connected.keybindings,
			pendingUiRequests: session.pendingUiRequests,
		};
	}

	/** Create a store + sidebar entry for a session (new or reconnected). */
	private registerSession(id: string, session: ConnectedSession, focus: boolean): void {
		const store = new Store();
		const connectedBase = this.connectedBase;
		store.applyConnected(this.sessionPayload(connectedBase, session));
		// A session mid-turn at connect time keeps its running state until
		// the next turn event arrives.
		if (session.running) store.setTurnRunning(true);
		this.sessionStores.set(id, store);
		this.sidebar?.addSession(id, {
			sessionPath: session.sessionPath,
			cwd: session.cwd,
			primary: id === this.connectedBase.primarySessionId,
		});
		if (focus || this.pendingFocus === id) {
			this.pendingFocus = undefined;
			this.setActiveSession(id);
			// A session just opened on user intent (sidebar +/click): expand
			// its group so the new row is visible.
			this.sidebar?.revealSession(id);
		}
		// Extension dialogs pending on this session (page reload while a
		// questionnaire was open) reopen on registration.
		for (const request of session.pendingUiRequests ?? []) {
			this.handleExtensionUiRequest(request);
		}
	}

	/** The last connected payload's global section (themes/keybindings). */
	private connectedBase: ConnectedPayload = { type: "connected", version: "", messages: [] };

	/** Refresh the sidebar's disk session list (all projects). */
	private refreshSessionsList(): void {
		void this.connection
			?.request<{
				sessions: Array<{ file: string; cwd: string; name?: string; firstMessage?: string; modified?: string }>;
			}>({
				type: "list_sessions",
				scope: "all",
			})
			.then((data) => {
				this.sidebar?.setSessionsList(
					(data.sessions ?? []).map((session) => ({
						path: session.file,
						cwd: session.cwd,
						name: session.name?.trim() || session.firstMessage,
						modified: new Date(session.modified ?? 0).getTime() || 0,
					})),
				);
			})
			.catch(() => {});
	}

	/** Switch the active session (rebinds all session views). */
	private setActiveSession(id: string | undefined): void {
		if (id === undefined) {
			this.activeSessionId = undefined;
			return;
		}
		if (!this.sessionStores.has(id)) return;
		if (this.activeSessionId === id) return;
		// Preserve the current editor draft before switching.
		if (this.activeSessionId !== undefined) {
			const draft = this.editor.getText();
			if (draft.length > 0) this.editorDrafts.set(this.activeSessionId, draft);
			else this.editorDrafts.delete(this.activeSessionId);
		}
		this.activeSessionId = id;
		window.localStorage.setItem("pi-web-active-session", id);
		this.rebuildSessionViews();
		// Restore the target session's draft and focus the editor.
		this.editor.setText(this.editorDrafts.get(id) ?? "");
		this.editor.focus();
		this.sidebar?.setActive(id);
	}

	private handleExtensionUiRequest(request: ExtensionUiRequestMessage): void {
		const connection = this.connection;
		if (!connection) return;
		// Dialog answers must return to the session that asked, even if the
		// user switched sessions while the dialog was open.
		const requestSessionId = request.sessionId;
		const respond = (response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void => {
			if (response.cancelled) {
				connection.sendRaw(extensionUiResponse({ id: request.id, cancelled: true, sessionId: requestSessionId }));
			} else if (response.confirmed !== undefined) {
				connection.sendRaw(
					extensionUiResponse({ id: request.id, confirmed: response.confirmed, sessionId: requestSessionId }),
				);
			} else if (response.value !== undefined) {
				connection.sendRaw(
					extensionUiResponse({ id: request.id, value: response.value, sessionId: requestSessionId }),
				);
			}
		};

		// Widget/status side effects land in the OWNING session's store — the
		// active view may be a different session.
		const store =
			(request.sessionId !== undefined ? this.sessionStores.get(request.sessionId) : undefined) ?? this.store;
		switch (request.method) {
			case "notify":
				// Notifications are user-visible regardless of which session
				// emitted them: surface them on the active store.
				this.store.pushNotification(
					request.message ?? "",
					(request.notifyType as "info" | "warning" | "error") ?? "info",
				);
				return;
			case "setStatus":
				store.setExtensionStatus(request.statusKey ?? "", request.statusText);
				return;
			case "setWidget":
				store.setWidget(request.widgetKey ?? "", request.widgetLines, request.widgetPlacement ?? "aboveEditor");
				return;
			case "setWidgetData":
				store.setWidgetData(request.widgetKey ?? "", request.widgetData);
				return;
			case "setTitle":
				document.title = request.text ?? "pi";
				return;
			case "set_editor_text":
				if (store === this.store) this.editor.setText(request.text ?? "");
				return;
			case "setWorkingIndicator":
				store.setWorkingIndicator(request.frames, request.intervalMs);
				return;
			case "auth_event":
				openAuthEventDialog(this.dialogs, request as never);
				return;
			default:
				openExtensionUiDialog(this.dialogs, request, respond);
		}
	}

	private maybeShowTrustDialog(): void {
		const state = this.store.getState();
		if (!state.trust || state.trust.trusted || state.contextInfo?.isTrusted) return;
		if (!this.connection) return;
		const trust = state.trust;
		openTrustDialog(this.dialogs, this.connection, trust, {
			onTrusted: () => {
				void this.connection!.request({ type: "reload" }).then(() => this.syncAfterSessionSwitch());
			},
		});
	}

	// ------------------------------------------------------------------
	// Keyboard
	// ------------------------------------------------------------------

	private wireKeyboard(): void {
		registerGlobalKeyboard({
			serverBindings: this.store.getState().keybindings?.bindings,
			handleAction: (action: ShortcutAction, _event: KeyboardEvent): boolean => {
				if (this.dialogs.isOpen() && action !== "app.interrupt") {
					return false;
				}
				const connection = this.connection;
				if (!connection) return false;
				switch (action) {
					case "app.interrupt":
						if (this.dialogs.isOpen()) {
							this.dialogs.closeTop();
							return true;
						}
						return false;
					case "app.thinking.cycle":
						void connection.request({ type: "cycle_thinking_level" }).then(() => this.refreshState());
						return true;
					case "app.thinking.toggle":
						this.store.toggleThinkingVisible();
						return true;
					case "app.model.cycleForward":
						void connection.request({ type: "cycle_model" }).then(() => this.refreshState());
						return true;
					case "app.model.cycleBackward":
						void connection.request({ type: "cycle_model" }).then(() => this.refreshState());
						return true;
					case "app.model.select":
						openModelSelector(this.dialogs, connection, this.store, {
							onSaveDefault: () => this.saveModelDefault(),
						});
						return true;
					case "app.tools.expand": {
						const next = !this.store.getState().toolsExpanded;
						this.store.setToolsExpanded(next);
						return true;
					}
					case "app.session.tree":
						this.openTreeBrowser();
						return true;
					case "app.session.resume":
						openSessionSelector(this.dialogs, connection, {
							onResume: (sessionPath) => {
								void connection
									.request({ type: "switch_session", sessionPath })
									.then(() => this.syncAfterSessionSwitch());
							},
						});
						return true;
					case "app.session.new":
						void connection.request({ type: "new_session" }).then(() => this.syncAfterSessionSwitch());
						return true;
					case "app.session.fork":
						this.openForkPicker();
						return true;
					case "app.message.copy":
						void connection.request<{ text: string | null }>({ type: "get_last_assistant_text" }).then((data) => {
							void navigator.clipboard.writeText(data.text ?? "");
						});
						return true;
					case "app.message.dequeue":
						void connection
							.request<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" })
							.then((queue) => {
								this.editor.restoreQueue([...(queue.steering ?? []), ...(queue.followUp ?? [])]);
							});
						return true;
					case "app.editor.external": {
						this.dialogs.open((close) => {
							const textarea = h("textarea", {}) as HTMLTextAreaElement;
							textarea.value = this.editor.getText();
							textarea.addEventListener("keydown", (event2) => {
								if (event2.key === "Enter" && (event2.ctrlKey || event2.metaKey)) {
									event2.preventDefault();
									this.editor.setText(textarea.value);
									close();
								}
							});
							return h(
								"div",
								{ class: "dialog" },
								h("div", { class: "dialog-title" }, "External editor"),
								h("div", { class: "dialog-body" }, textarea),
								h(
									"div",
									{ class: "dialog-footer" },
									h(
										"button",
										{
											class: "primary",
											onclick: () => {
												this.editor.setText(textarea.value);
												close();
											},
										},
										"Apply (Ctrl+Enter)",
									),
									h("button", { onclick: close }, "Cancel"),
								),
							);
						});
						return true;
					}
					case "app.search":
						this.toggleSearch();
						return true;
					default:
						return false;
				}
			},
		});
	}

	// ------------------------------------------------------------------
	// State refresh / overlays
	// ------------------------------------------------------------------

	private async refreshState(): Promise<void> {
		const connection = this.connection;
		if (!connection) return;
		try {
			const state = await connection.request<never>({ type: "get_state" });
			this.store.setSessionState(state);
		} catch {
			// Connection may be reconnecting
		}
	}

	private async syncAfterSessionSwitch(): Promise<void> {
		const connection = this.connection;
		if (!connection) return;
		try {
			const state = await connection.request<never>({ type: "get_state" });
			const messages = await connection.request<{ messages: unknown[] }>({ type: "get_messages" });
			const contextInfo = await connection.request<never>({ type: "get_context_info" });
			const trust = await connection.request<never>({ type: "get_trust" });
			this.store.setSessionState(state);
			this.store.setContextInfo(contextInfo);
			this.store.setTrust(trust);
			this.store.applyConnected({
				type: "connected",
				version: this.store.getState().version,
				state,
				messages: messages.messages as never[],
			});
			const stats = await connection.request<{
				tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
				contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
			}>({ type: "get_session_stats" });
			if (stats?.contextUsage) {
				this.store.setContextUsage(
					stats.contextUsage.tokens,
					stats.contextUsage.contextWindow,
					stats.contextUsage.percent,
				);
			}
		} catch {
			// Connection may be reconnecting
		}
	}

	private showReconnectOverlay(): void {
		this.store.markDisconnected();
		if (this.reconnectOverlay) return;
		this.reconnectOverlay = h(
			"div",
			{ class: "reconnect-overlay" },
			h("div", {}, "Connection lost. Reconnecting…"),
			h("div", { style: "color: var(--color-muted); font-size: 12px" }, "The server may be restarting."),
		);
		document.body.appendChild(this.reconnectOverlay);
	}

	private hideReconnectOverlay(): void {
		this.reconnectOverlay?.remove();
		this.reconnectOverlay = undefined;
	}

	private showShutdownOverlay(reason: string): void {
		this.reconnectOverlay?.remove();
		this.reconnectOverlay = h(
			"div",
			{ class: "reconnect-overlay" },
			h("div", {}, `Server shut down: ${reason}`),
			h("div", { style: "color: var(--color-muted); font-size: 12px" }, "You can close this tab."),
		);
		document.body.appendChild(this.reconnectOverlay);
	}

	private toggleSearch(): void {
		if (this.searchOverlay) {
			this.searchOverlay.remove();
			this.searchOverlay = undefined;
			return;
		}
		const input = h("input", { type: "text", placeholder: "Search transcript…" }) as HTMLInputElement;
		const count = h("span", { style: "color: var(--color-dim); font-size: 12px" }, "");
		const bar = h("div", { class: "search-bar" }, input, count);
		this.element.prepend(bar);
		this.searchOverlay = bar;
		input.focus();

		let matches = 0;
		let current = -1;
		const find = (): HTMLElement[] => {
			const query = input.value.toLowerCase();
			if (!query) return [];
			const elements: HTMLElement[] = [];
			for (const node of this.views?.transcript.element.querySelectorAll(".transcript-item") ?? []) {
				if (node instanceof HTMLElement && node.textContent?.toLowerCase().includes(query)) {
					elements.push(node);
				}
			}
			return elements;
		};
		const highlight = (): void => {
			const found = find();
			matches = found.length;
			if (current >= 0 && found[current]) {
				found[current]!.scrollIntoView({ block: "center" });
			}
			count.textContent = matches > 0 ? `${current + 1}/${matches}` : "0";
		};
		input.addEventListener("input", () => {
			current = 0;
			highlight();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				if (matches > 0) {
					current = (current + 1) % matches;
					highlight();
				}
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.toggleSearch();
			}
		});
	}
}
