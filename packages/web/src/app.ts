/**
 * App shell: startup header, slash command routing, keyboard shortcuts,
 * tree browser, share/import/export, reconnect overlay, transcript search.
 */

import { EditorToolbar } from "./components/editor-toolbar.ts";
import { openAnchoredMenu } from "./components/kit.ts";
import { McpLocalModal } from "./components/mcp-local-modal.ts";
import { SessionPanel } from "./components/session-panel.ts";
import { contextMenu, StatusBarView } from "./components/status-bar.ts";
import { connect, extensionUiResponse, type PiConnection } from "./connection.ts";
import {
	applyThemeVars,
	DialogStack,
	openAuthEventDialog,
	openExtensionUiDialog,
	openSessionInfo,
	openSessionSelector,
	openSettingsDialog,
	openTrustDialog,
} from "./dialogs.ts";
import { h } from "./dom.ts";
import { EditorController, type EditorSubmitEvent } from "./editor/editor.ts";
import { decorateFileRefs } from "./file-refs.ts";
import { QueueView, StatusRowsView, ToastsView, WidgetAreaView } from "./footer.ts";
import { appendPromptHistory, loadPromptHistory, savePromptHistory } from "./history.ts";
import { registerGlobalKeyboard, type ShortcutAction } from "./keyboard.ts";
import { renderMarkdown, sanitizeMarkdownHtml } from "./markdown.ts";
import { type ChatHosts, createChatPage } from "./pages/chat.ts";
import { createHomePage } from "./pages/home.ts";
import { createMcpPage } from "./pages/mcp.ts";
import { createProjectsPage, type ProjectContextFiles } from "./pages/projects.ts";
import { createSettingsPage } from "./pages/settings.ts";
import { createUsagePage } from "./pages/usage.ts";
import { PreviewStore } from "./preview-store.ts";
import { decorateCodeBlockCopies } from "./render/messages.ts";
import { PreviewView } from "./render/preview.ts";
import { SidebarView } from "./render/sidebar.ts";
import { TranscriptView } from "./render/transcript.ts";
import type { McpWidgetData } from "./render/widget-data.ts";
import { WidgetOverlayView } from "./render/widget-overlay.ts";
import { type PageId, type Route, Router } from "./router.ts";
import { AppShell, type ShellPage } from "./shell.ts";
import { Store } from "./state.ts";
import type {
	AgentEventMessage,
	ConnectedPayload,
	ConnectedSession,
	ExtensionUiRequestMessage,
	ReadFileData,
	RpcSessionSummary,
	RpcTrustState,
	ServerMessage,
	SessionClosedMessage,
	SessionOpenedMessage,
	SessionReplacedMessage,
	StatPathsData,
} from "./types.ts";
import { fetchUsageSummary, usageCostByFile } from "./usage-client.ts";

/** Browser-tab favicon for idle (matches index.html) and running states. */
const FAVICON_IDLE =
	"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>\u03c0</text></svg>";
const FAVICON_RUNNING = `data:image/svg+xml,${encodeURIComponent(
	"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>\u03c0</text><circle cx='13.5' cy='2.5' r='2.5' fill='#4caf50'/></svg>",
)}`;

/** Session-bound view bundle — rebuilt when the active session changes. */
interface SessionViews {
	header: HTMLElement;
	transcript: TranscriptView;
	toolbar: EditorToolbar;
	statusBar: StatusBarView;
	panel: SessionPanel;
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
	/** Inline ask-user card host (above the editor, below widgets). */
	private askHost!: HTMLElement;
	/** Mounted inline ask cards by extension request id (dedupe on rehydrates). */
	private readonly inlineAsks = new Map<string, HTMLElement>();
	/** Submitted-prompt history, newest last (localStorage-backed). */
	private promptHistory: string[] = loadPromptHistory();
	/** Tab title owned by extensions; the running pulse composes on top. */
	private baseTitle = "pi";
	/** Last observed all-sessions running state (tab status diffing). */
	private anySessionRunning = false;
	/** Editor drafts per session, preserved across switches. */
	private readonly editorDrafts = new Map<string, string>();
	/** Console shell (rail + page host) and its hash router. */
	private shell: AppShell | undefined;
	private router: Router | undefined;
	/** Registered pages; built lazily per route (chat registers at boot). */
	private readonly pages = new Map<PageId, ShellPage>();
	private mountedPage: ShellPage | undefined;
	/** Settings deep-link state: rebuild the page when the section hash changes. */
	private lastSettingsSection: string | undefined;
	/** Live widget-data feed subscribers (MCP page et al.), keyed to nothing. */
	private readonly widgetSubscribers = new Set<(data: McpWidgetData | undefined) => void>();
	/** Home hero prompt waiting for the session it created (sent once active). */
	private pendingPrompt: string | undefined;
	/** Chat workbench hosts — rebuilt session views bind into these. */
	private chatHosts: ChatHosts | undefined;
	/** Active session's editor toolbar (model-picker anchor for Ctrl+K). */
	private activeToolbar: EditorToolbar | undefined;
	/** App-level file preview state (survives session switches). */
	private readonly previewStore = new PreviewStore();
	private previewView: PreviewView | undefined;
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

		// Console shell (spec §3.1): icon rail + page host; hash routes swap
		// the page below the rail. App keeps owning sessions/connection.
		this.shell = new AppShell({
			onNavigate: (page) =>
				this.router?.navigate(
					page === "chat" && this.activeSessionId !== undefined
						? { page, sessionId: this.activeSessionId }
						: { page },
				),
		});
		this.element.appendChild(this.shell.element);
		this.updateDensityClass();

