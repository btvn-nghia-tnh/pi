/**
 * Right session panel (spec §3.2.6, issue-batch slim-down + subagents):
 * [Subagents card] + structured widget cards (todo, MCP status, …) reusing
 * renderWidget. The Session details / Usage—today / Extension statuses cards
 * were removed as duplicates of the chat status bar. The column hides
 * entirely while nothing renders (`.chat-right.is-empty`).
 *
 * The Subagents card polls the backend `subagent_status` command (Lane-A
 * contract) while the panel is visible, so the user can watch every
 * delegated run: state, task, recent activity, model, and timing.
 */

import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import { renderWidget } from "../render/widget-data.ts";
import type { AppState, Store } from "../state.ts";
import { relativeTime } from "../usage-text.ts";

/** Alias for the store state shape (mirrors status-bar.ts). */
export type StoreState = AppState;

// ------------------------------------------------------------------
// Subagent statuses — Lane-A `subagent_status` contract
// ------------------------------------------------------------------

/** One delegated subagent run as reported by the backend scanner. */
export interface SubagentRun {
	id: string;
	dir?: string;
	/** "running" | "complete" | "failed" | "needs-attention" | "unknown". */
	state?: string;
	agent?: string;
	/** ≤80 chars from the backend; re-clamped defensively. */
	task?: string;
	model?: string;
	startedAt?: number | string;
	updatedAt?: number | string;
	/** ≤120 chars: last meaningful log line; re-clamped defensively. */
	activity?: string;
	lines?: number;
}

export interface SubagentStatusResponse {
	roots?: string[];
	runs: SubagentRun[];
}

/** Minimal structural slice of PiConnection the poll uses. */
export interface SubagentStatusConnection {
	request<T = unknown>(command: { type: "subagent_status" }): Promise<T>;
}

/** ``undefined`` timestamps → ""; epoch numbers → ISO; strings pass through. */
function toIso(stamp: number | string | undefined): string {
	if (stamp === undefined || stamp === null) return "";
	if (typeof stamp === "number") {
		return Number.isFinite(stamp) ? new Date(stamp).toISOString() : "";
	}
	return stamp;
}

function toMs(stamp: number | string | undefined): number {
	const iso = toIso(stamp);
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? 0 : ms;
}

