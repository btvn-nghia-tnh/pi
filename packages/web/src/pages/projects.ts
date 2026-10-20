/**
 * Projects page (spec §3.3, mockup 03-projects.svg): project list left,
 * per-project detail right — stat tiles, session table with multi-select
 * actions, context files. Integration (app.ts) supplies the deps and
 * registers the page; this module owns markup + pure projections only.
 */
import { chipEl, iconEl, pillEl } from "../components/kit.ts";
import { clearElement, h } from "../dom.ts";
import type { ShellPage } from "../shell.ts";
import type { RpcSessionSummary } from "../types.ts";
import { formatCost, relativeTime } from "../usage-text.ts";

export type SessionAction = "rename" | "fork" | "export" | "share" | "delete";

/** Context-files slice of an RpcContextInfo, mirrored to keep deps minimal. */
export interface ProjectContextFiles {
	contextFiles: Array<{ path: string; source: string }>;
}

/** What the projects page needs from the app. */
export interface ProjectsPageDeps {
	/** Connection for future direct requests; integration may pass it, page currently routes data through fetchSessions. */
	connection(): import("../connection.ts").PiConnection | undefined;
	/** Cross-page navigation hook (reserved: unused in v1 markup, kept per integration contract). */
	onNavigate(page: "chat" | "mcp" | "usage" | "home" | "settings"): void;
	fetchSessions(): Promise<Array<RpcSessionSummary>>;
	/** Open slots to compute running badges; running=false when idle. */
	openSessions(): Array<{ id: string; cwd: string; running: boolean }>;
	/** Context files for a cwd; undefined when no open session knows them. */
	projectContext(cwd: string): Promise<ProjectContextFiles | undefined>;
	onOpenSession(fileOrId: string): void;
	onNewSession(cwd: string): void;
	openPreview(path: string): void;
	onRowAction(action: SessionAction, session: RpcSessionSummary): void;
	onBatchAction(action: SessionAction, sessions: Array<RpcSessionSummary>): void;
}

export interface ProjectsPageOpts {
	/** Deep-link cwd (#/projects/<path>); wins until the user clicks another. */
	activePath?: () => string | undefined;
}

// ---------------------------------------------------------------------
// Pure projections
// ---------------------------------------------------------------------

