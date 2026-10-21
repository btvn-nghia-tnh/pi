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
import type { ReadFileData } from "../types.ts";
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
	/** Full task prompt from the backend (modal only; review wave T2 P1-2). */
	taskFull?: string;
	model?: string;
	startedAt?: number | string;
	updatedAt?: number | string;
	/** ≤120 chars: last meaningful log line; re-clamped defensively. */
	activity?: string;
	lines?: number;
	/** Batch-4 (backend T3): steering bookkeeping straight from status.json. */
	steering?: SubagentSteeringBlock;
}

/** Steering counters block (mirrors status.json `steering`). */
export interface SubagentSteeringBlock {
	requested?: number;
	scheduled?: number;
	pending?: number;
	delivered?: number;
	failed?: number;
	recovered?: number;
	recent?: SubagentSteeringRecent[];
}

/** One recent steering request as the backend records it. */
export interface SubagentSteeringRecent {
	id?: string;
	requestedAt?: number;
	/** ≤160-char preview of the steered message. */
	messagePreview?: string;
}

export interface SubagentStatusResponse {
	roots?: string[];
	runs: SubagentRun[];
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
	/** Full prompt for the modal (falls back to `task` when the backend sent none). */
	taskFull: string;
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
			taskFull: clampText(run.taskFull ?? run.task, 4000),
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
// Subagent detail modal — pure helpers (batch-4 B4)
// ------------------------------------------------------------------

/** Steer delivery mode, mirroring the pi-subagents control protocol. */
export type SteerMode = "steer" | "follow_up" | "auto";

/** Byte cap from the pi-subagents steer protocol (128 KB). */
export const MAX_STEER_MESSAGE_BYTES = 128 * 1024;

/** Message preview cap for the steering summary line. */
const STEERING_PREVIEW_CLAMP = 48;

/** Trimmed steer message or `undefined` when unusable (empty/whitespace/oversize). */
export function validSteerMessage(message: string): string | undefined {
	const value = message.trim();
	if (!value) return undefined;
	if (new TextEncoder().encode(value).byteLength > MAX_STEER_MESSAGE_BYTES) return undefined;
	return value;
}

/** First uuid segment or the whole id when it is already short. */
export function shortRunId(id: string): string {
	return id.split("-")[0] ?? id;
}

/** Human line for the steer response (server T3: {delivered, requestId?, reason?}). */
export function steerOutcomeText(response: unknown): string {
	const data = (response ?? {}) as {
		delivered?: string;
		requestId?: string;
		reason?: string;
		ack?: { state?: string; message?: string };
	};
	// Batch-4 review P1-1: a request that queued fine but whose runner ack came
	// back `failed` is a failure — surface it instead of a green "queued".
	if (data.ack?.state === "failed") {
		const detail = data.ack.message ?? data.reason;
		return `Steer failed${detail ? `: ${detail}` : ""}.`;
	}
	if (data.delivered === "failed") {
		return `Steer failed${data.reason ? `: ${data.reason}` : ""}.`;
	}
	if (data.delivered === "queued") {
		return `Steer queued${data.requestId ? ` (request ${shortRunId(data.requestId)})` : ""} — watch the steering line.`;
	}
	return "Steer sent.";
}

/** True when the steer response is a real failure (delivery or runner ack). */
export function steerOutcomeFailed(response: unknown): boolean {
	const data = (response ?? {}) as { delivered?: string; ack?: { state?: string } };
	return data.delivered === "failed" || data.ack?.state === "failed";
}

/** Human line for the stop response ({delivered: "requested" | "failed"}). */
export function stopOutcomeText(response: unknown): string {
	const data = (response ?? {}) as { delivered?: string };
	if (data.delivered === "failed") return "Stop failed — the run may have already ended.";
	return "Stop requested — the run halts at its next step boundary.";
}

/** Compact steering bookkeeping line; `undefined` when nothing to show. */
export function steeringSummary(steering: SubagentSteeringBlock | undefined): string | undefined {
	if (!steering) return undefined;
	const delivered = steering.delivered ?? 0;
	const failed = steering.failed ?? 0;
	if (delivered === 0 && failed === 0 && (steering.recent?.length ?? 0) === 0) return undefined;
	const parts = ["steering:"];
	if (delivered > 0) parts.push(`${delivered} delivered`);
	if (failed > 0) parts.push(`${failed} failed`);
	const recent = steering.recent?.[steering.recent.length - 1];
	if (recent?.messagePreview) {
		parts.push(`last: ${clampText(recent.messagePreview, STEERING_PREVIEW_CLAMP)}`);
	} else if (parts.length === 1) {
		parts.push("requested");
	}
	return parts.join(" ");
}

// ------------------------------------------------------------------
// Subagent detail modal (batch-4 B4) — overlay, body-level
// ------------------------------------------------------------------

export interface SubagentDetailModalOpts {
	row: SubagentRowView;
	/** Raw poll payload (un-clamped fields the card view trims). */
	raw: SubagentRun | undefined;
	/** Steer sender — rejects when the server build lacks the command. */
	sendSteer: (runId: string, message: string, mode: SteerMode) => Promise<unknown>;
	/** Stop sender with the same contract as steer. */
	sendStop: (runId: string) => Promise<unknown>;
	pushToast: (message: string, level: "info" | "warning" | "error") => void;
	/** When provided, "Open output log" links here (app wires preview). */
	openLog?: (path: string) => void;
	/**
	 * Loads the run's raw transcript (batch-5: the modal renders it inline like
	 * a chat instead of linking out). Rejects → the modal shows the error line.
	 */
	loadLog?: (path: string) => Promise<string>;
}

/**`true` when a run is still alive and steerable (stop/steer make sense). */
export function isSteerableState(state: string): boolean {
	return state === "running" || state === "needs-attention";
}

/** Inline transcript body; placeholder for runs that haven't emitted output yet. */
export function modalLogText(raw: string): string {
	const trimmed = raw.trimEnd();
	return trimmed.trim() === "" ? "(transcript empty — the runner hasn't emitted output yet)" : trimmed;
}

/** Full-detail overlay for one subagent run. Closes on Esc/scrim/X. */
export class SubagentDetailModal {
	private readonly scrim: HTMLElement;
	private readonly sheet: HTMLElement;
	private readonly statusLine: HTMLElement;
	private readonly escHandler: (event: KeyboardEvent) => void;
	private readonly opts: SubagentDetailModalOpts;
	private readonly shownRunId: string;
	private readonly logEl: HTMLElement;
	private readonly logPath: string | undefined;
	private logPollTimer: ReturnType<typeof setInterval> | undefined;
	private logInFlight = false;
	private logFirstLoad = true;
	private stopArmed = false;
	private stopRevertTimer: ReturnType<typeof setTimeout> | undefined;
	private stopButton: HTMLButtonElement | undefined;
	private busy = false;