function clampText(text: string | undefined, max: number): string {
	const value = (text ?? "").replace(/\s+/g, " ").trim();
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

const STATE_TONES: Record<string, "accent" | "ok" | "danger" | "warn" | "dim"> = {
	running: "accent",
	complete: "ok",
	failed: "danger",
	"needs-attention": "warn",
};

/** Projected, display-ready subagent row. */
export interface SubagentRowView {
	id: string;
	/** Normalized state bucket ("unknown" for unrecognized values). */
	state: string;
	tone: "accent" | "ok" | "danger" | "warn" | "dim";
	task: string;
	activity: string;
	model?: string;
	startedText: string;
	updatedText: string;
	dir?: string;
	lines?: number;
}

/**
 * Pure projection over the backend runs list: dedupes by id (last update
 * wins), buckets unknown states, clamps task/activity (80/120), formats
 * relative times, and sorts running-first then updatedAt desc. The poll's
 * render path and the tests share this.
 */
export function subagentRows(runs: SubagentRun[] | undefined, now: number): SubagentRowView[] {
	const byId = new Map<string, SubagentRun>();
	for (const run of runs ?? []) {
		if (!run?.id) continue;
		byId.set(String(run.id), run); // later entries win (fresher payloads)
	}
	const rows: SubagentRowView[] = [];
	for (const run of byId.values()) {
		const state = typeof run.state === "string" && run.state ? run.state : "unknown";
		rows.push({
			id: String(run.id),
			state: state in STATE_TONES ? state : "unknown",
			tone: STATE_TONES[state] ?? "dim",
			task: clampText(run.task, 80),
			activity: clampText(run.activity, 120),
			model: run.model ? clampText(run.model, 40) : undefined,
			startedText: relativeTime(toIso(run.startedAt), now, { invalidText: "—" }),
			updatedText: relativeTime(toIso(run.updatedAt), now, { invalidText: "—" }),
			dir: run.dir,
			lines: typeof run.lines === "number" ? run.lines : undefined,
		});
	}
	rows.sort((a, b) => {
		const aRunning = a.state === "running" ? 1 : 0;
		const bRunning = b.state === "running" ? 1 : 0;
		if (aRunning !== bRunning) return bRunning - aRunning;
		return (
			toMs((byId.get(b.id) as SubagentRun | undefined)?.updatedAt) -
			toMs((byId.get(a.id) as SubagentRun | undefined)?.updatedAt)
		);
	});
	return rows;
}

// ------------------------------------------------------------------
// Panel
// ------------------------------------------------------------------

/**
 * Pure presence check: true when at least one structured (non-overlay)
 * widget has data — gates the `.chat-right.is-empty` class in chat.ts.
 */
export function hasWidgets(state: StoreState): boolean {
	for (const widget of state.widgets?.values() ?? []) {
		if (widget.data && widget.data.display !== "overlay") return true;
	}
	return false;
}

/** R11: model display convention shared with the status bar and editor toolbar. */
export function modelShortName(model: { id: string; name?: string } | undefined): string {
	if (!model) return "no-model";
	return model.name || (model.id.split("/").pop() ?? model.id);
}

export interface SessionPanelOpts {
	store: Store;
	/**
	 * Additive (Lane D): when provided the panel pads a Subagents card that
	 * polls `subagent_status` every 3s while visible. Absent → no card, no
	 * poll (the integration wires `connection` through app.ts).
	 */
	connection?: PiConnection | SubagentStatusConnection;
	/** Poll cadence in ms; overridable for tests. Default 3000. */
	subagentPollMs?: number;
}

const DEFAULT_POLL_MS = 3000;

export class SessionPanel {
	readonly element: HTMLElement;
	private readonly opts: SessionPanelOpts;
	private unsubscribe: (() => void) | undefined;
	/** Widget-slot memoization (identity-keyed, mirrors footer.ts's WidgetAreaView). */
	private lastWidgets: ReadonlyMap<string, unknown> | undefined;
	private lastCollapsed: ReadonlySet<string> | undefined;
	private widgetSlots: HTMLElement[] = [];
	/** True after a widget-slot rebuild — caches the empty list too. */
	private widgetSlotsMemoized = false;

	// Subagents card state.
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private pollInFlight = false;
	private subagentCardEl: HTMLElement | undefined;
	private subagentRows: SubagentRowView[] = [];
	private subagentFirstErrorHintShown = false;
	private subagentInitialFetchDone = false;
	private expandedRuns = new Set<string>();

	constructor(opts: SessionPanelOpts) {
		this.opts = opts;
		this.element = h("div", { class: "c-right-panel" });
	}

	mount(): void {
		if (this.unsubscribe) return; // idempotent across double-mount cycles
		this.unsubscribe = this.opts.store.subscribe(() => this.render());
		if (this.opts.connection && !this.pollTimer) {
			void this.pollSubagents(); // immediate first fetch on mount
			this.pollTimer = setInterval(() => {
				void this.pollSubagents();
			}, this.opts.subagentPollMs ?? DEFAULT_POLL_MS);
		}
		this.subagentInitialFetchDone = false;
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.pollInFlight = false;
		this.subagentCardEl = undefined;
		this.subagentRows = [];
		this.subagentFirstErrorHintShown = false;
		this.subagentInitialFetchDone = false;
		this.expandedRuns.clear();
		this.lastWidgets = undefined;
		this.lastCollapsed = undefined;
		this.widgetSlots = [];
		this.widgetSlotsMemoized = false;
	}

	/**
	 * Whether the panel column is available (not user-collapsed). The empty-
	 * hidden state (`.chat-right.is-empty` display:none) must NOT gate the poll
	 * — otherwise the column could never wake from empty when runs appear.
	 */
	private panelVisible(): boolean {
		if (typeof document === "undefined") return false;
		const host = this.element.closest(".chat-right");
		if (!host) return false;
		return !host.classList.contains("is-collapsed");
	}

	private async pollSubagents(): Promise<void> {
		const connection = this.opts.connection;
		if (!connection || this.pollInFlight) return;
		if (!this.panelVisible()) return; // save requests while hidden
		this.pollInFlight = true;
		try {
			const data = (await connection.request({ type: "subagent_status" })) as SubagentStatusResponse;
			this.subagentRows = subagentRows(data?.runs, Date.now());
			this.subagentInitialFetchDone = true;
			this.subagentFirstErrorHintShown = false; // a good poll clears the hint
			this.render();
		} catch {
			// First error surfaces a one-line hint once; later errors stay
			// silent (transient disconnects shouldn't nag).
			if (!this.subagentFirstErrorHintShown) {
				this.subagentFirstErrorHintShown = true;
				this.render();
			}
		} finally {
			this.pollInFlight = false;
		}
	}

	private render(): void {
		const state = this.opts.store.getState();
		const widgetCards = this.widgetCards(state);
		const subagentCard = this.subagentCard();
		const cards: HTMLElement[] = [];
		if (subagentCard) cards.push(subagentCard);
		cards.push(...widgetCards);
		const empty = cards.length === 0;
		this.element.classList.toggle("is-empty", empty);
		// The host column hides with the panel (chat page owns .chat-right);
		// the collapse-toggle tab hides while empty too (chat-right-host).
		const column = this.element.closest(".chat-right");
		column?.classList.toggle("is-empty", empty);
		column?.parentElement?.classList.toggle("is-panel-empty", empty);
		clearElement(this.element);
		this.element.append(...cards);
	}

	// ------------------------------------------------------------------
	// Subagents card
	// ------------------------------------------------------------------

	private subagentCard(): HTMLElement | undefined {
		if (!this.opts.connection) return undefined;
		if (!this.subagentInitialFetchDone) return undefined;
		const oneTimeHint =
			this.subagentFirstErrorHintShown && this.subagentRows.length === 0 ? this.buildSubagentHint() : undefined;
		if (this.subagentRows.length === 0) return oneTimeHint;
		if (this.subagentCardEl?.isConnected) {
			// Re-render in place: keep the card node, refresh its body so
			// expanded-detail toggles survive poll refreshes.
			this.fillSubagentBody(this.subagentCardEl);
			return this.subagentCardEl;
		}
		const card = h("div", { class: "c-card c-subagent-card" });
		const runningCount = this.subagentRows.filter((row) => row.state === "running").length;
		card.appendChild(
			h(
				"div",
				{ class: "c-card-title" },
				"Subagents",
				h("span", { class: `c-subagent-count${runningCount > 0 ? " is-running" : ""}` }, String(runningCount)),
			),
		);
		this.fillSubagentBody(card);
		this.subagentCardEl = card;
		return card;
	}

	private buildSubagentHint(): HTMLElement {
		return h(
			"div",
			{ class: "c-card c-subagent-card" },
			h("div", { class: "c-card-title" }, "Subagents"),
			h("div", { class: "c-subagent-empty" }, "Subagent status unavailable"),
		);
	}

	/** The scrollable rows body (rebuilt on every render — rows are cheap). */
	private fillSubagentBody(card: HTMLElement): void {
		const body = card.querySelector<HTMLElement>(".c-subagent-body");
		if (!body) {
			const created = h("div", { class: "c-subagent-body" });
			card.appendChild(created);
			this.fillSubagentBody(card);
			return;
		}
		clearElement(body);
		if (this.subagentRows.length === 0) {
			body.appendChild(h("div", { class: "c-subagent-empty" }, "No subagent runs in this machine's workspaces."));
			return;
		}
		for (const row of this.subagentRows) {
			body.appendChild(this.subagentRowEl(row));
		}
	}

	private subagentRowEl(row: SubagentRowView): HTMLElement {
		const expanded = this.expandedRuns.has(row.id);
		const head = h(
			"div",
			{ class: "c-subagent-row-head" },
			h("span", { class: `c-subagent-dot tone-${row.tone}${row.state === "running" ? " is-pulsing" : ""}` }),
			h("span", { class: "c-subagent-task", title: row.task }, row.task || row.id),
		);
		const metaBits: HTMLElement[] = [];
		if (row.model) metaBits.push(h("span", { class: "c-subagent-model" }, row.model));
		metaBits.push(h("span", { class: "c-subagent-time" }, row.updatedText));
		const meta = h("div", { class: "c-subagent-meta" }, ...metaBits);
		const el = h(
			"div",
			{
				class: `c-subagent-row${expanded ? " is-expanded" : ""}`,
				// Click a row to toggle the expanded detail (dir + activity + times).
				role: "button",
				tabindex: "0",
			},
			head,
			meta,
		);
		if (row.activity) {
			el.appendChild(h("div", { class: "c-subagent-activity" }, row.activity));
		}
		if (expanded) {
			const detail = h(
				"div",
				{ class: "c-subagent-detail" },
				h("div", {}, `started: ${row.startedText}`),
				h("div", {}, `updated: ${row.updatedText}`),
				row.dir ? h("div", { class: "c-subagent-dir", title: row.dir }, row.dir) : undefined,
				typeof row.lines === "number" ? h("div", {}, `${row.lines} log lines`) : undefined,
			);
			el.appendChild(detail);
		}
		const toggle = (): void => {
			if (this.expandedRuns.has(row.id)) {
				this.expandedRuns.delete(row.id);
			} else {
				this.expandedRuns.add(row.id);
			}
			this.render();
		};
		el.addEventListener("click", toggle);
		el.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				toggle();
			}
		});
		return el;
	}

	// ------------------------------------------------------------------
	// Widget cards
	// ------------------------------------------------------------------

	/** Structured widgets (widget.data present) as standalone cards. Lines-only
	 * widgets stay docked under the editor (spec §3.2.6) — app keeps those hosts. */
	private widgetCards(state: StoreState): HTMLElement[] {
		if (
			state.widgets === this.lastWidgets &&
			state.collapsedWidgets === this.lastCollapsed &&
			this.widgetSlotsMemoized
		) {
			return this.widgetSlots;
		}
		this.lastWidgets = state.widgets;
		this.lastCollapsed = state.collapsedWidgets;
		this.widgetSlots = [];
		for (const [key, widget] of state.widgets) {
			if (!widget.data) continue;
			if (widget.data.display === "overlay") continue;
			const panel = renderWidget(widget, key, {
				collapsed: state.collapsedWidgets.has(key),
				onToggle: () => this.opts.store.toggleWidgetCollapsed(key),
			});
			this.widgetSlots.push(h("div", { class: "c-widget-slot" }, panel));
		}
		this.widgetSlotsMemoized = true;
		return this.widgetSlots;
	}
}
