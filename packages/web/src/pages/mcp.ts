/**
 * MCP page (spec §3.4, mockup 04-mcp.svg): live-status tiles + server cards
 * (enable/disable toggles + reconnect + sign-in, control fallback per spec
 * §6.2 / R18), and CONFIGURED SERVERS grouped per project and for the pi
 * global config (mcp_config_list): every scope block lists its file-backed
 * entries (transport, disabled, live badge, on-disk reveal) and carries its
 * own Add button. Adds for a project other than the active one are guarded —
 * mcp_config_add writes to the ACTIVE session's project, so the dialog
 * refuses rather than corrupting another project's config.
 */

import { chipEl, iconEl, openAnchoredMenu, pillEl, toggleEl } from "../components/kit.ts";
import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import type { McpServerWidgetEntry, McpWidgetData } from "../render/widget-data.ts";
import type { ShellPage } from "../shell.ts";

// ---------------------------------------------------------------------------
// Pure projections (unit-tested)
// ---------------------------------------------------------------------------

type Tone = "ok" | "warn" | "danger" | "neutral";

export interface McpTileData {
	key: "servers" | "connected" | "tools" | "attention";
	value: string;
	sub: string;
	tone: Tone;
	/** Attention tile only: human reasons for the current attention count. */
	reasons?: string[];
}

function formatFailedAgo(seconds: number): string {
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	return `${Math.floor(seconds / 3600)}h ago`;
}

export function mcpTiles(servers: McpServerWidgetEntry[], totals: McpWidgetData["totals"]): McpTileData[] {
	const entries = servers ?? [];
	const enabled = totals?.enabled ?? entries.filter((server) => server.disabled !== true).length;
	const connected = totals?.connected ?? entries.filter((server) => server.status === "connected").length;

	const connectedTone: Tone =
		enabled === 0 ? "neutral" : connected === 0 ? "danger" : connected >= enabled ? "ok" : "warn";

	const activeTools = entries
		.filter((server) => server.status === "connected" || server.status === "cached")
		.reduce((sum, server) => sum + (server.toolCount ?? 0), 0);
	const totalTools = totals?.tools ?? entries.reduce((sum, server) => sum + (server.toolCount ?? 0), 0);

	const reasons: string[] = [];
	let anyFailed = false;
	let anyNeedsAuth = false;
	for (const server of entries) {
		if (server.status === "failed") {
			anyFailed = true;
			reasons.push(
				server.failedAgoSeconds !== undefined
					? `${server.name} failed ${formatFailedAgo(server.failedAgoSeconds)}`
					: `${server.name} failed`,
			);
		} else if (server.status === "needs-auth") {
			anyNeedsAuth = true;
			reasons.push(`${server.name} needs auth`);
		}
	}

	return [
		{
			key: "servers",
			value: String(totals?.servers ?? entries.length),
			sub: `${enabled} enabled`,
			tone: "neutral",
		},
		{ key: "connected", value: String(connected), sub: "connected now", tone: connectedTone },
		{ key: "tools", value: `${activeTools}/${totalTools}`, sub: "tools active", tone: "neutral" },
		{
			key: "attention",
			value: String(reasons.length),
			sub: reasons.length > 0 ? reasons.join(" · ") : "all healthy",
			tone: anyFailed ? "danger" : anyNeedsAuth ? "warn" : "ok",
			reasons,
		},
	];
}

export interface McpCardData {
	name: string;
	transport: string;
	statusLabel: string;
	tone: Tone;
	meta: string;
	enabled: boolean;
	/** Label for the set-enabled action: "Enable" when currently disabled. */
	actionLabel: "Enable" | "Disable";
	actionsAvailable: Array<"reconnect" | "set-enabled" | "sign-in">;
	canControl: boolean;
}

const STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
	connected: { label: "connected", tone: "ok" },
	"needs-auth": { label: "needs auth", tone: "warn" },
	failed: { label: "failed", tone: "danger" },
	disabled: { label: "disabled", tone: "neutral" },
	cached: { label: "cached", tone: "neutral" },
	"not-connected": { label: "not connected", tone: "neutral" },
};