	constructor(opts: SubagentDetailModalOpts) {
		this.opts = opts;
		const { row, raw } = opts;
		this.shownRunId = row.id;
		const stateParts: HTMLElement[] = [
			h("span", { class: `c-subagent-dot tone-${row.tone}${row.state === "running" ? " is-pulsing" : ""}` }),
			h("span", {}, row.state),
		];
		if (row.model) stateParts.push(h("span", { class: "c-subagent-model", style: "max-width:60%" }, row.model));

		const metaBits: HTMLElement[] = [
			h("div", {}, `started: ${row.startedText}`),
			h("div", {}, `updated: ${row.updatedText}`),
		];
		if (typeof raw?.lines === "number") metaBits.push(h("div", {}, `${raw.lines} log lines`));
		if (raw?.dir) metaBits.push(h("div", { class: "c-modal-dir", title: raw.dir }, raw.dir));

		// Batch-5: the raw run transcript renders INLINE like a chat — the old
		// "open output log" preview link is gone (owner: load the log here).
		this.logEl = h("pre", { class: "c-modal-log" });
		const logRegion =
			raw?.dir && opts.loadLog
				? h(
						"div",
						{ class: "c-modal-log-wrap" },
						h("div", { class: "c-modal-log-head" }, `transcript · ${raw.dir.replace(/\/$/, "")}/output-0.log`),
						this.logEl,
					)
				: undefined;
		this.logPath = raw?.dir && opts.loadLog ? `${raw.dir.replace(/\/$/, "")}/output-0.log` : undefined;

		this.statusLine = h("div", { class: "c-modal-status-line" });
		const closeEl = h("button", { class: "c-modal-close", title: "Close (Esc)", "aria-label": "Close" }, "×");
		closeEl.addEventListener("click", () => this.close());

		this.sheet = h(
			"div",
			{ class: "c-modal-sheet", role: "dialog", "aria-label": "Subagent detail" },
			h(
				"div",
				{ class: "c-modal-head" },
				h("span", { class: "c-modal-title", title: row.id }, `Subagent ${shortRunId(row.id)}`),
				closeEl,
			),
			h("div", { class: "c-modal-state" }, ...stateParts),
			h(
				"div",
				{ class: "c-modal-task", title: row.taskFull },
				row.taskFull || row.task || "(no task text)",
			),
			row.activity
				? h(
						"div",
						{ class: "c-modal-activity", title: raw?.activity ?? row.activity },
						raw?.activity ?? row.activity,
					)
				: undefined,
			h("div", { class: "c-modal-meta" }, ...metaBits),
			steeringSummary(raw?.steering)
				? h("div", { class: "c-modal-steering" }, steeringSummary(raw?.steering) ?? "")
				: undefined,
			logRegion,
			isSteerableState(row.state) ? this.buildActions(row.id) : undefined,
			this.statusLine,
		);
		this.scrim = h("div", { class: "c-modal-scrim" }, this.sheet);
		this.scrim.addEventListener("click", (event) => {
			if (event.target === this.scrim) this.close();
		});
		this.escHandler = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.close();
			}
		};
		window.addEventListener("keydown", this.escHandler);
		document.body.appendChild(this.scrim);
		if (this.logPath) {
			void this.refreshLog();
			if (isSteerableState(row.state)) {
				this.logPollTimer = setInterval(() => void this.refreshLog(), LOG_POLL_MS);
			}
		}
	}

	/** Fetch the raw transcript; pin to the bottom while the user stays there. */
	private async refreshLog(): Promise<void> {
		if (!this.logPath || !this.opts.loadLog || this.logInFlight) return;
		this.logInFlight = true;
		const pinned =
			this.logFirstLoad ||
			this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - LOG_PIN_SLACK_PX;
		try {
			const text = modalLogText(await this.opts.loadLog(this.logPath));
			if (this.logEl.textContent !== text) this.logEl.textContent = text;
		} catch (error) {
			this.logEl.textContent = `transcript unavailable: ${(error as Error).message}`;
		} finally {
			if (pinned) this.logEl.scrollTop = this.logEl.scrollHeight;
			this.logFirstLoad = false;
			this.logInFlight = false;
		}
	}

	/** Steer form + inline-confirm Stop; only for live runs. */
	private buildActions(runId: string): HTMLElement {
		const textarea = h("textarea", {
			class: "c-modal-steer-textarea",
			placeholder: "Message to steer this subagent mid-run…",
		}) as HTMLTextAreaElement;
		const modeSelect = h("select", {
			class: "c-modal-steer-mode",
			title: "Delivery mode",
			"aria-label": "Steer mode",
		}) as HTMLSelectElement;
		for (const mode of ["steer", "follow_up", "auto"] as const) {
			const option = h("option", { value: mode }, mode) as HTMLOptionElement;
			option.selected = mode === "steer";
			modeSelect.add(option);
		}
		const sendButton = h("button", { class: "c-btn c-btn--primary" }, "Send steer") as HTMLButtonElement;
		this.stopButton = h("button", { class: "c-btn c-btn--danger" }, "Stop") as HTMLButtonElement;

		sendButton.addEventListener("click", () => void this.submitSteer(runId, textarea, modeSelect));
		textarea.addEventListener("keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
				event.preventDefault();
				void this.submitSteer(runId, textarea, modeSelect);
			}
		});
		this.stopButton.addEventListener("click", () => void this.confirmStop(runId));

		return h(
			"div",
			{ class: "c-modal-actions" },
			h(
				"div",
				{ class: "c-modal-steer-form" },
				textarea,
				h("div", { class: "c-modal-steer-controls" }, modeSelect, sendButton, this.stopButton),
			),
		);
	}

	private setBusy(next: boolean): void {
		this.busy = next;
	}

	private setStatus(text: string, tone: "" | " is-ok" | " is-error" = ""): void {
		this.statusLine.className = `c-modal-status-line${tone}`;
		this.statusLine.textContent = text;
	}

	private async submitSteer(
		runId: string,
		textarea: HTMLTextAreaElement,
		modeSelect: HTMLSelectElement,
	): Promise<void> {
		if (this.busy) return;
		const message = validSteerMessage(textarea.value);
		if (!message) {
			this.setStatus("Steer message cannot be empty.", " is-error");
			return;
		}
		const mode = (
			modeSelect.value === "follow_up" || modeSelect.value === "auto" ? modeSelect.value : "steer"
		) as SteerMode;
		this.setBusy(true);
		this.setStatus("Sending steer…");
		try {
			const response = await this.opts.sendSteer(runId, message, mode);
			const text = steerOutcomeText(response);
			const failed = steerOutcomeFailed(response);
			this.setStatus(text, failed ? " is-error" : " is-ok");
			this.opts.pushToast(text, failed ? "warning" : "info");
			if (!failed) textarea.value = "";
		} catch (error) {
			const text = `Subagent steering unavailable on this server build (${(error as Error).message})`;
			this.setStatus(text, " is-error");
			this.opts.pushToast("Subagent steering unavailable on this server build", "warning");
		} finally {
			this.setBusy(false);
		}
	}

	/** First click arms (label flips); second click within 3s fires the stop. */
	private async confirmStop(runId: string): Promise<void> {
		const button = this.stopButton;
		if (!button || this.busy) return;
		if (!this.stopArmed) {
			this.stopArmed = true;
			button.textContent = "Confirm stop";
			this.stopRevertTimer = setTimeout(() => {
				this.stopArmed = false;
				if (button.isConnected) button.textContent = "Stop";
			}, 3000);
			return;
		}
		if (this.stopRevertTimer) clearTimeout(this.stopRevertTimer);
		this.stopArmed = false;
		this.setBusy(true);
		this.setStatus("Sending stop…");
		try {
			const response = await this.opts.sendStop(runId);
			const text = stopOutcomeText(response);
			const failed = (response as { delivered?: string } | undefined)?.delivered === "failed";
			this.setStatus(text, failed ? " is-error" : " is-ok");
			this.opts.pushToast(text, failed ? "warning" : "info");
		} catch (error) {
			this.setStatus(`Stop failed (${(error as Error).message}).`, " is-error");
			this.opts.pushToast("Subagent stop unavailable on this server build", "warning");
		} finally {
			this.setBusy(false);
			if (button.isConnected) button.textContent = "Stop";
		}
	}

	/** Idempotent close: removes the overlay + Esc listener + pending timers. */
	close(): void {
		if (this.stopRevertTimer) clearTimeout(this.stopRevertTimer);
		this.stopRevertTimer = undefined;
		if (this.logPollTimer) clearInterval(this.logPollTimer);
		this.logPollTimer = undefined;
		window.removeEventListener("keydown", this.escHandler);
		this.scrim.remove();
	}

	/** Whether this instance was opened for the given run id. */
	isShownFor(runId: string): boolean {
		return this.shownRunId === runId;
	}
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
	connection?: PiConnection;
	/** Poll cadence in ms; overridable for tests. Default 3000. */
	subagentPollMs?: number;
	/** Batch-4 (B4): optional file-preview opener the run modal can use —
	 * app wires its existing preview column here (app.ts integration). */
	openPreview?: (path: string) => void;
}

