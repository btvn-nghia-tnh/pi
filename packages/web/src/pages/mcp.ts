/**
 * MCP page (spec §3.4, mockup 04-mcp.svg): stat tiles, server cards with
 * enable/disable toggles + reconnect + sign-in, tool catalog (read-only until
 * the adapter ships tool lists), configuration reveal, and the control
 * fallback flow (spec §6.2 / R18):
 *   every control → widget_response {key:"pi-mcp-status", payload} first;
 *   delivered:false → set-enabled falls back to mcp_config_write (project Pi
 *   override layer, applies on next session start) and reconnect/start-auth
 *   degrade to a banner that names the missing adapter capability.
 *
 * NOTE (style gap, integration polish): page-body layout uses a few minimal
 * inline flex/gap styles — dedicated .mcp-* classes land in the integration
 * styling pass alongside the other placeholder-page bodies.
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
	/** Router navigation hook (reserved for cross-page links). */
	onNavigate(page: "chat" | "home" | "projects" | "usage" | "settings"): void;
	/** Opens the file preview panel at the given absolute path. */
	openPreview(path: string): void;
	pushToast(message: string, level: "info" | "warning" | "error"): void;
}

const CONFIG_OVERRIDE_RELPATH = "/.pi/mcp.json";

export function createMcpPage(deps: McpPageDeps): ShellPage {
	let widgetData: McpWidgetData | undefined;
	let degradedBanner: string | undefined;
	let degradedHint: string | undefined;
	let unsubscribe: (() => void) | undefined;

	const element = h("div", { class: "c-page mcp-page" });

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
	}

	function revealConfig(): void {
		const cwd = deps.projectCwd();
		if (!cwd) {
			deps.pushToast("project cwd unknown — cannot reveal config", "warning");
			return;
		}
		deps.openPreview(`${cwd}${CONFIG_OVERRIDE_RELPATH}`);
	}

	function openAddServerDialog(anchor: HTMLElement): void {
		let transport: AddServerTransport = "stdio";
		let scope: "project" | "global" = "project";

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

			const projectChip = chipEl("This project", { tone: "accent" });
			const globalChip = chipEl("Global", { tone: "neutral" });
			const syncScopeChips = (): void => {
				projectChip.className = `c-chip ${scope === "project" ? "c-chip--accent" : "c-chip--neutral"}`;
				globalChip.className = `c-chip ${scope === "global" ? "c-chip--accent" : "c-chip--neutral"}`;
			};
			projectChip.addEventListener("click", () => {
				scope = "project";
				syncScopeChips();
			});
			globalChip.addEventListener("click", () => {
				scope = "global";
				syncScopeChips();
			});

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
				const request = addServerRequest({
					name: nameInput.value,
					transport,
					scope,
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
				label("scope"),
				h("div", { style: "display:flex;gap:8px" }, projectChip, globalChip),
				stdioRows,
				httpRows,
				h(
					"span",
					{ class: "c-usage-sub" },
					"Written to <cwd>/.pi/mcp.json (project) or the pi global config — applies on next session start.",
				),
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

	function render(): void {
		clearElement(element);

		const header = h(
			"div",
			{ class: "c-page-header" },
			h("span", { class: "c-page-title" }, "MCP"),
			h(
				"button",
				{
					class: "c-btn c-btn--primary",
					title: "Add a new MCP server definition (project or global)",
					onclick: (event) => openAddServerDialog(event.currentTarget as HTMLElement),
				},
				iconEl("plus"),
				"Add server",
			),
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

		if (widgetData === undefined) {
			body.appendChild(
				h(
					"div",
					{ class: "c-card" },
					h("div", { class: "c-card-title" }, "MCP extension not loaded"),
					h("span", { class: "c-usage-sub" }, "statuses appear when pi-mcp-adapter registers"),
				),
			);
		} else {
			const tiles = mcpTiles(widgetData.servers ?? [], widgetData.totals);
			body.appendChild(h("div", { style: "display:flex;gap:12px;flex-wrap:wrap" }, ...tiles.map(tileEl)));

			const grid = h("div", { style: "display:flex;gap:12px;flex-wrap:wrap" });
			for (const entry of widgetData.servers ?? []) {
				grid.appendChild(serverCardEl(entry));
			}
			body.appendChild(grid);
		}

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
			render();
		},
		unmount(): void {
			unsubscribe?.();
			unsubscribe = undefined;
			widgetData = undefined;
			degradedBanner = undefined;
			degradedHint = undefined;
		},
	};
}
