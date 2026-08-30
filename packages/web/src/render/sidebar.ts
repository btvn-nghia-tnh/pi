/**
 * Multi-session sidebar: every session on disk, grouped by project (cwd),
 * with open markers, running spinners, open/switch on click, explicit close
 * for open sessions, and a new-session button. Collapsible (persisted).
 */

import { h } from "../dom.ts";

export interface SidebarSessionInfo {
	/** Session file path (identity on disk). */
	path: string;
	/** Project working directory (grouping key). */
	cwd: string;
	/** User-defined name, else first-message preview, else file name. */
	name?: string;
	/** For sorting (newest first). */
	modified: number;
}

export interface SidebarHandlers {
	onActivate: (sessionId: string) => void;
	onOpen: (sessionPath: string) => void;
	onNew: () => void;
	onClose: (sessionId: string) => void;
	/** Running state per open session (spinner); false/undefined = idle. */
	getRunning: (sessionId: string) => boolean;
}

const COLLAPSED_KEY = "pi-web-sidebar-collapsed";

export class SidebarView {
	readonly element: HTMLElement;
	private readonly handlers: SidebarHandlers;
	private readonly groupsHost!: HTMLElement;
	private readonly newListHost!: HTMLElement;
	/** Sessions from list_sessions (disk). */
	private sessionsList: SidebarSessionInfo[] = [];
	/** Open sessions: session id → { sessionPath, cwd, primary }. */
	private readonly openSessions = new Map<string, { sessionPath?: string; cwd: string; primary?: boolean }>();
	private activeId: string | undefined;
	private collapsed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private unsubscribers: Array<() => void> = [];

	constructor(handlers: SidebarHandlers) {
		this.handlers = handlers;
		this.collapsed = window.localStorage.getItem(COLLAPSED_KEY) === "1";
		this.element = h("aside", { class: `sidebar${this.collapsed ? " collapsed" : ""}` });
		this.element.appendChild(this.buildChrome());
		this.groupsHost = h("div", { class: "sidebar-groups" });
		this.newListHost = h("div", { class: "sidebar-new" });
		this.element.append(this.groupsHost, this.newListHost);
	}

	mount(): void {
		this.timer = setInterval(() => this.refreshRunning(), 500);
		const onKeydown = (event: KeyboardEvent): void => {
			if (event.ctrlKey && event.key.toLowerCase() === "b") {
				event.preventDefault();
				this.setCollapsed(!this.collapsed);
			}
		};
		document.addEventListener("keydown", onKeydown);
		this.unsubscribers.push(() => document.removeEventListener("keydown", onKeydown));
	}

	unmount(): void {
		if (this.timer) clearInterval(this.timer);
		for (const off of this.unsubscribers) off();
		this.unsubscribers = [];
	}

	/** Replace the disk session list (from list_sessions). */
	setSessionsList(sessions: SidebarSessionInfo[]): void {
		this.sessionsList = sessions;
		this.render();
	}

	/** Register an open session (from connected/session_opened payloads). */
	addSession(id: string, data: { sessionPath?: string; cwd: string; primary?: boolean }): void {
		this.openSessions.set(id, { sessionPath: data.sessionPath, cwd: data.cwd, primary: data.primary });
		this.render();
	}

	updateSession(id: string, data: { sessionPath?: string; cwd: string; primary?: boolean }): void {
		const existing = this.openSessions.get(id);
		this.openSessions.set(id, {
			sessionPath: data.sessionPath ?? existing?.sessionPath,
			cwd: data.cwd ?? existing?.cwd ?? "",
			primary: data.primary ?? existing?.primary,
		});
		this.render();
	}

	removeSession(id: string): void {
		this.openSessions.delete(id);
		this.render();
	}

	/** In-slot session replacement (fork, /new): the slot keeps existing. */
	renameSession(oldId: string, newId: string, sessionPath?: string): void {
		const existing = this.openSessions.get(oldId);
		if (!existing) return;
		this.openSessions.delete(oldId);
		this.openSessions.set(newId, {
			sessionPath: sessionPath ?? existing.sessionPath,
			cwd: existing.cwd,
			primary: existing.primary,
		});
		if (this.activeId === oldId) this.activeId = newId;
		this.render();
	}

	setActive(id: string): void {
		this.activeId = id;
		this.render();
	}

	/** Recompute spinner state for open sessions. */
	private refreshRunning(): void {
		if (this.collapsed) return;
		for (const id of this.openSessions.keys()) {
			const running = this.handlers.getRunning(id);
			const spinner = this.element.querySelector<HTMLElement>(
				`[data-session-id="${cssEscape(id)}"] .sidebar-spinner`,
			);
			if (spinner) spinner.classList.toggle("spinning", running);
		}
	}

