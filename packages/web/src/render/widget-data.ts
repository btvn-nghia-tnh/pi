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

function renderTodoCard(data: TodoWidgetData): HTMLElement {
	const tasks = (data.tasks ?? []).filter((task) => task.status !== "deleted");
	const counts = data.counts ?? {};
	const header = h(
		"div",
		{ class: "todo-header" },
		h("span", { class: "todo-icon" }, tasks.some((task) => task.status === "in_progress") ? "●" : "○"),
		h("span", { class: "todo-title" }, `Todos (${counts.completed ?? 0}/${counts.total ?? tasks.length})`),
	);

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

	return h("div", { class: "todo-card" }, header, list);
}

/**
 * Render one widget: a rich component when the data kind is known, otherwise
 * the plain lines registered through setWidget.
 */
export function renderWidget(
	widget: { lines: string[]; placement: "aboveEditor" | "belowEditor"; data?: Record<string, unknown> },
	_key: string,
): HTMLElement {
	if (widget.data && widget.data.kind === "rpiv-todo") {
		return renderTodoCard(widget.data as unknown as TodoWidgetData);
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