function basename(cwd: string): string {
	const trimmed = cwd.replace(/\/*$/, "");
	if (trimmed === "") return cwd;
	const parts = trimmed.split("/");
	return parts[parts.length - 1] ?? cwd;
}

export interface ProjectGroup {
	cwd: string;
	name: string;
	sessions: Array<RpcSessionSummary>;
	running: number;
	totalMessages: number;
	lastModified: string;
}

export function projectGroups(
	sessions: Array<RpcSessionSummary>,
	open: Array<{ id: string; cwd: string; running: boolean }>,
): Array<ProjectGroup> {
	const byCwd = new Map<string, Array<RpcSessionSummary>>();
	for (const session of sessions) {
		const list = byCwd.get(session.cwd) ?? [];
		list.push(session);
		byCwd.set(session.cwd, list);
	}
	const runningByCwd = new Map<string, number>();
	for (const entry of open) {
		if (!entry.running) continue;
		runningByCwd.set(entry.cwd, (runningByCwd.get(entry.cwd) ?? 0) + 1);
	}
	const groups: Array<ProjectGroup> = [];
	for (const [cwd, list] of byCwd) {
		const sorted = [...list].sort((a, b) => (a.modified < b.modified ? 1 : -1));
		groups.push({
			cwd,
			name: basename(cwd),
			sessions: sorted,
			running: runningByCwd.get(cwd) ?? 0,
			totalMessages: list.reduce((sum, session) => sum + session.messageCount, 0),
			lastModified: sorted[0]?.modified ?? "",
		});
	}
	groups.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
	return groups;
}

export interface SessionTableRow {
	name: string;
	messages: string;
	/** "—" until integration passes real per-session usage costs. */
	cost: string;
	modifiedText: string;
}

/** Display name: explicit name → first message → file basename. */
function sessionName(session: RpcSessionSummary): string {
	if (session.name) return session.name;
	const first = session.firstMessage.trim();
	if (first) return first;
	return basename(session.file);
}

export function sessionTableRows(
	sessions: Array<RpcSessionSummary>,
	now: number,
	usage?: Map<string, number>,
): Array<SessionTableRow> {
	const sorted = [...sessions].sort((a, b) => (a.modified < b.modified ? 1 : -1));
	return sorted.map((session) => {
		const cost = usage?.get(session.file);
		return {
			name: sessionName(session),
			messages: String(session.messageCount),
			cost: cost === undefined ? "—" : formatCost(cost),
			modifiedText: relativeTime(session.modified, now, { maxDays: 14 }),
		};
	});
}

// ---------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------

const TABLE_GRID =
	"display:grid;grid-template-columns:30px 1fr 76px 84px 110px auto;column-gap:10px;align-items:center";

function tile(label: string, value: string): HTMLElement {
	return h(
		"div",
		{ class: "c-card", style: "padding:12px 14px" },
		h("div", { class: "c-card-title", style: "margin-bottom:6px" }, label),
		h("div", { style: "font:650 15px var(--font-mono);color:var(--c-text)" }, value),
	);
}

function actionButton(label: string, title: string, onclick: () => void): HTMLElement {
	return h("button", { class: "c-btn", title, style: "padding:2px 8px;font-size:10.5px", onclick }, label);
}

export function createProjectsPage(deps: ProjectsPageDeps, opts: ProjectsPageOpts = {}): ShellPage {
	let fetchToken = 0;
	let selectedCwd: string | undefined;
	let searchQuery = "";
	const selection = new Set<string>();
	let groups: Array<ProjectGroup> = [];

	// ---- static chrome ------------------------------------------------
	const leftColumn = h("div", {
		class: "chat-sidebar",
		style: "display:flex;flex-direction:column;overflow-y:auto;padding:12px;gap:10px",
	});
	const rightColumn = h("div", { style: "flex:1;min-width:0;overflow-y:auto;padding:16px 20px" });

	const searchInput = h("input", {
		class: "c-popover-search",
		placeholder: "Filter projects…",
		style: "width:100%;box-sizing:border-box",
	}) as HTMLInputElement;
	searchInput.addEventListener("input", () => {
		searchQuery = searchInput.value.trim().toLowerCase();
		renderProjectList();
	});

	const newSessionButton = h(
		"button",
		{
			class: "c-btn c-btn--primary",
			onclick: () => {
				const cwd = currentCwd();
				if (cwd) deps.onNewSession(cwd);
			},
		},
		"＋ New session",
	);
	const refreshButton = h(
		"button",
		{ class: "c-btn", title: "Re-read sessions from disk", onclick: () => void fetchAndRender() },
		"⟳ Refresh",
	);

	// Mobile drawer (spec §3.7): the project list column slides off-canvas
	// below 768px; matchMedia-gated hamburger + scrim mirror the chat page.
	const mobile = window.matchMedia("(max-width: 767px)");
	let drawerOpen = false;
	const scrim = h("div", { class: "c-scrim", "aria-hidden": "true" });
	scrim.addEventListener("click", () => {
		drawerOpen = false;
		applyDrawer();
	});
	let drawerButton: HTMLButtonElement;
	const applyDrawer = (): void => {
		element.classList.toggle("drawer-open", drawerOpen);
		scrim.classList.toggle("is-open", drawerOpen);
		drawerButton.setAttribute("aria-expanded", String(drawerOpen));
	};
	drawerButton = h(
		"button",
		{
			class: "c-drawer-toggle",
			title: "Projects",
			"aria-label": "Toggle projects drawer",
			"aria-expanded": "false",
			onclick: () => {
				if (!mobile.matches) return;
				drawerOpen = !drawerOpen;
				applyDrawer();
			},
		},
		iconEl("folder"),
	) as HTMLButtonElement;
	// Tapping a project row (a button inside the list column) closes it.
	leftColumn.addEventListener("click", (event) => {
		const target = event.target as HTMLElement;
		if (drawerOpen && target !== searchInput && target.closest("button")) {
			drawerOpen = false;
			applyDrawer();
		}
	});

	const element = h(
		"div",
		{ class: "c-page", "aria-label": "Projects" },
		h(
			"div",
			{ class: "c-page-header" },
			drawerButton,
			h("span", { class: "c-page-title" }, "Projects"),
			newSessionButton,
			refreshButton,
		),
		h("div", { style: "flex:1;min-height:0;display:flex", class: "projects-body" }, leftColumn, rightColumn),
		scrim,
	);

	// ---- helpers -----------------------------------------------------
	function currentCwd(): string | undefined {
		if (selectedCwd) return selectedCwd;
		return opts.activePath?.() ?? groups[0]?.cwd;
	}

	function visibleGroups(): Array<ProjectGroup> {
		if (!searchQuery) return groups;
		return groups.filter((group) => `${group.name} ${group.cwd}`.toLowerCase().includes(searchQuery));
	}

	// ---- left column --------------------------------------------------
	function renderProjectList(): void {
		clearElement(leftColumn);
		leftColumn.append(searchInput);
		const visible = visibleGroups();
		if (visible.length === 0) {
			leftColumn.appendChild(
				h(
					"div",
					{ class: "c-card", style: "padding:14px;color:var(--c-dim)" },
					groups.length === 0
						? "No sessions on disk yet — start a chat to see it here."
						: "No projects match your filter.",
				),
			);
		}
		for (const group of visible) {
			const active = currentCwd() === group.cwd;
			const row = h(
				"div",
				{
					style: `display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;cursor:pointer;${
						active ? "background:var(--c-raised);box-shadow:inset 3px 0 0 var(--c-accent)" : ""
					}`,
					onclick: () => {
						selectedCwd = group.cwd;
						renderProjectList();
						renderDetail();
					},
				},
				iconEl("folder"),
				h(
					"div",
					{ style: "min-width:0;flex:1" },
					h(
						"div",
						{
							style: "font:600 12.5px var(--font-ui);color:var(--c-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
						},
						group.name,
					),
					h(
						"div",
						{
							style: "font:400 10px var(--font-mono);color:var(--c-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
						},
						group.cwd,
					),
				),
				h(
					"div",
					{ style: "text-align:right" },
					h(
						"div",
						{ style: "font:400 10px var(--font-ui);color:var(--c-dim)" },
						`${group.sessions.length} · ${relativeTime(group.lastModified, Date.now(), { maxDays: 14 })}`,
					),
				),
			);
			if (group.running > 0) {
				row.appendChild(pillEl(`${group.running} running`, "ok"));
			}
			leftColumn.appendChild(row);
		}
	}

	// ---- right column -------------------------------------------------
	function renderDetail(): void {
		clearElement(rightColumn);
		const cwd = currentCwd();
		const group = groups.find((entry) => entry.cwd === cwd);
		if (!cwd || !group) {
			rightColumn.appendChild(
				h("div", { class: "c-card", style: "padding:20px;color:var(--c-dim)" }, "Pick a project on the left."),
			);
			return;
		}
		renderProjectHeader(group);
		renderTable(group);
		void renderContextFiles(group.cwd);
	}

	function renderProjectHeader(group: ProjectGroup): void {
		rightColumn.append(
			h(
				"div",
				{ style: "display:flex;align-items:center;gap:10px;margin-bottom:14px" },
				iconEl("folder"),
				h("span", { style: "font:700 17px var(--font-ui);color:var(--c-text)" }, group.name),
				h("span", { style: "font:400 11px var(--font-mono);color:var(--c-dim)" }, group.cwd),
			),
			h(
				"div",
				{ style: "display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:14px;margin-bottom:14px" },
				tile("Sessions", String(group.sessions.length)),
				tile("Messages", String(group.totalMessages)),
				tile("Spent", "—"),
				tile("Last activity", relativeTime(group.lastModified, Date.now(), { maxDays: 14 })),
			),
		);
	}

	function renderTable(group: ProjectGroup): void {
		const rows = sessionTableRows(group.sessions, Date.now());
		const sessionsSorted = [...group.sessions].sort((a, b) => (a.modified < b.modified ? 1 : -1));
		const cardBody = h("div", { style: "padding:12px 14px" });
		rightColumn.append(
			h(
				"div",
				{ class: "c-card" },
				h("div", { class: "c-card-title", style: "padding:12px 14px 0" }, "Sessions"),
				cardBody,
			),
		);

		const container = h("div", { class: "projects-table" }); // holds the column-header row + the body
		const header = h(
			"div",
			{
				class: "projects-row",
				style: `${TABLE_GRID};padding:2px 10px 6px;border-bottom:1px solid var(--c-hairline)`,
			},
			h("span", {}),
			h("span", { style: "font:700 9.5px var(--font-ui);letter-spacing:1px;color:var(--c-faint)" }, "SESSION"),
			h(
				"span",
				{ class: "col-msgs", style: "font:700 9.5px var(--font-ui);letter-spacing:1px;color:var(--c-faint)" },
				"MSGS",
			),
			h("span", { style: "font:700 9.5px var(--font-ui);letter-spacing:1px;color:var(--c-faint)" }, "COST"),
			h("span", { style: "font:700 9.5px var(--font-ui);letter-spacing:1px;color:var(--c-faint)" }, "MODIFIED"),
			h("span", {}),
		);
		container.appendChild(header);
		const body = h("div", {});
		container.appendChild(body);
		for (const [index, session] of sessionsSorted.entries()) {
			const row = rows[index];
			if (!row) continue;
			const checked = selection.has(session.file);
			const rowEl = h(
				"div",
				{
					class: "projects-row",
					style: `${TABLE_GRID};padding:7px 10px;border-radius:8px;${checked ? "background:var(--c-raised)" : ""}`,
				},
				h("input", {
					type: "checkbox",
					checked: checked ? true : undefined,
					style: "accent-color:var(--c-accent)",
					onclick: () => {
						if (selection.has(session.file)) selection.delete(session.file);
						else selection.add(session.file);
						renderTable(group);
					},
				}),
				h(
					"span",
					{
						class: "col-name",
						style: "cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px var(--font-ui);color:var(--c-text-2)",
						onclick: () => deps.onOpenSession(session.file),
					},
					row.name,
				),
				h("span", { class: "col-msgs", style: "font:400 11px var(--font-mono);color:var(--c-dim)" }, row.messages),
				h("span", { style: "font:400 11px var(--font-mono);color:var(--c-dim)" }, row.cost),
				h("span", { style: "font:400 11px var(--font-mono);color:var(--c-dim)" }, row.modifiedText),
				h(
					"span",
					{ class: "col-actions", style: "display:flex;gap:4px" },
					actionButton("rename", `Rename ${row.name}`, () => deps.onRowAction("rename", session)),
					actionButton("fork", `Fork ${row.name}`, () => deps.onRowAction("fork", session)),
					actionButton("export", `Export ${row.name}`, () => deps.onRowAction("export", session)),
					actionButton("share", `Share ${row.name}`, () => deps.onRowAction("share", session)),
					actionButton("delete", `Delete ${row.name}`, () => deps.onRowAction("delete", session)),
				),
			);
			body.appendChild(rowEl);
		}
		cardBody.appendChild(container);

		// Selection action bar under the table.
		const selectedSessions = group.sessions.filter((session) => selection.has(session.file));
		if (selectedSessions.length > 0) {
			const bar = h(
				"div",
				{ class: "c-banner", style: "margin-top:10px" },
				h("span", { class: "c-banner-text" }, `${selectedSessions.length} selected`),
			);
			const actions: Array<SessionAction> = ["rename", "fork", "export", "share", "delete"];
			for (const action of actions) {
				bar.appendChild(
					actionButton(action, `Apply ${action} to selection`, () => deps.onBatchAction(action, selectedSessions)),
				);
			}
			cardBody.appendChild(bar);
		}
	}

	async function renderContextFiles(cwd: string): Promise<void> {
		const card = h("div", { class: "c-card", style: "margin-top:14px" });
		const body = h("div", { style: "padding:12px 14px" });
		card.appendChild(body);
		rightColumn.appendChild(card);
		body.appendChild(h("div", { class: "c-card-title", style: "margin-bottom:8px" }, "Context files"));
		let context: ProjectContextFiles | undefined;
		try {
			context = await deps.projectContext(cwd);
		} catch {
			context = undefined;
		}
		if (!context || context.contextFiles.length === 0) {
			body.appendChild(
				h(
					"span",
					{ style: "color:var(--c-dim);font:400 11.5px var(--font-ui)" },
					"Open a session in this project to load its context files.",
				),
			);
			return;
		}
		const list = h("div", {});
		for (const file of context.contextFiles) {
			list.appendChild(
				h(
					"div",
					{
						style: "display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--c-hairline)",
					},
					iconEl("file"),
					h(
						"span",
						{
							style: "font:400 10.5px var(--font-mono);color:var(--c-text-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
						},
						file.path,
					),
					chipEl(file.source, { tone: "blue" }),
					h(
						"button",
						{
							class: "c-btn",
							style: "padding:2px 8px;font-size:10.5px",
							onclick: () => deps.openPreview(file.path),
						},
						"open",
					),
				),
			);
		}
		body.appendChild(list);
	}

	// ---- data lifecycle ----------------------------------------------
	async function fetchAndRender(): Promise<void> {
		const token = ++fetchToken;
		let sessions: Array<RpcSessionSummary> = [];
		try {
			sessions = await deps.fetchSessions();
		} catch {
			if (token !== fetchToken) return;
			clearElement(rightColumn);
			rightColumn.appendChild(
				h(
					"div",
					{ class: "c-card", style: "padding:18px;color:var(--c-danger)" },
					"Could not load sessions.",
					actionButton("retry", "Retry loading sessions", () => void fetchAndRender()),
				),
			);
			return;
		}
		if (token !== fetchToken) return;
		groups = projectGroups(sessions, deps.openSessions());
		renderProjectList();
		renderDetail();
	}

	return {
		id: "projects",
		title: "Projects",
		element,
		mount(): void {
			void fetchAndRender();
		},
		unmount(): void {
			fetchToken++;
			selection.clear();
			selectedCwd = undefined;
		},
	};
}