	// ------------------------------------------------------------------

	private buildChrome(): HTMLElement {
		const toggle = h("button", { class: "sidebar-toggle", title: "Toggle sidebar (Ctrl+B)" }, "◀");
		toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
		return h("div", { class: "sidebar-chrome" }, h("span", { class: "sidebar-title" }, "Sessions"), toggle);
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
		this.element.classList.toggle("collapsed", collapsed);
		if (!collapsed) this.refreshRunning();
	}

	private render(): void {
		this.groupsHost.replaceChildren();
		this.newListHost.replaceChildren();

		// One entry per visible session: disk sessions merged with open
		// sessions that have no disk row yet (brand-new, unsaved).
		interface Row {
			label: string;
			title: string;
			openId?: string;
			primary?: boolean;
			modified: number;
		}
		const groups = new Map<string, Row[]>();
		const pushRow = (cwd: string, row: Row): void => {
			const key = cwd || "(no project)";
			const list = groups.get(key) ?? [];
			list.push(row);
			groups.set(key, list);
		};

		const openByPath = new Map<string, string>();
		for (const [id, data] of this.openSessions) {
			if (data.sessionPath !== undefined) openByPath.set(normalized(data.sessionPath), id);
		}

		for (const session of this.sessionsList) {
			const openId = openByPath.get(normalized(session.path));
			pushRow(session.cwd, {
				label: session.name?.trim() || session.path.split(/[\\/]/).pop() || "session",
				title: session.path,
				openId,
				primary: openId !== undefined ? this.openSessions.get(openId)?.primary : undefined,
				modified: session.modified,
			});
		}
		for (const [id, data] of this.openSessions) {
			const listed =
				data.sessionPath !== undefined &&
				this.sessionsList.some((session) => pathsEqual(session.path, data.sessionPath!));
			if (listed) continue;
			pushRow(data.cwd, {
				label: "(new session)",
				title: data.sessionPath ?? "unsaved session",
				openId: id,
				primary: data.primary,
				modified: Number.MAX_SAFE_INTEGER,
			});
		}

		const orderedGroups = [...groups.entries()].sort((a, b) => newestRowIn(b[1]) - newestRowIn(a[1]));
		for (const [cwd, rows] of orderedGroups) {
			rows.sort((a, b) => b.modified - a.modified);
			const label = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
			const group = h(
				"div",
				{ class: "sidebar-group" },
				h("div", { class: "sidebar-group-label", title: cwd }, label),
			);
			for (const row of rows) {
				group.appendChild(this.buildRow(row));
			}
			this.groupsHost.appendChild(group);
		}

		const newButton = h("button", { class: "sidebar-new-btn" }, "+ New session");
		newButton.addEventListener("click", () => this.handlers.onNew());
		this.newListHost.appendChild(newButton);
	}

	private buildRow(row: { label: string; title: string; openId?: string; primary?: boolean }): HTMLElement {
		const isOpen = row.openId !== undefined;
		const isActive = row.openId !== undefined && row.openId === this.activeId;

		const marker = h("span", { class: "sidebar-marker" }, isOpen ? "●" : "○");
		const spinner = h("span", { class: "sidebar-spinner" }, "⟳");
		const name = h("span", { class: "sidebar-session-name" }, row.label);

		const element = h(
			"div",
			{
				class: `sidebar-row${isOpen ? " open" : ""}${isActive ? " active" : ""}`,
				"data-session-id": row.openId ?? "",
				title: row.title,
			},
			marker,
			name,
			spinner,
		);
		if (row.openId !== undefined && !row.primary) {
			const close = h("button", { class: "sidebar-close", title: "Close session" }, "×");
			close.addEventListener("click", (event) => {
				event.stopPropagation();
				// Closing a running session aborts its turn — confirm first.
				if (
					this.handlers.getRunning(row.openId!) &&
					!window.confirm("This session is still running. Close it anyway?")
				) {
					return;
				}
				this.handlers.onClose(row.openId!);
			});
			element.appendChild(close);
		}
		element.addEventListener("click", () => {
			if (row.openId !== undefined) {
				this.handlers.onActivate(row.openId);
			} else if (row.title !== "unsaved session") {
				this.handlers.onOpen(row.title);
			}
		});
		return element;
	}
}

function newestRowIn(rows: Array<{ modified: number }>): number {
	return rows.reduce((max, row) => Math.max(max, row.modified), 0);
}

function normalized(path: string): string {
	return path.replaceAll("\\", "/");
}

function pathsEqual(a: string, b: string): boolean {
	return a === b || a.replaceAll("\\", "/") === b.replaceAll("\\", "/");
}

function cssEscape(value: string): string {
	return value.replace(/["\\]/g, "\\$&");
}
