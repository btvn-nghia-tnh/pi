/**
 * Local MCP manager modal (batch-4 B6): opens from the chat status-bar MCP
 * chip ("🔌 MCP: N servers enabled (M connected)") and manages the PROJECT
 * override layer (<cwd>/.pi/mcp.json): configured rows with live badges,
 * test-connection, reconnect / sign-in adapter controls, enable/disable,
 * add-server, refresh, and on-disk reveal. The #/mcp page owns the GLOBAL
 * config; this modal owns the local one.
 *
 * Self-contained by controller steer: modal styles are injected once via a
 * <style> tag (pages.css is co-owned by parallel tasks) and use the CSS
 * tokens exclusively.
 */

import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import {
	buildAddServerForm,
	controlOutcome,
	type McpConfigEntry,
	type McpOperation,
	type McpTestResult,
	type McpTestState,
	type TestControlHost,
	testControlEl,
	testKeyOf,
	transportOf,
} from "../pages/mcp.ts";
import type { McpWidgetData } from "../render/widget-data.ts";
import { chipEl, iconEl } from "./kit.ts";

export interface McpLocalModalDeps {
	/** Live app connection; undefined while disconnected. */
	connection(): PiConnection | undefined;
	/** Active-session pi-mcp-status widget feed (replay + updates). */
	subscribeWidget(cb: (data: McpWidgetData | undefined) => void): () => void;
	/** Active session's project cwd; modal stays read-only without one. */
	projectCwd(): string | undefined;
	/** File preview (config on-disk reveal). */
	openPreview(path: string): void;
	pushToast(message: string, level: "info" | "warning" | "error"): void;
	/** /mcp-auth fallback: drafts the command into the chat editor. */
	promptDraft?(text: string): void;
}

let stylesInjected = false;

function ensureModalStyles(): void {
	if (stylesInjected || typeof document === "undefined") return;
	stylesInjected = true;
	const style = document.createElement("style");
	style.id = "mcp-local-modal-styles";
	style.textContent = `
.mcp-local-scrim {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.55);
	z-index: 300;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
}
.mcp-local-sheet {
	background: var(--c-bg-col);
	border: 1px solid var(--c-border);
	border-radius: var(--radius-card);
	width: 100%;
	max-width: 720px;
	max-height: 82vh;
	display: flex;
	flex-direction: column;
	box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
.mcp-local-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 16px;
	border-bottom: 1px solid var(--c-hairline);
}
.mcp-local-title {
	font: 600 13px var(--font-ui);
	color: var(--c-text);
}
.mcp-local-path {
	font: 400 10.5px var(--font-mono);
	color: var(--c-dim);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.mcp-local-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px 16px;
}
.mcp-local-row {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
	border: 1px solid var(--c-hairline);
	border-radius: 8px;
	padding: 6px 10px;
	background: var(--c-surface);
}
.mcp-local-row-name {
	font: 500 12px var(--font-mono);
	color: var(--c-text-2);
	min-width: 90px;
}
.mcp-local-empty {
	color: var(--c-dim);
	font: 400 11px var(--font-ui);
	padding: 6px 0;
}
`;
	document.head.appendChild(style);
}

export interface LocalMcpRow {
	name: string;
	transport: string;
	disabled: boolean;
	live: boolean;
}

/**
 * Project one configured (local-scope) entry into a modal row with live
 * badge decision (match by server name against the widget feed). Pure —
 * unit-tested in mcp-local-modal.test.ts.
 */
export function localMcpRow(entry: McpConfigEntry, liveNames: string[]): LocalMcpRow {
	return {
		name: entry.name,
		transport: transportOf(entry.definition),
		disabled: entry.definition.disabled === true,
		live: liveNames.includes(entry.name),
	};
}