export function mcpCard(
	server: McpServerWidgetEntry,
	opts: { transport?: string; canControl?: boolean } = {},
): McpCardData {
	const status = server.status ?? "not-connected";
	const known = STATUS_LABELS[status];
	const enabled = server.disabled !== true;
	const parts: string[] = [];
	if (server.toolCount !== undefined) parts.push(`${server.toolCount} tools`);
	if (server.resourceCount !== undefined) parts.push(`${server.resourceCount} resources`);
	if (status === "failed") {
		parts.push(
			server.failedAgoSeconds !== undefined
				? `last failed ${formatFailedAgo(server.failedAgoSeconds)}`
				: "last failed",
		);
	}
	const actions: McpCardData["actionsAvailable"] = ["reconnect", "set-enabled"];
	if (status === "needs-auth") actions.push("sign-in");
	return {
		name: server.name,
		transport: opts.transport ?? "—",
		statusLabel: known ? known.label : status,
		tone: known ? known.tone : "neutral",
		meta: parts.join(" · "),
		enabled,
		actionLabel: enabled ? "Disable" : "Enable",
		actionsAvailable: actions,
		canControl: opts.canControl ?? true,
	};
}

export type ToolRow = { name: string | undefined; description: string | undefined; active: boolean | undefined };

/** Future-proof tool catalog: rows when the adapter ships lists, null for the note path. */
export function toolRows(server: McpServerWidgetEntry): ToolRow[] | null {
	const tools = (
		server as McpServerWidgetEntry & { tools?: Array<{ name?: string; description?: string; active?: boolean }> }
	).tools;
	if (!Array.isArray(tools)) return null;
	return tools.map((tool) => ({ name: tool.name, description: tool.description, active: tool.active }));
}

export type McpControlAction = "set-enabled" | "reconnect" | "start-auth";

export interface McpOperation {
	action: McpControlAction;
	server: string;
	value?: boolean;
}

export type ControlOutcome =
	| { kind: "toast"; message: "MCP control delivered" }
	| { kind: "config-write"; enabled: boolean; toast: "written to .pi/mcp.json — applies on next session start" }
	| { kind: "degraded"; banner: string };

/**
 * Decision table for the §6.2 control flow, given whether the adapter handled
 * the widget_response. Pure: the page executes the outcome.
 */
export function controlOutcome(operation: McpOperation, delivered: boolean): ControlOutcome {
	if (delivered) return { kind: "toast", message: "MCP control delivered" };
	if (operation.action === "set-enabled") {
		return {
			kind: "config-write",
			enabled: operation.value === true,
			toast: "written to .pi/mcp.json — applies on next session start",
		};
	}
	return {
		kind: "degraded",
		banner: `Adapter ${operation.action} needs a pi-mcp-adapter update. Toggle changes fall back to editing .mcp.json on disk.`,
	};
}

// ---------------------------------------------------------------------------
// Test-connection (Lane F): pure projections + pill mapping per the contract
// ---------------------------------------------------------------------------

/** `mcp_test` response payload (Lane E contract). */
export interface McpTestResult {
	ok: boolean;
	reachable?: boolean;
	authRequired?: boolean;
	httpStatus?: number;
	toolCount?: number;
	detail: string;
	latencyMs?: number;
}

export type McpTestState =
	| { kind: "busy" }
	| { kind: "result"; result: McpTestResult }
	| { kind: "error"; error: string };

export interface McpTestPill {
	label: string;
	tone: Tone;
}