		// File preview panel: content-driven, hidden when closed; the chat
		// page hosts it as a flex sibling of the main column.
		this.previewView = new PreviewView(this.previewStore, {
			onActivate: (id) => this.previewStore.activate(id),
			onCloseTab: (id) => this.previewStore.closeTab(id),
			onLoadMore: () => void this.loadMorePreview(),
			onRetry: () => this.retryPreview(),
		});
		this.previewView.mount();

		// Global (session-independent) chrome. Toasts render notifications pushed
		// to the active session's store, so the view is rebuilt with the other
		// session views.
		this.toastsHost = h("div", {});
		this.overlayHost = h("div", {});
		document.body.appendChild(this.toastsHost);
		document.body.appendChild(this.overlayHost);
		this.dialogs = new DialogStack(document.body);

		// The multi-session sidebar (session list, groups, running spinners) —
		// hosted inside the chat page's left column.
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

		// Chat workbench page — mounts under the shell; its hosts receive the
		// per-session views rebuilt by rebuildSessionViews().
		const chatPage = createChatPage({
			sidebar: () => this.sidebar,
			previewElement: () => this.previewView?.element,
			openModelPicker: () => this.openModelPicker(),
		});
		this.chatHosts = chatPage.hosts;
		this.askHost = chatPage.hosts.askHost;
		this.pages.set("chat", chatPage);
		this.sidebar.mount();

		// The editor controller is session-agnostic (drafts switch per store);
		// attach it eagerly so the dock renders before the first connect.
		this.buildEditorHost();
		if (this.editor && this.chatHosts) {
			this.chatHosts.editorHost.replaceChildren(this.editor.element);
		}

		// Default landing: #/chat. Hash routes drive everything after this.
		if (!window.location.hash) {
			window.history.replaceState(null, "", "#/chat");
		}
		this.router = new Router((route) => this.onRoute(route));
		this.router.start();