/** Config rows for the modal: local entries sorted by name, live-chipped. Pure. */
export function localMcpRows(entries: McpConfigEntry[], cwd: string | undefined, liveNames: string[]): LocalMcpRow[] {
	if (!cwd) return [];
	return entries
		.filter((entry) => entry.scope === "project" && entry.cwd === cwd)
		.map((entry) => localMcpRow(entry, liveNames))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export class McpLocalModal {
	private readonly deps: McpLocalModalDeps;
	private root: HTMLElement | undefined;
	private unsubscribe: (() => void) | undefined;
	private unsubscribeWidget: (() => void) | undefined;
	private body: HTMLElement | undefined;
	private cwd: string | undefined;
	private entries: McpConfigEntry[] = [];
	private widgetData: McpWidgetData | undefined;
	private configLoaded = false;
	private configError: string | undefined;
	private readonly testResults = new Map<string, McpTestState>();
	/** Body view (batch-5): the add form replaces the list inside the modal —
	 * an anchored popover would render UNDER this modal layer and close with
	 * any outside click (owner report). */
	private view: "list" | "add" = "list";
	/** Live add-form instance; memoized so 3s widget refreshes don't wipe typed input. */
	private addFormEl: HTMLElement | undefined;

	constructor(deps: McpLocalModalDeps) {
		this.deps = deps;
	}

	open(): void {
		if (this.root) return; // already open
		ensureModalStyles();
		this.cwd = this.deps.projectCwd();
		const scrim = h("div", { class: "mcp-local-scrim" });
		const sheet = h("div", { class: "mcp-local-sheet", role: "dialog", "aria-label": "Local MCP servers" });
		this.body = h("div", { class: "mcp-local-body" });
		const close = this.close.bind(this);
		scrim.addEventListener("click", (event) => {
			if (event.target === scrim) close();
		});
		sheet.append(this.buildHead(close), this.body);
		scrim.appendChild(sheet);
		document.body.appendChild(scrim);
		this.root = scrim;
		this.unsubscribe = () => {
			document.removeEventListener("keydown", this.onKeyDown);
		};
		document.addEventListener("keydown", this.onKeyDown);
		this.unsubscribeWidget = this.deps.subscribeWidget((data) => {
			this.widgetData = data;
			this.renderBody();
		});
		void this.refreshConfig();
		this.renderBody();
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeWidget?.();
		this.unsubscribeWidget = undefined;
		this.root?.remove();
		this.root = undefined;
		this.body = undefined;
		this.configLoaded = false;
		this.configError = undefined;
		this.view = "list";
		this.addFormEl = undefined;
		this.testResults.clear();
	}

	private readonly onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") this.close();
	};

	private buildHead(close: () => void): HTMLElement {
		const relPath = this.cwd ? `${this.cwd}/.pi/mcp.json` : "";
		return h(
			"div",
			{ class: "mcp-local-head" },
			h("span", { class: "mcp-local-title" }, "MCP — this project"),
			this.cwd ? h("span", { class: "mcp-local-path", title: relPath }, relPath) : undefined,
			h("span", { style: "flex:1" }),
			h(
				"button",
				{
					class: "c-btn c-btn--primary",
					title: "Add a server definition to this project's .pi/mcp.json",
					onclick: () => this.openAdd(),
				},
				iconEl("plus"),
				"Add server",
			),
			h(
				"button",
				{ class: "c-btn", title: "Reload the local config and live statuses", onclick: () => this.refreshAll() },
				iconEl("refresh"),
				"Refresh",
			),
			h("button", { class: "c-btn", title: "Close", onclick: () => close() }, iconEl("close")),
		);
	}

	private openAdd(): void {
		if (this.view === "add") return; // already showing the form (don't wipe typed input)
		if (!this.cwd) {
			this.deps.pushToast("project unknown — open a session first", "error");
			return;
		}
		this.view = "add";
		this.addFormEl = undefined;
		this.renderBody();
	}

	private async refreshAll(): Promise<void> {
		this.cwd = this.deps.projectCwd();
		await this.refreshConfig();
		this.renderBody();
	}

	private async refreshConfig(): Promise<void> {
		const connection = this.deps.connection();
		const cwd = this.deps.projectCwd();
		if (!connection || !cwd) {
			this.configError = connection ? "project cwd unknown" : "not connected";
			this.renderBody();
			return;
		}
		this.configError = undefined;
		try {
			const data = await connection.request<{ entries: McpConfigEntry[] }>({
				type: "mcp_config_list",
				cwds: [cwd],
			});
			this.entries = data.entries ?? [];
			this.cwd = cwd;
			this.configLoaded = true;
		} catch (error: unknown) {
			this.configError = error instanceof Error ? error.message : String(error);
		}
		this.renderBody();
	}

	/** Adapter control path shared with the global page (§6.2 / R18 rules). */
	private async runControl(operation: McpOperation): Promise<void> {
		const connection = this.deps.connection();
		if (!connection) {
			this.deps.pushToast("MCP controls unavailable — not connected", "error");
			return;
		}
		let delivered = false;
		try {
			const data = await connection.request<{ delivered: boolean }>({
				type: "widget_response",
				key: "pi-mcp-status",
				payload: { action: operation.action, server: operation.server, value: operation.value },
			});
			delivered = data?.delivered === true;
		} catch {
			delivered = false;
		}
		const outcome = controlOutcome(operation, delivered);
		if (outcome.kind === "toast") {
			this.deps.pushToast(outcome.message, "info");
			return;
		}
		if (outcome.kind === "config-write") {
			try {
				await connection.request<{ path: string; changed: boolean }>({
					type: "mcp_config_write",
					server: operation.server,
					enabled: outcome.enabled,
				});
				this.deps.pushToast(outcome.toast, "info");
				void this.refreshConfig();
			} catch (error: unknown) {
				this.deps.pushToast(
					`config write failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return;
		}
		this.deps.pushToast(outcome.banner, "warning");
		if (operation.action === "start-auth" && this.deps.promptDraft) {
			this.close();
			this.deps.promptDraft(`/mcp-auth ${operation.server}`);
			this.deps.pushToast("Drafted /mcp-auth in chat — press Enter to run it.", "info");
		}
	}

	private async runTest(server: string): Promise<void> {
		const connection = this.deps.connection();
		if (!connection || !this.cwd) {
			this.deps.pushToast("MCP test unavailable — no project session", "error");
			return;
		}
		const key = testKeyOf("project", this.cwd, server);
		this.testResults.set(key, { kind: "busy" });
		this.renderBody();
		try {
			const result = await connection.request<McpTestResult>({
				type: "mcp_test",
				server,
				scope: "project",
				cwd: this.cwd,
			});
			this.testResults.set(key, { kind: "result", result });
		} catch (error: unknown) {
			this.testResults.set(key, { kind: "error", error: error instanceof Error ? error.message : String(error) });
		}
		this.renderBody();
	}

	private testControl(server: string): HTMLElement {
		const host: TestControlHost = {
			onTest: () => void this.runTest(server),
			resultOf: (key) => this.testResults.get(key),
		};
		return testControlEl(host, { server, scope: "project", cwd: this.cwd });
	}

	private liveEntry(name: string): { status: string; toolCount: number | undefined; needsAuth: boolean } | undefined {
		const entry = this.widgetData?.servers?.find((server) => server.name === name);
		if (!entry || entry.disabled === true) return undefined;
		return {
			status: entry.status ?? "not-connected",
			toolCount: entry.toolCount,
			needsAuth: entry.status === "needs-auth",
		};
	}

	private rowEl(entry: McpConfigEntry): HTMLElement {
		const live = this.liveEntry(entry.name);
		const row = h(
			"div",
			{ class: "mcp-local-row" },
			h("span", { class: "mcp-local-row-name" }, entry.name),
			chipEl(transportOf(entry.definition), { mono: true }),
		);
		if (entry.definition.disabled === true) {
			row.appendChild(chipEl("disabled", { tone: "neutral" }));
		} else if (live) {
			const label = live.toolCount !== undefined ? `${live.status} · ${live.toolCount}` : live.status;
			row.appendChild(chipEl(label, { tone: live.needsAuth ? "warn" : "ok", title: "this session's circuit" }));
		} else {
			row.appendChild(chipEl("not live in this session", { tone: "neutral" }));
		}
		row.appendChild(h("span", { style: "flex:1" }));
		row.appendChild(this.testControl(entry.name));
		row.appendChild(
			h(
				"button",
				{
					class: "c-btn",
					title: "Ask the adapter to reconnect this server",
					onclick: () => void this.runControl({ action: "reconnect", server: entry.name }),
				},
				"Reconnect",
			),
		);
		if (live?.needsAuth) {
			row.appendChild(
				h(
					"button",
					{
						class: "c-btn c-btn--primary",
						title: "Start the adapter's auth flow for this server",
						onclick: () => void this.runControl({ action: "start-auth", server: entry.name }),
					},
					"Sign in",
				),
			);
		}
		row.appendChild(
			h(
				"button",
				{ class: "c-btn", title: `open ${entry.path}`, onclick: () => this.deps.openPreview(entry.path) },
				iconEl("file"),
				"edit on disk",
			),
		);
		return row;
	}

	private renderBody(): void {
		if (!this.body) return;
		if (this.view === "add" && this.cwd) {
			// Batch-5: the add form renders INSIDE the modal body; Cancel returns
			// to the list, a successful add refreshes it (toast comes from the form).
			// Widget-driven re-renders keep the SAME form node so typed input survives.
			if (this.addFormEl?.isConnected) return;
			clearElement(this.body);
			this.addFormEl = buildAddServerForm(
				{ scope: "project", cwd: this.cwd },
				{
					connection: this.deps.connection,
					projectCwd: this.deps.projectCwd,
					pushToast: this.deps.pushToast,
					onAdded: () => void this.refreshConfig(),
				},
				{
					onDone: () => {
						this.view = "list";
						this.addFormEl = undefined;
						void this.refreshConfig();
					},
					onCancel: () => {
						this.view = "list";
						this.addFormEl = undefined;
						this.renderBody();
					},
				},
			);
			this.body.appendChild(this.addFormEl);
			return;
		}
		this.addFormEl = undefined;
		clearElement(this.body);
		if (this.configError) {
			this.body.appendChild(chipEl(`config list unavailable: ${this.configError}`, { tone: "danger" }));
		}
		if (!this.cwd) {
			this.body.appendChild(
				h("span", { class: "mcp-local-empty" }, "No open session — local MCP config needs an active project."),
			);
			return;
		}
		const orderedEntries = [...this.entries]
			.filter((entry) => entry.scope === "project" && entry.cwd === this.cwd)
			.sort((a, b) => a.name.localeCompare(b.name));
		if (orderedEntries.length === 0 && this.configLoaded) {
			this.body.appendChild(
				h(
					"span",
					{ class: "mcp-local-empty" },
					`No configured servers yet — Add server creates ${this.cwd}/.pi/mcp.json`,
				),
			);
			return;
		}
		for (const entry of orderedEntries) {
			this.body.appendChild(this.rowEl(entry));
		}
		if (orderedEntries.length === 0 && !this.configLoaded && !this.configError) {
			this.body.appendChild(h("span", { class: "mcp-local-empty" }, "loading…"));
		}
	}
}