const DEFAULT_POLL_MS = 3000;
/** Transcript refresh cadence while a run is live (modal open). */
const LOG_POLL_MS = 3000;
/** Bottom-distance under which the transcript view is considered "pinned". */
const LOG_PIN_SLACK_PX = 24;

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
	/** Raw poll payloads by run id — the modal shows un-clamped fields (batch-4 B4). */
	private subagentRawRuns: ReadonlyMap<string, SubagentRun> = new Map();
	/** The open detail modal, if any — single instance per panel (batch-4 B4). */
	private subagentModal: SubagentDetailModal | undefined;

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
		this.subagentRawRuns = new Map();
		this.subagentModal?.close();
		this.subagentModal = undefined;
		this.subagentFirstErrorHintShown = false;
		this.subagentInitialFetchDone = false;
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
			this.subagentRawRuns = new Map(
				(data?.runs ?? []).filter((run) => run?.id).map((run) => [String(run.id), run]),
			);
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
				// Click a row to open the full-detail modal (batch-4 B4): task,
				// timing, steering state, and steer/stop controls for live runs.
				class: "c-subagent-row",
				role: "button",
				tabindex: "0",
			},
			head,
			meta,
		);
		if (row.activity) {
			el.appendChild(h("div", { class: "c-subagent-activity" }, row.activity));
		}
		el.addEventListener("click", () => this.openSubagentModal(row.id));
		el.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.openSubagentModal(row.id);
			}
		});
		return el;
	}

	/** Open (or replace) the detail modal for a run id from the latest poll. */
	private openSubagentModal(runId: string): void {
		const row = this.subagentRows.find((candidate) => candidate.id === runId);
		if (!row) return;
		if (this.subagentModal) {
			// Same-run click on an open modal keeps it (no close-reopen flicker);
			// a different run replaces the open modal — single instance.
			if (this.subagentModal.isShownFor(runId)) return;
			this.subagentModal.close();
		}
		this.subagentModal = new SubagentDetailModal({
			row,
			raw: this.subagentRawRuns.get(runId),
			sendSteer: (id, message, mode) => this.sendSubagentCommand(id, { type: "subagent_steer", message, mode }),
			sendStop: (id) => this.sendSubagentCommand(id, { type: "subagent_stop" }),
			pushToast: (message, level) => this.opts.store.pushNotification(message, level),
			openLog: this.opts.openPreview,
			loadLog: (path) => this.loadRunLog(path),
		});
	}

	/** Raw transcript read (web `read_file` command, text kind). */
	private async loadRunLog(path: string): Promise<string> {
		const connection = this.opts.connection;
		if (!connection) throw new Error("not connected");
		const data = (await connection.request({ type: "read_file", path })) as ReadFileData;
		if (data?.kind !== "text") throw new Error(`unexpected log format: ${data?.kind ?? "unknown"}`);
		const text = data.text ?? "";
		if (data.truncated === true) {
			return `${text}\n… (truncated — ${data.shownLines ?? "?"}/${data.totalLines ?? "?"} lines shown)`;
		}
		return text;
	}

	/** Request helper for the steer/stop commands (server contract, batch-4 T3). */
	private sendSubagentCommand(
		runId: string,
		payload: { type: "subagent_steer"; message: string; mode: SteerMode } | { type: "subagent_stop" },
	): Promise<unknown> {
		const connection = this.opts.connection;
		if (!connection) return Promise.reject(new Error("not connected"));
		if (payload.type === "subagent_steer") {
			return connection.request({ type: "subagent_steer", runId, message: payload.message, mode: payload.mode });
		}
		return connection.request({ type: "subagent_stop", runId, reason: "requested from the web console" });
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
