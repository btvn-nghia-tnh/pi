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
import { TranscriptView } from "./render/transcript.ts";
import { WidgetOverlayView } from "./render/widget-overlay.ts";
import { Store } from "./state.ts";
import type {
	AgentEventMessage,
	ConnectedPayload,
	ExtensionUiRequestMessage,
	RpcTrustState,
	ServerMessage,
} from "./types.ts";

export class App {
	readonly element: HTMLElement;
	private readonly store = new Store();
	private connection: PiConnection | undefined;
	private dialogs!: DialogStack;
	private editor!: EditorController;
	private transcript!: TranscriptView;
	private reconnectOverlay: HTMLElement | undefined;
	private searchOverlay: HTMLElement | undefined;

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

		const transcriptWrap = h("div", { class: "transcript-wrap" });
		this.transcript = new TranscriptView({ store: this.store, showImages: true });
		// The startup header lives at the top of the transcript flow (like the
		// TUI main screen): it scrolls away with the messages instead of
		// pinning above them.
		transcriptWrap.appendChild(this.buildHeader());
		transcriptWrap.appendChild(this.transcript.element);

		const editorDock = h("div", { class: "editor-dock" });
		const editorInner = h("div", { class: "editor-inner" });
		const statusRows = h("div", {});
		const queueHost = h("div", {});
		const widgetsAbove = new WidgetAreaView(this.store, "aboveEditor");
		const widgetsBelow = new WidgetAreaView(this.store, "belowEditor");
		const footer = new FooterView(this.store);
		const toasts = new ToastsView(this.store);
		editorInner.appendChild(statusRows);
		editorInner.appendChild(queueHost);
		editorInner.appendChild(widgetsAbove.element);
		editorInner.appendChild(h("div", {}, this.buildEditorHost()));
		editorInner.appendChild(widgetsBelow.element);
		editorDock.appendChild(editorInner);

		this.element.appendChild(transcriptWrap);
		this.element.appendChild(editorDock);
		this.element.appendChild(footer.element);
		document.body.appendChild(toasts.element);

		this.dialogs = new DialogStack(document.body);

		this.wireConnection();

		this.transcript.mount(transcriptWrap);
		footer.mount();
		toasts.mount();
		widgetsAbove.mount();
		widgetsBelow.mount();
		// Overlay widgets (display: "overlay") render as modals on top of the app.
		const widgetOverlay = new WidgetOverlayView(this.store, (message) => {
			this.connection?.send({ type: "prompt", message });
		});
		document.body.appendChild(widgetOverlay.element);
		widgetOverlay.mount();
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
				void this.syncAfterSessionSwitch();
			},
		});
		this.wireKeyboard();
		this.mountEditorViews();
	}

	private mounted = false;

	private mountEditorViews(): void {
		if (this.mounted) return;
		this.mounted = true;
		const editorInner = this.element.querySelector(".editor-inner");
		if (!editorInner) return;
		const statusRowsHost = editorInner.firstElementChild as HTMLElement | null;
		const queueHost = statusRowsHost?.nextElementSibling as HTMLElement | null;

		if (statusRowsHost && this.connection) {
			const statusRows = new StatusRowsView(this.store, this.connection);
			statusRows.mount();
			while (statusRowsHost.firstChild) statusRowsHost.removeChild(statusRowsHost.firstChild);
			statusRowsHost.appendChild(statusRows.element);
		}
		if (queueHost && this.connection) {
			const queue = new QueueView(this.store, (kind, _index) => {
				// Removing a single queued message: clear all, restore without that one.
				void this.connection!.request<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" }).then(
					(result) => {
						const keep = [...(result.steering ?? []), ...(result.followUp ?? [])];
						if (kind === "steering" && result.steering) {
							const removed = result.steering[_index];
							const next = keep.filter((message) => message !== removed);
							for (const message of next) {
								this.connection!.send({ type: "prompt", message, streamingBehavior: "steer" });
							}
						} else if (result.followUp) {
							const removed = result.followUp[_index];
							const next = keep.filter((message) => message !== removed);
							for (const message of next) {
								this.connection!.send({ type: "prompt", message, streamingBehavior: "followUp" });
							}
						}
					},
				);
			});
			queue.mount();
			while (queueHost.firstChild) queueHost.removeChild(queueHost.firstChild);
			queueHost.appendChild(queue.element);
		}
	}

	private handleServerMessage(message: ServerMessage): void {
		const type = (message as { type?: string }).type;
		switch (type) {
			case "connected": {
				const connected = message as never as ConnectedPayload;
				this.store.applyConnected(connected);
				if (connected.themes && connected.theme) {
					this.store.setThemes(connected.themes, connected.theme.name);
					applyThemeVars(connected.theme.vars);
				}
				this.mountEditorViews();
				this.maybeShowTrustDialog();
				// Reopen extension dialogs that were pending when the page
				// reloaded — otherwise the tool call hangs forever.
				for (const request of connected.pendingUiRequests ?? []) {
					this.handleExtensionUiRequest(request);
				}
				break;
			}
			case "server_shutdown":
				this.showShutdownOverlay(String((message as { reason?: string }).reason ?? ""));
				break;
			case "theme_changed": {
				const themeChange = message as { name: string; vars: Record<string, string> };
				this.store.applyThemeChanged(themeChange.name);
				applyThemeVars(themeChange.vars);
				break;
			}
			case "auth_changed":
				// Refresh header/provider info lazily.
				break;
			case "extension_ui_request":
				this.handleExtensionUiRequest(message as ExtensionUiRequestMessage);
				break;
			case "response":
				break;
			default:
				this.store.applyAgentEvent(message as AgentEventMessage);
				break;
		}
	}

	private handleExtensionUiRequest(request: ExtensionUiRequestMessage): void {
		const connection = this.connection;
		if (!connection) return;
		const respond = (response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void => {
			if (response.cancelled) {
				connection.sendRaw(extensionUiResponse({ id: request.id, cancelled: true }));
			} else if (response.confirmed !== undefined) {
				connection.sendRaw(extensionUiResponse({ id: request.id, confirmed: response.confirmed }));
			} else if (response.value !== undefined) {
				connection.sendRaw(extensionUiResponse({ id: request.id, value: response.value }));
			}
		};

		switch (request.method) {
			case "notify":
				this.store.pushNotification(
					request.message ?? "",
					(request.notifyType as "info" | "warning" | "error") ?? "info",
				);
				return;
			case "setStatus":
				this.store.setExtensionStatus(request.statusKey ?? "", request.statusText);
				return;
			case "setWidget":
				this.store.setWidget(
					request.widgetKey ?? "",
					request.widgetLines,
					request.widgetPlacement ?? "aboveEditor",
				);
				return;
			case "setWidgetData":
				this.store.setWidgetData(request.widgetKey ?? "", request.widgetData);
				return;
			case "setTitle":
				document.title = request.text ?? "pi";
				return;
			case "set_editor_text":
				this.editor.setText(request.text ?? "");
				return;
			case "setWorkingIndicator":
				this.store.setWorkingIndicator(request.frames, request.intervalMs);
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
			for (const node of this.transcript.element.querySelectorAll(".transcript-item")) {
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