/** Cap a detail/error string at 60 chars with an ellipsis. Pure. */
export function trim60(text: string): string {
	const t = text.trim();
	return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/**
 * Map a test state to the inline pill. Decision table (per the Lane F brief):
 * ok → `connected <latency>ms[ · N tools]`; authRequired → reachable-sign-in
 * warn; reachable&&!ok → warn detail; !reachable → danger unreachable:detail;
 * unknown-command error → warn upgrade hint; busy → neutral testing.
 */
export function testStatePill(state: McpTestState): McpTestPill {
	if (state.kind === "busy") return { label: "testing…", tone: "neutral" };
	if (state.kind === "error") {
		if (/unknown command: mcp_test/i.test(state.error)) {
			return { label: "mcp_test needs a newer server build", tone: "warn" };
		}
		return { label: `unreachable: ${trim60(state.error)}`, tone: "danger" };
	}
	const r = state.result;
	if (r.ok) {
		const ms = r.latencyMs !== undefined ? `${r.latencyMs}ms` : "";
		const tools = r.toolCount !== undefined ? ` · ${r.toolCount} tools` : "";
		return { label: `connected ${ms}${tools}`.trim(), tone: "ok" };
	}
	if (r.authRequired) return { label: "reachable — sign in required", tone: "warn" };
	if (r.reachable) return { label: trim60(r.detail), tone: "warn" };
	return { label: `unreachable: ${trim60(r.detail)}`, tone: "danger" };
}

/** Stable identity for a per-row/per-card test slot. */
export function testKeyOf(scope: "project" | "global", cwd: string | undefined, server: string): string {
	return `${scope}:${cwd ?? ""}#${server}`;
}

// ---------------------------------------------------------------------------
// Add-server form (user issue batch 2): pure request builder + dialog
// ---------------------------------------------------------------------------

export type AddServerTransport = "stdio" | "http";

/** Everything the dialog collects; "env skipped v1" by design. */
export interface AddServerForm {
	name: string;
	transport: AddServerTransport;
	scope: "project" | "global";
	command: string;
	argsText: string;
	url: string;
}

export interface AddServerRequestPayload {
	scope: "project" | "global";
	server: string;
	definition: { command?: string; args?: string[]; url?: string };
}

export type AddServerRequest = AddServerRequestPayload | { error: string };

// ---------------------------------------------------------------------------
// Config layers (mcp_config_list): per-project + global sections
// ---------------------------------------------------------------------------

/** One server definition read from a config file (mcp_config_list entry). */
export interface McpConfigEntry {
	scope: "project" | "global";
	/** Project dir the entry was read from (project scope only). */
	cwd?: string;
	/** Absolute path of the file the entry came from. */
	path: string;
	name: string;
	definition: Record<string, unknown>;
}

/** One rendered scope block: a project (or the pi global config) + its entries. */
export interface McpSectionData {
	scope: "project" | "global";
	cwd?: string;
	title: string;
	/** Where adds/edits would land — also the empty-section hint target. */
	pathHint: string;
	entries: McpConfigEntry[];
	/** Live server names (active project section only); rows chip on match. */
	liveNames: string[];
}

function basenameOf(path: string): string {
	const parts = path
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part.length > 0);
	return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

/**
 * Group config entries into per-project sections (cwds order) with the global
 * section last. Orphaned project entries (cwd absent from cwds) are dropped.
 * Live names flow ONLY to the section matching the active cwd — global rows
 * never get live chips (project override shadowing makes a global name
 * ambiguous until the adapter reports per-source data).
 */
export function sectionsFromEntries(
	entries: McpConfigEntry[],
	cwds: string[],
	activeCwd: string | undefined,
	liveNames: string[] = [],
): McpSectionData[] {
	const sections: McpSectionData[] = [];
	const seen = new Set<string>();
	for (const cwd of cwds) {
		if (!cwd || seen.has(cwd)) continue;
		seen.add(cwd);
		sections.push({
			scope: "project",
			cwd,
			title: basenameOf(cwd),
			pathHint: `${cwd.replace(/\/+$/, "")}/.pi/mcp.json`,
			entries: entries.filter((entry) => entry.scope === "project" && entry.cwd === cwd),
			liveNames: cwd === activeCwd ? [...liveNames] : [],
		});
	}
	sections.push({
		scope: "global",
		title: "Global",
		pathHint: "pi global config",
		entries: entries.filter((entry) => entry.scope === "global"),
		liveNames: [],
	});
	return sections;
}

/** Transport label from a raw config definition (command wins over url). */
export function transportOf(definition: Record<string, unknown>): "stdio" | "http" | "—" {
	if (typeof definition.command === "string" && definition.command.length > 0) return "stdio";
	if (typeof definition.url === "string" && definition.url.length > 0) return "http";
	return "—";
}

/**
 * Validate the dialog form into an mcp_config_add request.
 * Mirrors backend validation: name required; stdio → command required;
 * http → url required; args comma-split, trimmed, empties dropped.
 */
export function addServerRequest(form: AddServerForm): AddServerRequest {
	const server = form.name.trim();
	if (!server) return { error: "server name is required" };
	if (form.transport === "stdio") {
		const command = form.command.trim();
		if (!command) return { error: "command is required for stdio servers" };
		const args = form.argsText
			.split(",")
			.map((arg) => arg.trim())
			.filter((arg) => arg.length > 0);
		return { scope: form.scope, server, definition: args.length > 0 ? { command, args } : { command } };
	}
	const url = form.url.trim();
	if (!url) return { error: "url is required for http servers" };
	return { scope: form.scope, server, definition: { url } };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface McpPageDeps {
	/** Live app connection; undefined while disconnected (controls then no-op). */
	connection(): PiConnection | undefined;
	/**
	 * Subscribe to the active session's "pi-mcp-status" widget payload.
	 * Must call the callback immediately with the current data (replay),
	 * then on every widget refresh. Returns the unsubscribe function.
	 */
	subscribeWidget(cb: (data: McpWidgetData | undefined) => void): () => void;
	/** Project cwd for the config-reveal button (primary slot cwd). */
	projectCwd(): string | undefined;
	/**
	 * Known project directories (list_sessions cwds union + open sessions),
	 * in stable display order — drives the per-project config sections.
	 */
	projectCwds(): string[];
	/** Router navigation hook (reserved for cross-page links). */
	onNavigate(page: "chat" | "home" | "projects" | "usage" | "settings"): void;
	/** Opens the file preview panel at the given absolute path. */
	openPreview(path: string): void;
	pushToast(message: string, level: "info" | "warning" | "error"): void;
	/**
	 * Optional (Lane F): drafts text into the chat editor (focused) and
	 * switches to Chat. Used as the /mcp-auth OAuth fallback when the
	 * adapter lacks a widget_response handler. Absent → banner-only degrade.
	 */
	promptDraft?(text: string): void;
}

const CONFIG_OVERRIDE_RELPATH = "/.pi/mcp.json";

export function createMcpPage(deps: McpPageDeps): ShellPage {
	let widgetData: McpWidgetData | undefined;
	let degradedBanner: string | undefined;
	let degradedHint: string | undefined;
	let unsubscribe: (() => void) | undefined;
	/** Config-file entries from mcp_config_list; undefined until first successful load. */
	let configEntries: McpConfigEntry[] | undefined;
	let configError: string | undefined;
	let configLoaded = false;
	/** Test-connection slots (Lane F): key → busy/result/error; persists across renders. */
	const testResults = new Map<string, McpTestState>();

	const element = h("div", { class: "c-page mcp-page" });

	/** Refetch the config-backed view (mount, add-success, refresh button). */
	async function refreshConfig(): Promise<void> {
		const connection = deps.connection();
		if (!connection) {
			configError = "not connected";
			render();
			return;
		}
		configError = undefined;
		render();
		try {
			const data = await connection.request<{ entries: McpConfigEntry[] }>({
				type: "mcp_config_list",
				cwds: deps.projectCwds(),
			});
			configEntries = data.entries ?? [];
			configLoaded = true;
		} catch (error: unknown) {
			configError = error instanceof Error ? error.message : String(error);
		}
		render();
	}

	async function runControl(operation: McpOperation): Promise<void> {
		const connection = deps.connection();
		if (!connection) {
			deps.pushToast("MCP controls unavailable — not connected", "error");
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
			deps.pushToast(outcome.message, "info");
			return;
		}
		if (outcome.kind === "config-write") {
			try {
				await connection.request<{ path: string; changed: boolean }>({
					type: "mcp_config_write",
					server: operation.server,
					enabled: outcome.enabled,
				});
				deps.pushToast(outcome.toast, "info");
			} catch (error: unknown) {
				deps.pushToast(`config write failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		degradedBanner = outcome.banner;
		degradedHint = operation.action === "start-auth" ? "hint: run /mcp-auth in chat to sign in now" : undefined;
		render();
		// Lane F OAuth fallback: the installed adapter has no widget_response
		// handler — draft `/mcp-auth <server>` in the chat editor (the adapter's
		// own slash command then drives the browser OAuth flow).
		if (operation.action === "start-auth" && deps.promptDraft) {
			deps.promptDraft(`/mcp-auth ${operation.server}`);
			deps.onNavigate("chat");
			deps.pushToast("Drafted /mcp-auth in chat — press Enter to run it.", "info");
		}
	}

	/** Fire an mcp_test probe and persist the outcome at the slot key. */
	async function runTest(payload: { server: string; scope: "project" | "global"; cwd?: string }): Promise<void> {
		const connection = deps.connection();
		if (!connection) {
			deps.pushToast("MCP test unavailable — not connected", "error");
			return;
		}
		const key = testKeyOf(payload.scope, payload.cwd, payload.server);
		testResults.set(key, { kind: "busy" });
		render();
		try {
			const result = await connection.request<McpTestResult>({ type: "mcp_test", ...payload });
			testResults.set(key, { kind: "result", result });
		} catch (error: unknown) {
			testResults.set(key, { kind: "error", error: error instanceof Error ? error.message : String(error) });
		}
		render();
	}

	/**
	 * Row/card-local test control (Lane F): before firing — a "test" button
	 * (disabled when the live card carries no project cwd); after firing — the
	 * result pill plus a small re-run affordance, replacing the button.
	 */
	function testControlEl(payload: { server: string; scope: "project" | "global"; cwd?: string }): HTMLElement {
		const key = testKeyOf(payload.scope, payload.cwd, payload.server);
		const state = testResults.get(key);
		const rerunControl = h(
			"button",
			{ class: "c-btn", title: `test ${payload.server} again`, onclick: () => void runTest(payload) },
			iconEl("refresh"),
		);
		if (state) {
			const pill = testStatePill(state);
			return h(
				"span",
				{ style: "display:inline-flex;align-items:center;gap:4px" },
				chipEl(pill.label, {
					tone: pill.tone,
					mono: true,
					title: state.kind === "result" ? state.result.detail : undefined,
				}),
				state.kind === "busy" ? undefined : rerunControl,
			);
		}
		const disabled = payload.scope === "project" && payload.cwd === undefined;
		return h(
			"button",
			{
				class: "c-btn",
				disabled: disabled || undefined,
				title: disabled
					? "open a session in this project first"
					: "Probe this server (MCP initialize handshake, 5s budget)",
				onclick: disabled ? undefined : () => void runTest(payload),
			},
			iconEl("search"),
			"test",
		);
	}

	function revealConfig(): void {
		const cwd = deps.projectCwd();
		if (!cwd) {
			deps.pushToast("project cwd unknown — cannot reveal config", "warning");
			return;
		}
		deps.openPreview(`${cwd}${CONFIG_OVERRIDE_RELPATH}`);
	}

	function openAddServerDialog(anchor: HTMLElement, target: { scope: "project" | "global"; cwd?: string }): void {
		let transport: AddServerTransport = "stdio";
		const addingTo =
			target.scope === "global" ? "the pi global config" : `${basenameOf(target.cwd ?? "")}/.pi/mcp.json`;

		openAnchoredMenu(anchor, (close) => {
			const nameInput = h("input", {
				class: "c-popover-search",
				placeholder: "server name — e.g. github",
			}) as HTMLInputElement;
			const transportSelect = h(
				"select",
				{ class: "c-popover-search" },
				h("option", { value: "stdio" }, "stdio (local command)"),
				h("option", { value: "http" }, "http (remote URL)"),
			) as HTMLSelectElement;
			transportSelect.addEventListener("change", () => {
				transport = transportSelect.value === "http" ? "http" : "stdio";
				syncTransportRows();
			});

			const commandInput = h("input", {
				class: "c-popover-search",
				placeholder: "command — e.g. npx -y some-mcp-server",
			}) as HTMLInputElement;
			const argsInput = h("input", {
				class: "c-popover-search",
				placeholder: "args (comma-separated, optional)",
			}) as HTMLInputElement;
			const urlInput = h("input", {
				class: "c-popover-search",
				placeholder: "https://host/mcp",
			}) as HTMLInputElement;

			const stdioRows = h("div", {}, label("command"), commandInput, label("args"), argsInput);
			const httpRows = h("div", {}, label("url"), urlInput);
			const syncTransportRows = (): void => {
				stdioRows.style.display = transport === "stdio" ? "" : "none";
				httpRows.style.display = transport === "http" ? "" : "none";
			};
			syncTransportRows();

			function label(text: string): HTMLElement {
				return h("div", { class: "c-usage-sub", style: "margin-top:8px" }, text);
			}

			async function submit(): Promise<void> {
				if (target.scope === "project") {
					const wanted = target.cwd ?? deps.projectCwd();
					if (!wanted) {
						deps.pushToast("project unknown — open a session first", "error");
						return;
					}
					if (deps.projectCwd() && wanted !== deps.projectCwd()) {
						deps.pushToast(
							`switch to a session in ${basenameOf(wanted)} first — project adds target the active project`,
							"warning",
						);
						return;
					}
				}
				const request = addServerRequest({
					name: nameInput.value,
					transport,
					scope: target.scope,
					command: commandInput.value,
					argsText: argsInput.value,
					url: urlInput.value,
				});
				if ("error" in request) {
					deps.pushToast(request.error, "error");
					return;
				}
				const connection = deps.connection();
				if (!connection) {
					deps.pushToast("not connected — try again once the session is up", "error");
					return;
				}
				try {
					const data = await connection.request<{ path: string }>({ type: "mcp_config_add", ...request });
					deps.pushToast(`added to ${data.path} — applies on next session start`, "info");
					close();
					void refreshConfig();
				} catch (error: unknown) {
					deps.pushToast(`add failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}

			return h(
				"div",
				{ class: "cp-add-server-form", style: "display:flex;flex-direction:column;gap:6px;min-width:300px" },
				h("div", { class: "c-card-title" }, "Add MCP server"),
				label("name"),
				nameInput,
				label("transport"),
				transportSelect,
				stdioRows,
				httpRows,
				h("span", { class: "c-usage-sub" }, `Adding to ${addingTo} — applies on next session start.`),
				h(
					"div",
					{ style: "display:flex;gap:8px;justify-content:flex-end;margin-top:8px" },
					h("button", { class: "c-btn", onclick: () => close() }, "Cancel"),
					h("button", { class: "c-btn c-btn--primary", onclick: () => void submit() }, "Add server"),
				),
			);
		});
	}

	function tileEl(tile: McpTileData): HTMLElement {
		const card = h(
			"div",
			{ class: "c-card", style: "min-width:180px;flex:1" },
			h("span", { class: "c-usage-hero" }, tile.value),
			h("span", { class: "c-usage-sub" }, tile.sub),
		);
		if (tile.key === "attention" && tile.reasons && tile.reasons.length > 0) {
			for (const reason of tile.reasons) {
				card.appendChild(chipEl(reason, { tone: tile.tone === "danger" ? "danger" : "warn" }));
			}
		}
		return card;
	}

	function serverCardEl(entry: McpServerWidgetEntry): HTMLElement {
		const card = mcpCard(entry);
		const titleRow = h(
			"div",
			{ class: "c-card-title", style: "display:flex;align-items:center;gap:8px" },
			h("span", { class: "c-usage-hero", style: "font-size:13px" }, card.name),
			card.transport !== "—" ? chipEl(card.transport, { mono: true }) : undefined,
			pillEl(card.statusLabel, card.tone),
		);
		if (card.meta) titleRow.appendChild(h("span", { class: "c-usage-sub" }, card.meta));

		const actionsRow = h("div", { style: "display:flex;align-items:center;gap:8px;margin-top:10px" });
		if (card.actionsAvailable.includes("reconnect")) {
			actionsRow.appendChild(
				h(
					"button",
					{
						class: "c-btn",
						title: "Ask the adapter to reconnect this server",
						onclick: () => void runControl({ action: "reconnect", server: entry.name }),
					},
					"Reconnect",
				),
			);
		}
		actionsRow.appendChild(
			toggleEl(card.enabled, (next) => void runControl({ action: "set-enabled", server: entry.name, value: next })),
		);
		actionsRow.appendChild(
			h("span", { class: "c-usage-sub" }, card.enabled ? "enabled in config" : "disabled in config"),
		);
		// Lane F: live cards live in the ACTIVE project's circuit (cwd = that
		// project); without one the probe would target nothing — disable it.
		actionsRow.appendChild(testControlEl({ server: entry.name, scope: "project", cwd: deps.projectCwd() }));
		if (card.actionsAvailable.includes("sign-in")) {
			actionsRow.appendChild(
				h(
					"button",
					{
						class: "c-btn c-btn--primary",
						title: "Start the adapter's auth flow for this server",
						onclick: () => void runControl({ action: "start-auth", server: entry.name }),
					},
					"Sign in",
				),
			);
		}

		const catalog = h("div", { style: "margin-top:8px" });
		const rows = toolRows(entry);
		if (rows === null) {
			catalog.appendChild(
				h("span", { class: "c-usage-sub" }, "tool-level toggles arrive with a pi-mcp-adapter update"),
			);
		} else {
			for (const row of rows) {
				catalog.appendChild(
					h(
						"div",
						{ class: "c-kv-row" },
						h("span", { class: "c-kv-key mono" }, row.name ?? "(unnamed tool)"),
						h("span", { class: "c-kv-val" }, row.description ?? ""),
						row.active ? chipEl("active", { tone: "ok" }) : chipEl("inactive", { tone: "neutral" }),
					),
				);
			}
		}

		return h("div", { class: "c-card", style: "flex:1;min-width:320px" }, titleRow, actionsRow, catalog);
	}

	/** CONFIGURED SERVERS block: per-project sections + global (mcp_config_list). */
	function configEl(): HTMLElement {
		const block = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
		block.appendChild(
			h(
				"div",
				{ class: "c-card-title", style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" },
				"CONFIGURED SERVERS",
				configError ? chipEl(`config list unavailable: ${configError}`, { tone: "danger" }) : undefined,
				h("span", { style: "flex:1" }),
				h(
					"button",
					{ class: "c-btn", title: "Reload the config-backed server lists", onclick: () => void refreshConfig() },
					iconEl("refresh"),
					"Refresh",
				),
			),
		);
		const liveNames = (widgetData?.servers ?? []).map((server) => server.name);
		const sections = sectionsFromEntries(configEntries ?? [], deps.projectCwds(), deps.projectCwd(), liveNames);
		for (const section of sections) {
			block.appendChild(sectionEl(section));
		}
		return block;
	}

	function sectionEl(section: McpSectionData): HTMLElement {
		const card = h("div", { class: "c-card", style: "min-width:0" });
		card.appendChild(
			h(
				"div",
				{ class: "c-card-title", style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" },
				h("span", { class: "c-usage-hero", style: "font-size:13px" }, section.title),
				h("span", { class: "c-usage-sub mono" }, section.pathHint),
				chipEl(String(section.entries.length), { tone: "neutral", title: "configured servers" }),
				h("span", { style: "flex:1" }),
				h(
					"button",
					{
						class: "c-btn c-btn--primary",
						title: `Add a server definition to ${section.pathHint}`,
						onclick: (event) =>
							openAddServerDialog(event.currentTarget as HTMLElement, {
								scope: section.scope,
								cwd: section.cwd,
							}),
					},
					iconEl("plus"),
					"Add server",
				),
			),
		);

		const list = h("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:8px" });
		if (section.entries.length === 0 && !configLoaded && !configError) {
			list.appendChild(h("span", { class: "c-usage-sub" }, "loading…"));
		} else if (section.entries.length === 0 && (configError || configEntries === undefined)) {
			// The block header carries the error chip; keep the body silent.
			list.appendChild(h("span", { class: "c-usage-sub" }, "list unavailable"));
		} else if (section.entries.length === 0) {
			list.appendChild(
				h(
					"span",
					{ class: "c-usage-sub" },
					section.scope === "project"
						? `No config file yet — adding will create ${section.pathHint}`
						: "No global config entries yet",
				),
			);
		} else {
			for (const entry of section.entries) list.appendChild(configRowEl(entry, section));
		}
		card.appendChild(list);
		return card;
	}

	function configRowEl(entry: McpConfigEntry, section: McpSectionData): HTMLElement {
		const row = h(
			"div",
			{ class: "c-kv-row", style: "min-height:32px" },
			h("span", { class: "c-kv-key mono" }, entry.name),
			chipEl(transportOf(entry.definition), { mono: true }),
		);
		if (entry.definition.disabled === true) row.appendChild(chipEl("disabled", { tone: "neutral" }));
		if (section.liveNames.includes(entry.name)) {
			row.appendChild(chipEl("live", { tone: "ok", title: "running in the active session" }));
		}
		row.appendChild(h("span", { style: "flex:1" }));
		row.appendChild(testControlEl({ server: entry.name, scope: section.scope, cwd: section.cwd }));
		row.appendChild(
			h(
				"button",
				{ class: "c-btn", title: `open ${entry.path}`, onclick: () => deps.openPreview(entry.path) },
				iconEl("file"),
				"edit on disk",
			),
		);
		return row;
	}

	function render(): void {
		clearElement(element);

		const header = h(
			"div",
			{ class: "c-page-header" },
			h("span", { class: "c-page-title" }, "MCP"),
			h(
				"button",
				{ class: "c-btn", title: "Reveal the project Pi MCP override config", onclick: revealConfig },
				iconEl("file"),
				".pi/mcp.json",
			),
		);
		element.appendChild(header);

		if (degradedBanner) {
			const banner = h(
				"div",
				{ class: "c-banner c-banner--warn" },
				h("span", { class: "c-banner-text" }, degradedBanner),
			);
			if (degradedHint) banner.appendChild(h("span", { class: "c-usage-sub" }, degradedHint));
			element.appendChild(banner);
		}

		const body = h("div", { style: "padding:20px;display:flex;flex-direction:column;gap:16px" });

		const configLoadedEmpty = configLoaded && (configEntries?.length ?? 0) === 0;
		if (widgetData === undefined) {
			// When no adapter statuses exist, distinguish "nothing configured at
			// all" (extension never spoke) from "configured but silent so far".
			body.appendChild(
				h(
					"div",
					{ class: "c-card" },
					h("div", { class: "c-card-title" }, configLoadedEmpty ? "MCP extension not loaded" : "No live statuses"),
					h(
						"span",
						{ class: "c-usage-sub" },
						configLoadedEmpty
							? "statuses appear when pi-mcp-adapter registers"
							: "statuses appear when pi-mcp-adapter pushes its next event",
					),
				),
			);
		} else {
			// Narrowed: the live adapter payload exists — render tiles + cards.
			const live = widgetData;
			const tiles = mcpTiles(live.servers ?? [], live.totals);
			body.appendChild(h("div", { style: "display:flex;gap:12px;flex-wrap:wrap" }, ...tiles.map(tileEl)));

			const grid = h("div", { style: "display:flex;gap:12px;flex-wrap:wrap" });
			for (const entry of live.servers ?? []) {
				grid.appendChild(serverCardEl(entry));
			}
			body.appendChild(grid);
		}

		body.appendChild(configEl());

		element.appendChild(body);
	}

	return {
		id: "mcp",
		title: "MCP",
		element,
		mount(): void {
			unsubscribe = deps.subscribeWidget((data) => {
				widgetData = data;
				render();
			});
			void refreshConfig();
			render();
		},
		unmount(): void {
			unsubscribe?.();
			unsubscribe = undefined;
			widgetData = undefined;
			degradedBanner = undefined;
			degradedHint = undefined;
			configEntries = undefined;
			configError = undefined;
			configLoaded = false;
			testResults.clear();
		},
	};
}
