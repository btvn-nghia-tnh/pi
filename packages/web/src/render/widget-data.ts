/**
 * Structured widget rendering. Extensions register GUI payloads through
 * setWidgetData(key, { kind, ... }); hosts render known kinds with a rich
 * component and fall back to the setWidget string lines otherwise.
 */

import { h } from "../dom.ts";
import type { Store } from "../state.ts";

export interface TodoWidgetTask {
	id: number;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: string;
	blockedBy?: number[];
}

export interface McpServerWidgetEntry {
	name: string;
	status: string;
	toolCount?: number;
	resourceCount?: number;
	disabled?: boolean;
	failedAgoSeconds?: number;
}

export interface McpWidgetData {
	kind: "pi-mcp-status";
	version?: number;
	servers?: McpServerWidgetEntry[];
	totals?: {
		servers?: number;
		connected?: number;
		enabled?: number;
		disabled?: number;
		tools?: number;
		resources?: number;
	};
}

export interface TodoWidgetData {
	kind: "rpiv-todo";
	version?: number;
	tasks?: TodoWidgetTask[];
	counts?: { total?: number; completed?: number; inProgress?: number; pending?: number };
	collapsed?: boolean;
}

const STATUS_ICON: Record<string, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	deleted: "✗",
};

const MCP_STATUS_ICON: Record<string, string> = {
	connected: "●",
	"needs-auth": "⚑",
	failed: "⚠",
	cached: "◔",
	disabled: "⊘",
	"not-connected": "○",
};

function formatFailedAgo(seconds: number): string {
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	return `${Math.floor(seconds / 3600)}h ago`;
}

function renderMcpStatusCard(data: McpWidgetData): HTMLElement {
	const servers = data.servers ?? [];
	const totals = data.totals ?? {};
	const enabled = totals.enabled ?? servers.length;
	const heading =
		enabled === 0
			? `MCP — ${totals.servers ?? servers.length} servers disabled`
			: `MCP ${totals.connected ?? 0}/${enabled} connected · ${totals.tools ?? 0} tools`;
	const allHealthy = (totals.connected ?? 0) >= enabled && enabled > 0;

	const header = h(
		"div",
		{ class: `mcp-header${allHealthy ? "" : " mcp-attention"}` },
		h("span", { class: "mcp-icon" }, allHealthy ? "◉" : "◎"),
		h("span", { class: "mcp-title" }, heading),
	);

	const list = h("ul", { class: "mcp-list" });
	for (const server of servers) {
		const status = server.status ?? "not-connected";
		const icon = MCP_STATUS_ICON[status] ?? "○";
		const parts: string[] = [server.name];
		if (server.toolCount && server.toolCount > 0) parts.push(`${server.toolCount} tools`);
		if (status === "failed" && server.failedAgoSeconds !== undefined) {
			parts.push(`failed ${formatFailedAgo(server.failedAgoSeconds)}`);
		}
		if (status === "needs-auth") parts.push("needs auth");
		if (status === "cached") parts.push("cached");
		if (status === "disabled") parts.push("disabled");
		list.appendChild(
			h(
				"li",
				{ class: `mcp-item mcp-${status.replace(/[^a-z-]/g, "-")}`, title: `status: ${status}` },
				h("span", { class: "mcp-status" }, icon),
				h("span", { class: "mcp-text" }, parts.join(" — ")),
			),
		);
	}

	return h("div", { class: "mcp-card" }, header, list);
}

function renderTodoCard(
	data: TodoWidgetData,
	options: { collapsed?: boolean; onToggle?: () => void; key?: string },
): HTMLElement {
	const tasks = (data.tasks ?? []).filter((task) => task.status !== "deleted");
	const counts = data.counts ?? {};
	const header = h(
		"div",
		{
			class: `todo-header${options.onToggle ? " todo-toggle" : ""}`,
			title: options.onToggle ? "Click to collapse or expand" : undefined,
		},
		h("span", { class: "todo-icon" }, tasks.some((task) => task.status === "in_progress") ? "●" : "○"),
		h("span", { class: "todo-title" }, `Todos (${counts.completed ?? 0}/${counts.total ?? tasks.length})`),
		h("span", { class: "todo-chevron" }, options.collapsed ? "▸" : "▾"),
	);
	if (options.onToggle) {
		header.addEventListener("click", () => options.onToggle?.());
	}

	const list = h("ul", { class: "todo-list" });
	for (const task of tasks) {
		const status = task.status ?? "pending";
		const label = status === "in_progress" && task.activeForm ? task.activeForm : (task.subject ?? "");
		const item = h(
			"li",
			{ class: `todo-item todo-${status.replace("_", "-")}` },
			h("span", { class: "todo-status" }, STATUS_ICON[status] ?? "○"),
			h("span", { class: "todo-text" }, label),
		);
		if (task.blockedBy && task.blockedBy.length > 0) {
			item.appendChild(
				h(
					"span",
					{ class: "todo-blocked", title: `blocked by ${task.blockedBy.join(", ")}` },
					`⇄${task.blockedBy.join(",")}`,
				),
			);
		}
		list.appendChild(item);
	}

	if (options.collapsed) {
		return h("div", { class: "todo-card todo-collapsed" }, header);
	}
	return h("div", { class: "todo-card" }, header, list);
}

export interface RenderWidgetOptions {
	collapsed?: boolean;
	onToggle?: () => void;
}

/**
 * Render one widget: a rich component when the data kind is known, otherwise
 * the plain lines registered through setWidget.
 */
export function renderWidget(
	widget: { lines: string[]; placement: "aboveEditor" | "belowEditor"; data?: Record<string, unknown> },
	key: string,
	options?: RenderWidgetOptions,
): HTMLElement {
	if (widget.data && widget.data.kind === "rpiv-todo") {
		return renderTodoCard(widget.data as unknown as TodoWidgetData, {
			collapsed: options?.collapsed,
			onToggle: options?.onToggle,
			key,
		});
	}
	if (widget.data && widget.data.kind === "pi-mcp-status") {
		return renderMcpStatusCard(widget.data as unknown as McpWidgetData);
	}
	return h("div", { class: "widget-panel" }, widget.lines.join("\n"));
}

/** Re-exported for WidgetAreaView: render widgets from the store. */
export function widgetElements(store: Store): HTMLElement[] {
	const state = store.getState();
	const elements: HTMLElement[] = [];
	for (const [key, widget] of state.widgets) {
		const element = renderWidget(widget, key);
		element.dataset.widgetKey = key;
		elements.push(element);
	}
	return elements;
}