		this.wireConnection();
	}

	// ------------------------------------------------------------------
	// Page deps (integration wiring for the five console pages)
	// ------------------------------------------------------------------

	/**
	 * Deps shared by the five console pages (spec §3.3–3.8). Pages stay dumb:
	 * every behavioral decision lives here, in the app, next to the sessions
	 * and the connection it owns.
	 */
	private buildPageDeps() {
		const navigate = (page: "chat" | "home" | "projects" | "mcp" | "usage" | "settings"): void => {
			this.router?.navigate(
				page === "chat" && this.activeSessionId !== undefined
					? { page: "chat", sessionId: this.activeSessionId }
					: { page },
			);
		};
		const fetchSessions = (): Promise<RpcSessionSummary[]> =>
			(
				this.connection?.request<{ sessions: RpcSessionSummary[] }>({ type: "list_sessions", scope: "all" }) ??
				Promise.reject(new Error("not connected"))
			).then((data) => data.sessions ?? []);
		const openSessions = (): Array<{ id: string; cwd: string; running: boolean }> => {
			const rows: Array<{ id: string; cwd: string; running: boolean }> = [];
			for (const [id, store] of this.sessionStores) {
				rows.push({
					id,
					cwd: store.getState().contextInfo?.cwd ?? "",
					running: store.isTurnRunning() || (store.getState().sessionState?.isStreaming ?? false),
				});
			}
			return rows;
		};
		const pushToast = (message: string, level: "info" | "warning" | "error"): void => {
			this.store.pushNotification(message, level);
		};
		/** Per-file session costs for the projects page (all-time summary). */
		const usageByFile = (): Promise<Map<string, number>> => {
			if (!this.connection) return Promise.reject(new Error("not connected"));
			return fetchUsageSummary(this.connection, 0).then((summary) => usageCostByFile(summary));
		};
		const fetchSummary = (
			rangeDays: number,
		): Promise<ReturnType<typeof fetchUsageSummary> extends Promise<infer T> ? T : never> => {
			if (!this.connection) return Promise.reject(new Error("not connected"));
			return fetchUsageSummary(this.connection, rangeDays);
		};
		const projectCwd = (): string | undefined => {
			const primaryId = this.connectedBase.primarySessionId;
			const primaryStore = primaryId !== undefined ? this.sessionStores.get(primaryId) : undefined;
			return (primaryStore ?? this.store).getState().contextInfo?.cwd;
		};
		const openPreview = (path: string): void => {
			void this.openPreview(path, this.activeSessionId);
		};
		const openSession = (fileOrId: string): void => {
			// Already-open slot ids activate directly; anything else is a disk file.
			if (this.sessionStores.has(fileOrId)) {
				this.setActiveSession(fileOrId);
				navigate("chat");
				return;
			}
			const connection = this.connection;
			if (!connection) return;
			void connection
				.request<{ sessionId?: string }>({ type: "open_session", sessionPath: fileOrId })
				.then((data) => {
					if (typeof data?.sessionId === "string") {
						this.pendingFocus = data.sessionId;
						navigate("chat");
					}
				})
				.catch((error: Error) => pushToast(`Could not open session: ${error.message}`, "error"));
		};
		const newSession = (cwd: string | undefined): void => {
			const connection = this.connection;
			if (!connection) return;
			void connection
				.request<{ sessionId?: string }>({ type: "new_session", cwd })
				.then((data) => {
					if (typeof data?.sessionId === "string") this.pendingFocus = data.sessionId;
					navigate("chat");
				})
				.catch((error: Error) => pushToast(`Could not start session: ${error.message}`, "error"));
		};
		return {
			home: {
				connection: () => this.connection,
				fetchSessions,
				fetchSummary,
				subscribeWidget: (cb: (data: McpWidgetData | undefined) => void) => this.subscribeWidget(cb),
				openSessions,
				currentVersion: () => this.store.getState().contextInfo?.version ?? this.store.getState().version,
				primaryCwd: projectCwd,
				onOpenSession: openSession,
				onNewSession: newSession,
				onNavigate: navigate,
				runPrompt: (text: string) => this.runPrompt(text),
				modelPickerAnchor: () => this.modelPickerAnchor(),
				onOpenModels: (anchor: HTMLElement) => this.activeToolbar?.openModelPicker(anchor),
			},
			projects: {
				connection: () => this.connection,
				onNavigate: navigate,
				fetchSessions,
				openSessions,
				projectContext: (cwd: string) => this.projectContext(cwd),
				onOpenSession: openSession,
				onNewSession: newSession,
				openPreview,
				// issue batch 3 (lane C): folder validation for the New project dialog.
				validatePath: (path: string): Promise<{ ok: boolean; reason?: string }> => {
					const connection = this.connection;
					if (!connection) return Promise.resolve({ ok: false, reason: "not connected" });
					return connection
						.request<StatPathsData>({ type: "stat_paths", paths: [path] })
						.then((data) => {
							const result = data.results.find((entry) => entry.path === path) ?? data.results[0];
							if (!result?.exists) return { ok: false, reason: `folder not found: ${path}` };
							if (result.kind && result.kind !== "dir") return { ok: false, reason: `not a folder: ${path}` };
							return { ok: true };
						})
						.catch((error: Error) => ({ ok: false as const, reason: error.message }));
				},
				pushToast,
				/** Session-table actions (rename/fork/export/share/delete). */
				onRowAction: (action: "rename" | "fork" | "export" | "share" | "delete", session: RpcSessionSummary) =>
					this.onSessionAction(action, [session]),
				onBatchAction: (
					action: "rename" | "fork" | "export" | "share" | "delete",
					sessions: Array<RpcSessionSummary>,
				) => this.onSessionAction(action, sessions),
				usageByFile,
			},
			mcp: {
				connection: () => this.connection,
				subscribeWidget: (cb: (data: McpWidgetData | undefined) => void) => this.subscribeWidget(cb),
				projectCwd,
				onNavigate: navigate,
				openPreview,
				pushToast,
				// Lane F: /mcp-auth sign-in fallback runs the command in chat
				// (auto-run); the editor draft stays as the no-runCommand fallback.
				promptDraft: (text: string) => this.promptDraft(text),
				runCommand: (text: string) => this.runSlashCommand(text),
			},
			usage: {
				connection: () => this.connection,
				fetchSummary,
				openSession,
				onNavigate: navigate,
			},
			settings: {
				connection: () => this.connection,
				activeStore: () => (this.sessionStores.size > 0 ? this.store : undefined),
				onNavigate: navigate,
				pushToast,
				setDensity: (on: boolean) => this.setDensity(on),
			},
		};
	}

	/** Drop text into the chat editor (focused) and switch to the Chat page. */
	private promptDraft(text: string): void {
		this.editor.setText(text);
		this.router?.navigate({ page: "chat" });
	}

	/**
	 * Auto-run a slash command in the active chat session: switch to Chat and
	 * send it as a prompt (the server echoes the user message + command output
	 * through the normal agent events, so no editor round-trip is needed).
	 * Used by the MCP sign-in fallback (`/mcp-auth <server>`).
	 * request() settles after the prompt preflight, so a rejection (e.g. the
	 * session is mid-stream) falls back to the editor draft instead of silently
	 * dropping the command — the sign-in must never look like it did nothing.
	 */
	private runSlashCommand(text: string): void {
		this.router?.navigate({ page: "chat" });
		const connection = this.connection;
		if (!connection) {
			this.promptDraft(text);
			return;
		}
		connection.request({ type: "prompt", message: text }).catch(() => this.promptDraft(text));
	}

	/** Batch-4 B6: open the local MCP manager modal from the status-bar chip. */
	private openMcpLocal(): void {
		if (!this.mcpLocalModal) {
			this.mcpLocalModal = new McpLocalModal({
				connection: () => this.connection,
				subscribeWidget: (cb: (data: McpWidgetData | undefined) => void) => this.subscribeWidget(cb),
				// The modal follows the ACTIVE session's cwd (the status bar lives in it).
				projectCwd: () => this.store.getState().contextInfo?.cwd ?? undefined,
				openPreview: (path) => void this.openPreview(path, this.activeSessionId),
				pushToast: (message, level) => this.store.pushNotification(message, level),
				promptDraft: (text) => this.promptDraft(text),
				runCommand: (text) => this.runSlashCommand(text),
			});
		}
		this.mcpLocalModal.open();
	}

	/** Widget feed for MCP/Home: replay + active-store updates, switch-aware. */
	private subscribeWidget(cb: (data: McpWidgetData | undefined) => void): () => void {
		this.widgetSubscribers.add(cb);
		cb(this.readMcpWidget());
		return () => this.widgetSubscribers.delete(cb);
	}

	private readMcpWidget(): McpWidgetData | undefined {
		const widget = this.store.getState().widgets.get("pi-mcp-status");
		const data = widget?.data;
		if (data === null || typeof data !== "object" || !("kind" in data)) return undefined;
		return data as Record<string, unknown> as unknown as McpWidgetData;
	}

	private emitWidgetData(): void {
		const data = this.readMcpWidget();
		for (const cb of this.widgetSubscribers) cb(data);
	}

	/** Wire a store's widget changes into the subscriber set (active only). */
	private bindStoreWidgetFeed(store: Store): void {
		store.subscribe(() => {
			if (store === this.store) this.emitWidgetData();
		});
	}

	/** Context files for a project cwd. v1: only the ACTIVE session's cwd is queryable
	 *  because get_context_info is routed to the active slot. Other projects get their
	 *  hint state. Documented in integration-report. */
	private async projectContext(cwd: string): Promise<ProjectContextFiles | undefined> {
		const connection = this.connection;
		if (!connection) return undefined;
		if ((this.store.getState().contextInfo?.cwd ?? "") !== cwd) return undefined;
		try {
			const data = await connection.request<{
				contextFiles: Array<{ path: string; source: string }>;
			}>({ type: "get_context_info" });
			return { contextFiles: data.contextFiles ?? [] };
		} catch {
			return undefined;
		}
	}

	/** Toolbar anchor for /model-range lookups (Home chip + keyboard shortcut). */
	/** Density (R21b): persist locally and toggle the shell class live. */
	private setDensity(on: boolean): void {
		if (on) window.localStorage.setItem("pi-web-density", "1");
		else window.localStorage.removeItem("pi-web-density");
		this.updateDensityClass();
	}

	private updateDensityClass(): void {
		this.shell?.element.classList.toggle("density-compact", window.localStorage.getItem("pi-web-density") === "1");
	}

	private modelPickerAnchor(): HTMLElement | undefined {
		const toolbar = this.activeToolbar;
		if (!toolbar) return undefined;
		const first = toolbar.element.firstElementChild;
		return first instanceof HTMLElement ? first : undefined;
	}

	/** Home hero: ensure a session, then send through the normal prompt pipeline. */
	private runPrompt(text: string): void {
		if (!this.connection) {
			this.store.pushNotification("Not connected yet", "warning");
			return;
		}
		if (this.sessionStores.size === 0) {
			// No slot yet: create one, hold the prompt until it is active.
			this.pendingPrompt = text;
			void this.connection
				.request<{ sessionId?: string }>({ type: "new_session" })
				.then((data) => {
					if (typeof data?.sessionId === "string") this.pendingFocus = data.sessionId;
				})
				.catch(() => {
					this.pendingPrompt = undefined;
					this.store.pushNotification("Could not start a session", "error");
				});
			this.router?.navigate({ page: "chat" });
			return;
		}
		if (this.activeSessionId === undefined) {
			const first = [...this.sessionStores.keys()][0];
			if (first !== undefined) this.setActiveSession(first);
		}
		this.router?.navigate({ page: "chat", sessionId: this.activeSessionId });
		this.handlePromptText(text);
	}

	/** Send a pending hero prompt once its target session became active. */
	private maybeFlushPendingPrompt(): void {
		if (this.pendingPrompt !== undefined && this.activeSessionId !== undefined) {
			const text = this.pendingPrompt;
			this.pendingPrompt = undefined;
			this.handlePromptText(text);
		}
	}

	/** Session-table actions with confirms where they matter (spec §3.3). Commands
	 *  that act on a slot (export/share/fork) carry an explicit sessionId tag so
	 *  they target the right session even when it is not the active one; file-path
	 *  commands (rename/delete) need no slot. */
	private onSessionAction(
		action: "rename" | "fork" | "export" | "share" | "delete",
		sessions: Array<RpcSessionSummary>,
	): void {
		if (sessions.length === 0 || !this.connection) return;
		const connection = this.connection;
		if (action === "rename") {
			// Protocol renames one session per call; batch rename would silently
			// apply to sessions[0] only — refuse multi and keep the row action.
			if (sessions.length > 1) {
				this.store.pushNotification("Rename one session at a time — select a single row.", "warning");
				return;
			}
			const name = window.prompt("Rename session", sessions[0].name ?? sessions[0].file);
			if (!name) return;
			void connection
				.request({ type: "rename_session", sessionPath: sessions[0].file, name })
				.then(() => this.refreshSessionsList())
				.catch((error: Error) => this.store.pushNotification(error.message, "error"));
			return;
		}
		if (action === "delete") {
			const label =
				sessions.length === 1 ? `“${sessions[0].name ?? sessions[0].file}”` : `${sessions.length} sessions`;
			if (!window.confirm(`Delete ${label}? This moves them to trash.`)) return;
			for (const session of sessions) {
				void connection
					.request({ type: "delete_session", sessionPath: session.file })
					.then(() => this.refreshSessionsList())
					.catch(() => {});
			}
			return;
		}
		for (const session of sessions) {
			if (action === "fork") {
				// Fork edits history on a live slot: open the session first, then
				// open the fork picker against the newly-opened slot.
				void connection
					.request<{ sessionId?: string }>({ type: "open_session", sessionPath: session.file })
					.then((data) => {
						if (typeof data?.sessionId === "string") {
							this.pendingFocus = data.sessionId;
							this.router?.navigate({ page: "chat", sessionId: data.sessionId });
							this.openForkPicker(data.sessionId);
						}
					})
					.catch(() => {});
			} else if (action === "export") {
				const openId = this.sessionIdForFile(session.file);
				if (openId) {
					void connection
						.request<{ path: string }>({
							type: "export_session",
							path: `${session.file}.html`,
							sessionId: openId,
						})
						.then((data) => this.store.pushNotification(`Exported to: ${data.path}`, "info"))
						.catch((error: Error) => this.store.pushNotification(error.message, "error"));
				} else {
					// Not open: export needs a live slot — open it; the user re-runs export.
					this.store.pushNotification(
						`“${session.name ?? session.file}” must be open to export — opening it`,
						"warning",
					);
					void connection
						.request<{ sessionId?: string }>({ type: "open_session", sessionPath: session.file })
						.then((data) => {
							if (typeof data?.sessionId === "string") this.pendingFocus = data.sessionId;
						})
						.catch(() => {});
				}
			} else {
				const openId = this.sessionIdForFile(session.file);
				if (!openId) {
					this.store.pushNotification("Session must be open to share — opening it", "warning");
					void connection
						.request<{ sessionId?: string }>({ type: "open_session", sessionPath: session.file })
						.then((data) => {
							if (typeof data?.sessionId === "string") this.pendingFocus = data.sessionId;
						})
						.catch(() => {});
					continue;
				}
				void connection
					.request<{ url?: string; gistUrl?: string }>({ type: "share_session", sessionId: openId })
					.then((data) => this.store.pushNotification(`Share URL: ${data.url ?? data.gistUrl ?? ""}`, "info"))
					.catch((error: Error) => this.store.pushNotification(error.message, "error"));
			}
		}
	}

	/** Slot id for a session file, when that session is open. */
	private sessionIdForFile(file: string): string | undefined {
		for (const [id, store] of this.sessionStores) {
			const sessionFile = store.getState().sessionState?.sessionFile;
			if (sessionFile === file) return id;
		}
		return undefined;
	}

	/** Resolve a hash route to its page; unknown routes fall back to home. */
	private onRoute(route: Route): void {
		// Settings section deep links rebuild the page (its sections are baked
		// into the instance; a new hash ⇒ fresh instance with that section).
		if (route.page === "settings" && this.lastSettingsSection !== route.section) {
			this.lastSettingsSection = route.section;
			this.pages.delete("settings");
		}
		const page = this.ensurePage(route.page);
		this.shell?.setActive(route.page);
		if (this.mountedPage !== page) {
			this.shell?.setPage(page);
			this.mountedPage = page;
		}
		// Deep link: #/chat/<sessionId> activates that session's store.
		if (route.page === "chat" && route.sessionId && this.sessionStores.has(route.sessionId)) {
			this.setActiveSession(route.sessionId);
		}
	}

	/** Build (and cache) the page for a route. Real pages for everything now. */
	private ensurePage(page: PageId): ShellPage {
		const existing = this.pages.get(page);
		if (existing) return existing;
		const deps = this.buildPageDeps();
		let created: ShellPage | undefined;
		switch (page) {
			case "home":
				created = createHomePage(deps.home);
				break;
			case "projects":
				created = createProjectsPage(deps.projects, {
					activePath: () => this.router?.current().pathArg,
				});
				break;
			case "mcp":
				created = createMcpPage(deps.mcp);
				break;
			case "usage":
				created = createUsagePage(deps.usage);
				break;
			case "settings":
				created = createSettingsPage(deps.settings, {
					initialSection: this.router?.current().section,
					onSectionChange: (section) => this.router?.navigate({ page: "settings", section }, true),
				});
				break;
			case "chat":
				// Registered at boot with its session-bound hosts.
				break;
		}
		if (!created) throw new Error(`No page registered for route: ${page}`);
		this.pages.set(page, created);
		if (page === "settings" && this.lastSettingsSection === undefined) {
			this.lastSettingsSection = this.router?.current().section ?? "general";
		}
		return created;
	}

	/** Session to focus once its pane exists (open/new in flight). */
	private pendingFocus: string | undefined;
	/** Toast host — the view inside is rebuilt with the session views. */
	private toastsHost!: HTMLElement;
	/** Overlay-widget modal host, likewise rebuilt per active session. */
	private overlayHost!: HTMLElement;
	/** Batch-4 B6: status-bar-chip local MCP manager; lazily built, reused. */
	private mcpLocalModal: McpLocalModal | undefined;

	/** Rebuild the session-bound views for the active store. */
	private rebuildSessionViews(): void {
		this.views?.unmount();
		const store = this.store;
		const sessionId = this.activeSessionId;
		const connection = this.connection;
		const hosts = this.chatHosts;
		if (!hosts || !connection) return;

		const header = this.buildHeader();
		const decorate = (element: HTMLElement): void => {
			decorateCodeBlockCopies(element);
			if (!connection) return;
			decorateFileRefs(element, {
				sessionId,
				statPaths: async (paths) => {
					const data = await connection.request<StatPathsData>({ type: "stat_paths", paths, sessionId });
					return data.results;
				},
			});
		};
		const transcript = new TranscriptView({
			store,
			showImages: true,
			decorate,
			onOpenFile: (path) => void this.openPreview(path, sessionId),
			onStopBash: () => this.sendAbortBash(),
		});
		const widgetsAbove = new WidgetAreaView(store, "aboveEditor");
		const widgetsBelow = new WidgetAreaView(store, "belowEditor");
		const statusRows = new StatusRowsView(store, connection);
		const queue = new QueueView(store, (kind, index) => {
			void connection.request<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" }).then((result) => {
				const keep = [...(result.steering ?? []), ...(result.followUp ?? [])];
				if (kind === "steering" && result.steering) {
					const removed = result.steering[index];
					const next = keep.filter((message) => message !== removed);
					for (const message of next) {
						connection.send({ type: "prompt", message, streamingBehavior: "steer" });
					}
				} else if (result.followUp) {
					const removed = result.followUp[index];
					const next = keep.filter((message) => message !== removed);
					for (const message of next) {
						connection.send({ type: "prompt", message, streamingBehavior: "followUp" });
					}
				}
			});
		});
		const overlay = new WidgetOverlayView(
			store,
			(message) => {
				connection?.send({ type: "prompt", message });
			},
			(key, payload) => {
				void connection?.request({ type: "widget_response", key, payload }).catch(() => {});
			},
			hosts.askHost,
		);

		// Overlay widgets (questionnaires, MCP panels) render as modals on
		// top of the app; their element lives on the body, remounted per switch.
		this.overlayHost.replaceChildren(overlay.element);
		hosts.transcriptHost.replaceChildren(header, transcript.element);
		hosts.statusRowsHost.replaceChildren(statusRows.element);
		hosts.queueHost.replaceChildren(queue.element);
		hosts.widgetsAboveHost.replaceChildren(widgetsAbove.element);
		hosts.widgetsBelowHost.replaceChildren(widgetsBelow.element);
		if (this.editor && this.editor.element.parentElement !== hosts.editorHost) {
			hosts.editorHost.replaceChildren(this.editor.element);
		}

		const openSessionPreview = (path: string): void => {
			this.openPreview(path, sessionId);
		};

		// Page-scoped trio — bound to this session's store, rebuilt per switch.
		const toolbar = new EditorToolbar({
			connection,
			store,
			onPrimaryAction: (kind) => this.onEditorPrimary(kind),
			onQueuePrompt: () => this.editor.submitQueued(),
		});
		this.activeToolbar = toolbar;
		hosts.toolbarHost.replaceChildren(toolbar.element);

		const statusBar = new StatusBarView(store, {
			onOpenModels: (anchor) => toolbar.openModelPicker(anchor),
			onOpenContext: (anchor) => this.openContextMenu(anchor),
			onOpenMcpLocal: () => this.openMcpLocal(),
		});
		hosts.statusBarHost.replaceChildren(statusBar.element);

		const panel = new SessionPanel({ store, connection, openPreview: openSessionPreview });
		hosts.panelHost.replaceChildren(panel.element);

		transcript.mount(hosts.transcriptWrap);
		statusRows.mount();
		queue.mount();
		widgetsAbove.mount();
		widgetsBelow.mount();
		overlay.mount();
		toolbar.mount();
		statusBar.mount();
		panel.mount();

		const toasts = new ToastsView(store);
		this.toastsHost.replaceChildren(toasts.element);
		toasts.mount();

		this.views = {
			header,
			transcript,
			toolbar,
			statusBar,
			panel,
			widgetsAbove,
			widgetsBelow,
			overlay,
			statusRows,
			queue,
			unmount: () => {
				transcript.unmount();
				statusRows.unmount();
				queue.unmount();
				widgetsAbove.unmount();
				widgetsBelow.unmount();
				overlay.unmount();
				toolbar.unmount();
				statusBar.unmount();
				panel.unmount();
				toasts.unmount();
				this.activeToolbar = undefined;
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

	/** Sends { type: "abort_bash" } — the session's current bash process. */
	private sendAbortBash(): void {
		this.connection?.send({ type: "abort_bash" });
	}

	/** Send↔Stop primary action (spec §5). Stop wins over retry countdowns. */
	private onEditorPrimary(kind: "send" | "stop"): void {
		const connection = this.connection;
		if (!connection) return;
		if (kind === "stop") {
			connection.send({ type: this.store.getState().retry ? "abort_retry" : "abort" });
			return;
		}
		this.editor.submitFromToolbar();
	}

	/** Ctrl+K / ⌘K: open the model picker anchored at the toolbar's model chip. */
	private openModelPicker(): void {
		const toolbar = this.activeToolbar;
		if (!toolbar) return;
		const first = toolbar.element.firstElementChild;
		const anchor = first instanceof HTMLElement ? first : toolbar.element;
		toolbar.openModelPicker(anchor);
	}

	/** Context chip popover: compact now / auto-compaction toggle (spec §3.2.5, R3). */
	private openContextMenu(anchor: HTMLElement): void {
		const connection = this.connection;
		if (!connection) return;
		const session = this.store.getState().sessionState;
		openAnchoredMenu(
			anchor,
			contextMenu(
				{
					onCompactNow: () => connection.send({ type: "compact" }),
					onToggleAuto: (next) => {
						void connection.request({ type: "set_auto_compaction", enabled: next }).catch(() => {});
					},
				},
				{ auto: session?.autoCompactionEnabled ?? false },
			),
		);
	}

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
			history: { entries: () => this.promptHistory },
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
		this.promptHistory = appendPromptHistory(this.promptHistory, event.text);
		savePromptHistory(this.promptHistory);
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

	// ------------------------------------------------------------------
	// File preview
	// ------------------------------------------------------------------

	private async openPreview(path: string, sessionId: string | undefined): Promise<void> {
		const connection = this.connection;
		if (!connection) return;
		const tabId = this.previewStore.open(path, sessionId);
		try {
			const data = await connection.request<ReadFileData>({ type: "read_file", path, sessionId });
			// Superseded check: the tab was re-opened, closed, or replaced its
			// content while this request was in flight — drop the response.
			const tab = this.previewStore.getTab(tabId);
			if (!tab || tab.path !== path || tab.status !== "loading") return;
			if (data.kind === "text") this.previewStore.setText(data, tabId);
			else if (data.kind === "image") this.previewStore.setImage(data, tabId);
			else if (data.kind === "notebook") this.previewStore.setNotebook(data, tabId);
			else if (data.kind === "spreadsheet") this.previewStore.setSpreadsheet(data, tabId);
			else if (data.kind === "document") this.previewStore.setDocument(data, tabId);
			else this.previewStore.setUnsupported(data, tabId);
		} catch (error: unknown) {
			const tab = this.previewStore.getTab(tabId);
			if (tab && tab.path === path && tab.status === "loading") {
				this.previewStore.setError(error instanceof Error ? error.message : String(error), tabId);
			}
		}
	}

	private async loadMorePreview(): Promise<void> {
		const connection = this.connection;
		const state = this.previewStore.getState();
		if (!connection || !state || state.status !== "ready" || state.kind !== "text") return;
		const tabId = state.id;
		const offset = (state.shownLines ?? 0) + 1;
		try {
			const data = await connection.request<ReadFileData>({
				type: "read_file",
				path: state.path,
				offset,
				sessionId: state.sessionId,
			});
			if (data.kind === "text") {
				// Apply only if this chunk is still the next one for the same tab —
				// drops stale responses after a switch or a duplicate Load more.
				const tab = this.previewStore.getTab(tabId);
				if (
					tab &&
					tab.path === state.path &&
					tab.status === "ready" &&
					tab.kind === "text" &&
					(tab.shownLines ?? 0) === offset - 1
				) {
					this.previewStore.appendText(data, tabId);
				}
			}
		} catch (error: unknown) {
			const tab = this.previewStore.getTab(tabId);
			if (tab && tab.path === state.path && tab.kind === "text") {
				this.previewStore.setError(error instanceof Error ? error.message : String(error), tabId);
			}
		}
	}

	private retryPreview(): void {
		const state = this.previewStore.getState();
		if (state) void this.openPreview(state.path, state.sessionId);
	}

	private handleEscape(): void {
		if (this.previewStore.getState()) {
			this.previewStore.close();
			return;
		}
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
				this.router?.navigate({ page: "settings" });
				return true;
			case "advanced":
				// Legacy settings grid (transport, hideThinkingBlock, …) until every
				// key gets a settings-page section (integration report tracks it).
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
				this.openModelPicker();
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
				this.activeToolbar?.revealThinkingPicker();
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
				this.router?.navigate({ page: "settings", section: "about" });
				return true;
			case "hotkeys":
				this.router?.navigate({ page: "settings", section: "keybindings" });
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
					getOpenSessionPaths: () => this.sidebar?.getOpenSessionPaths() ?? [],
					onSessionsChanged: () => this.refreshSessionsList(),
				});
				return true;
			case "reload":
				void connection.request({ type: "reload" }).then(() => this.syncAfterSessionSwitch());
				store.pushNotification("Reloaded", "info");
				return true;
			case "quit": {
				// window.close() is blocked for tabs the browser opened; closing the
				// active slot gives the command real meaning (primary cannot close).
				const activeId = this.activeSessionId;
				if (activeId === undefined) return true;
				if (store.isTurnRunning() && !window.confirm("This session is still running. Close it anyway?")) {
					return true;
				}
				void connection
					.request<{ closed?: boolean; reason?: string }>({ type: "close_session", sessionId: activeId })
					.then((data) => {
						if (data.closed) store.pushNotification("Session closed", "info");
						else if (data.reason === "primary")
							store.pushNotification(
								"The primary session cannot be closed — close the browser tab to quit",
								"warning",
							);
						else store.pushNotification("Session not found; it may already be closed", "warning");
					})
					.catch((error: Error) => store.pushNotification(`Close failed: ${error.message}`, "error"));
				return true;
			}
			default:
				return false;
		}
	}

	private openForkPicker(slotId?: string): void {
		const connection = this.connection;
		if (!connection) return;
		const tag = slotId !== undefined ? { sessionId: slotId } : {};
		void connection
			.request<{ messages: Array<{ entryId: string; text: string }> }>({
				type: "get_fork_messages",
				...tag,
			})
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
							void connection.request({ type: "fork", entryId: message.entryId, ...tag }).then(() => {
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
		setInterval(() => this.updateTabStatus(), 500);
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
		// A #/chat/<id> deep link beats the remembered/primary choice: the user
		// explicitly asked for this session when loading the page. (onRoute could
		// not act pre-connect — stores were empty — so reconcile here once.)
		const routeSession = this.router?.current().sessionId;
		const active =
			routeSession !== undefined && this.sessionStores.has(routeSession)
				? routeSession
				: remembered !== undefined && this.sessionStores.has(remembered)
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
		this.bindStoreWidgetFeed(store);
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
		// A home-hero prompt waiting for its freshly-created session.
		this.maybeFlushPendingPrompt();
	}

	/** The last connected payload's global section (themes/keybindings). */
	private connectedBase: ConnectedPayload = { type: "connected", version: "", messages: [] };

	/** Refresh the sidebar's disk session list (all projects). */
	private refreshSessionsList(): void {
		void this.connection
			?.request<{
				sessions: Array<{
					file: string;
					cwd: string;
					name?: string;
					firstMessage?: string;
					modified?: string;
					messageCount?: number;
				}>;
			}>({
				type: "list_sessions",
				scope: "all",
			})
			.then((data) => {
				const sessions = data.sessions ?? [];
				this.sidebar?.setSessionsList(
					sessions.map((session) => ({
						path: session.file,
						cwd: session.cwd,
						name: session.name?.trim() || session.firstMessage,
						modified: new Date(session.modified ?? 0).getTime() || 0,
						// Batch-4 B8: right-meta "N msgs" on chat sidebar rows.
						messageCount: session.messageCount,
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
		// Keep the deep link in sync (replace: session clicks are not history).
		this.router?.navigate({ page: "chat", sessionId: id }, true);
		this.emitWidgetData();
	}

	/** Sessions with a turn (or continuation) in flight; feeds badge + title. */
	private runningSessionCount(): number {
		let count = 0;
		for (const store of this.sessionStores.values()) {
			if (store.isTurnRunning() || (store.getState().sessionState?.isStreaming ?? false)) count++;
		}
		if (this.sessionStores.size === 0 && this.fallbackStore.isTurnRunning()) count++;
		return count;
	}

	/**
	 * Keep the browser tab in sync with session activity: title pulse, favicon
	 * dot, shell rail badge, and a desktop notification on completion when the
	 * tab is hidden and the user already granted permission.
	 */
	private updateTabStatus(): void {
		const runningCount = this.runningSessionCount();
		this.shell?.setRunningBadge(runningCount);
		const running = runningCount > 0;
		if (running === this.anySessionRunning) return;
		const wasRunning = this.anySessionRunning;
		this.anySessionRunning = running;
		document.title = running ? `\u25b6 ${this.baseTitle}` : this.baseTitle;
		const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (icon) icon.href = running ? FAVICON_RUNNING : FAVICON_IDLE;
		if (!running && wasRunning && document.hidden) {
			const NotificationCtor = globalThis.Notification;
			if (NotificationCtor?.permission === "granted") {
				try {
					new NotificationCtor(this.baseTitle, { body: "All turns finished" });
				} catch {
					// Notification construction can throw on some platforms.
				}
			}
		}
	}

	/**
	 * Ask-style extension requests render inline above the editor instead of
	 * as a modal: the question stays visible next to the transcript the user
	 * needs for context ("is this plan ok?" over the plan itself).
	 */
	private renderInlineAsk(
		request: ExtensionUiRequestMessage,
		respond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void,
	): void {
		if (this.inlineAsks.has(request.id)) return;
		const options = (request.options ?? []).map((option) =>
			typeof option === "string" ? { id: option, label: option, description: "" } : option,
		);
		const card = h("div", { class: "inline-ask" });
		const answer = (response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void => {
			if (card.isConnected) respond(response);
			card.remove();
			this.inlineAsks.delete(request.id);
		};

		const label = request.method === "confirm" ? "Confirm" : request.method === "input" ? "Input" : "Select";
		const fromOtherSession = request.sessionId !== undefined && request.sessionId !== this.activeSessionId;
		const header = h(
			"div",
			{ class: "inline-ask-header" },
			h("span", { class: "inline-ask-label" }, label),
			fromOtherSession ? h("span", { class: "inline-ask-source" }, "another session") : undefined,
			h(
				"button",
				{ class: "inline-ask-cancel", title: "Cancel", onclick: () => answer({ cancelled: true }) },
				"\u00d7",
			),
		);
		const body = h("div", { class: "md-body inline-ask-body" });
		const markdown = `${request.title ? `**${request.title}**\n\n` : ""}${request.message ?? ""}`;
		body.innerHTML = sanitizeMarkdownHtml(renderMarkdown(markdown));

		const actions = h("div", { class: "inline-ask-actions" });
		if (request.method === "select") {
			for (const option of options) {
				const button = h(
					"button",
					{ class: "inline-ask-option", title: option.description || undefined },
					option.label,
				);
				button.addEventListener("click", () => answer({ value: option.id }));
				actions.appendChild(button);
			}
		} else if (request.method === "confirm") {
			const yes = h("button", { class: "inline-ask-option primary" }, "Yes");
			yes.addEventListener("click", () => answer({ confirmed: true }));
			const no = h("button", { class: "inline-ask-option" }, "No");
			no.addEventListener("click", () => answer({ confirmed: false }));
			actions.append(yes, no);
		} else if (request.method === "input") {
			const input = h("input", {
				type: "text",
				placeholder: request.placeholder ?? "",
				class: "inline-ask-input",
			}) as HTMLInputElement;
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					answer({ value: input.value });
				}
			});
			const send = h("button", { class: "inline-ask-option primary" }, "Send");
			send.addEventListener("click", () => answer({ value: input.value }));
			actions.append(input, send);
		} else {
			return;
		}
		card.append(header, body, actions);
		this.askHost.appendChild(card);
		this.inlineAsks.set(request.id, card);
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
		// active view may be a different session. Events for a session the
		// client has not registered yet race ahead of its session_opened payload
		// (the server broadcasts extension events during openSession, before
		// session_opened); that payload is authoritative — including
		// pendingUiRequests for dialogs — so drop them rather than letting one
		// session's widgets clobber the active session's store.
		if (request.sessionId !== undefined && !this.sessionStores.has(request.sessionId)) return;
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
				this.baseTitle = request.text ?? "pi";
				document.title = this.anySessionRunning ? `▶ ${this.baseTitle}` : this.baseTitle;
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
			default: {
				// Ask-style requests render inline above the editor: a modal would
				// cover the transcript the user needs to read for context. Auth
				// prompts and long-form editors stay modal.
				if (request.method === "select" || request.method === "confirm" || request.method === "input") {
					this.renderInlineAsk(request, respond);
					return;
				}
				openExtensionUiDialog(this.dialogs, request, respond);
			}
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

	/** True while text is selected anywhere — native copy/cut should win over
	 * TUI-parity chords (Ctrl+C clear / Ctrl+X copy-last-message). */
	private hasTextSelection(): boolean {
		const selection = window.getSelection();
		if (selection && selection.type === "Range" && selection.toString().length > 0) return true;
		const active = document.activeElement;
		if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
			return active.selectionStart !== active.selectionEnd;
		}
		return false;
	}

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
						if (this.previewStore.getState()) {
							this.previewStore.close();
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
						this.openModelPicker();
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
							getOpenSessionPaths: () => this.sidebar?.getOpenSessionPaths() ?? [],
							onSessionsChanged: () => this.refreshSessionsList(),
						});
						return true;
					case "app.session.new":
						void connection.request({ type: "new_session" }).then(() => this.syncAfterSessionSwitch());
						return true;
					case "app.session.fork":
						this.openForkPicker();
						return true;
					case "app.message.copy": {
						// With text selected anywhere, Ctrl+X keeps its native meaning
						// (cut/copy the selection) — fall back to the browser.
						if (this.hasTextSelection()) return false;
						void connection.request<{ text: string | null }>({ type: "get_last_assistant_text" }).then((data) => {
							void navigator.clipboard.writeText(data.text ?? "");
						});
						return true;
					}
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
					case "app.preview.search":
						// Only claim Ctrl+F when the preview panel is open with a text
						// file; otherwise let the browser's native find run.
						return this.previewView?.focusSearch() ?? false;
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
