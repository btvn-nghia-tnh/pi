/**
 * Right session panel (spec §3.2.6, issue-batch slim-down + subagents):
 * [Subagents card] + structured widget cards (todo, MCP status, …) reusing
 * renderWidget. The Session details / Usage—today / Extension statuses cards
 * were removed as duplicates of the chat status bar. The column hides
 * entirely while nothing renders (`.chat-right.is-empty`).
 *
 * The Subagents card polls the backend `subagent_status` command (Lane-A
 * contract) while the panel is visible, SCOPED to the active session: each
 * run records the master session file that spawned it, and the card asks for
 * `sessionPath` so switching sessions swaps the list instead of showing every
 * run on the machine. The pi-subagents widget snapshot ("subagent-async",
 * its raw `PI_SUBAGENT_ASYNC_JSON:` line is blocklisted from the composer)
 * enriches the card live: workflow labels + running-step counts between polls.
 */

import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import { renderAssistantMessage, renderUserMessage } from "../render/messages.ts";
import { renderToolCard } from "../render/tools.ts";
import { renderWidget } from "../render/widget-data.ts";
import type { AppState, Store, ToolCardState, TranscriptItem } from "../state.ts";
import type { AgentMessage, SubagentTranscriptResponse } from "../types.ts";
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
	/**
	 * Master session file that spawned the run (status.json `sessionId`) — the
	 * key the card filters on so the list follows the ACTIVE session.
	 */
	sessionId?: string;
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
// Session scoping + live snapshot + card re-render signature
// ------------------------------------------------------------------

/**
 * Keep only the runs spawned by the given master session file. When the
 * caller has no session path yet (pre-connect), everything passes through;
 * runs without a recorded `sessionId` are dropped while filtering — they
 * cannot be attributed to the open session.
 */
export function filterRunsForSession(runs: SubagentRun[] | undefined, sessionFile: string | undefined): SubagentRun[] {
	const list = runs ?? [];
	if (!sessionFile) return list;
	return list.filter((run) => run?.sessionId === sessionFile);
}

/** Widget key pi-subagents uses for its async-status snapshot lines. */
export const ASYNC_SNAPSHOT_WIDGET_KEY = "subagent-async";
/** Line prefix of the encoded snapshot (first line only, JSON payload after). */
export const ASYNC_SNAPSHOT_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

/** One async job as the pi-subagents snapshot reports it (subset we render). */
export interface AsyncSnapshotRun {
	id?: string;
	label?: string;
	state?: string;
	updatedAt?: number;
	activity?: { turnCount?: number; toolCount?: number };
	children?: Array<{ id?: string; label?: string; state?: string }>;
}

/**
 * Decode the pi-subagents async-status widget into the fields the card uses.
 * Tolerant by contract: the widget is an extension-private payload — any
 * missing prefix / bad JSON degrades to `undefined` (no card enrichment).
 */
export function parseAsyncSnapshot(lines: string[] | undefined): { runs: AsyncSnapshotRun[] } | undefined {
	for (const line of lines ?? []) {
		if (typeof line !== "string" || !line.startsWith(ASYNC_SNAPSHOT_PREFIX)) continue;
		try {
			const parsed = JSON.parse(line.slice(ASYNC_SNAPSHOT_PREFIX.length)) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
			const runs = (parsed as { runs?: unknown }).runs;
			return { runs: Array.isArray(runs) ? (runs as AsyncSnapshotRun[]) : [] };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Identity of the rendered card body. The 3s poll (and every streaming store
 * tick) calls back into the card; rebuilding equal data would reset the scroll
 * offset — an owner-reported "list jumps back to the top" bug. The signature
 * covers every field the rows display (labels included, so snapshot arrivals
 * repaint).
 */
export function subagentRowsSignature(rows: SubagentRowView[], labels?: ReadonlyMap<string, string>): string {
	return rows
		.map(
			(row) => `${row.id}:${row.state}:${row.updatedText}:${row.task}:${row.activity}:${labels?.get(row.id) ?? ""}`,
		)
		.join("|");
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
	/** "open raw log" link — app wires its preview column here (debug escape hatch). */
	openLog?: (path: string) => void;
	/**
	 * Loads the run's projected chat transcript (`subagent_transcript`): the
	 * modal renders it like the real chat — user bubbles, assistant markdown +
	 * thinking, tool cards — instead of dumping output-0.log. Rejects → inline
	 * error line, card details stay usable.
	 */
	loadTranscript: (runId: string) => Promise<SubagentTranscriptResponse>;
}

export interface SubagentTranscriptItemView extends TranscriptItem {
	kind: "user" | "assistant";
}

/**
 * Project the backend `subagent_transcript` payload into the SAME item shape
 * the main chat transcript renders (message + toolCards map), so the modal
 * reuses renderUserMessage / renderAssistantMessage / renderToolCard verbatim.
 * Pure — unit-tested.
 */
export function buildTranscriptItemView(result: SubagentTranscriptResponse): SubagentTranscriptItemView[] {
	const views: SubagentTranscriptItemView[] = [];
	for (const item of result.items ?? []) {
		const toolCards = new Map<string, ToolCardState>();
		for (const card of item.toolCards ?? []) {
			if (!card?.toolCallId) continue;
			toolCards.set(card.toolCallId, {
				toolCallId: card.toolCallId,
				toolName: card.toolName,
				args: card.args,
				result: card.result,
				isError: card.isError === true,
				expanded: false,
				running: card.running === true,
			});
		}
		views.push({
			kind: item.kind === "user" ? "user" : "assistant",
			id: item.id,
			// The backend message is the agent message record verbatim (role +
			// content blocks); the renderers narrow it themselves.
			message: item.message as unknown as AgentMessage,
			streaming: false,
			toolCards,
		});
	}
	return views;
}

/**
 * Cheap change detector for transcript re-renders: the poll re-fetches a live
 * run every 3s, and rebuilding an unchanged transcript would fight the user's
 * scroll position. Pure — unit-tested.
 */
export function transcriptSignature(result: SubagentTranscriptResponse | undefined): string {
	if (!result) return "";
	const last = result.items[result.items.length - 1];
	return `${result.state}|${result.lineCount}|${result.items.length}|${last?.id ?? ""}|${result.truncated ? 1 : 0}`;
}

/** `true` when a run is still alive and steerable (stop/steer make sense). */
export function isSteerableState(state: string): boolean {
	return state === "running" || state === "needs-attention";
}

/** Full-detail overlay for one subagent run. Closes on Esc/scrim/X. */
export class SubagentDetailModal {
	private readonly scrim: HTMLElement;
	private readonly sheet: HTMLElement;
	private readonly statusLine: HTMLElement;
	private readonly escHandler: (event: KeyboardEvent) => void;
	private readonly opts: SubagentDetailModalOpts;
	private readonly shownRunId: string;
	/** Chat-like run transcript container (placeholder until the first paint). */
	private readonly chatEl: HTMLElement;
	/** Full-prompt box — dropped once the transcript's first user bubble shows it. */
	private taskEl: HTMLElement | undefined;
	/** Rendered tool cards by toolCallId (a toggle replaces just that node). */
	private readonly toolCardEls = new Map<string, HTMLElement>();
	private readonly toolCards = new Map<string, ToolCardState>();
	private transcriptPollTimer: ReturnType<typeof setInterval> | undefined;
	private transcriptInFlight = false;
	private transcriptFirstLoad = true;
	private transcriptSig: string | undefined;
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

		// Batch-6: the run's own event stream, projected into chat items, renders
		// INLINE with the main transcript renderers (thinking blocks, markdown,
		// tool cards) — the old raw output-0.log <pre> is gone. The router keeps
		// "open raw log" as a debug escape hatch.
		this.chatEl = h("div", { class: "c-modal-chat" }, h("div", { class: "c-subagent-empty" }, "loading transcript…"));
		this.chatEl.addEventListener("toggle-tool", (event) => {
			const toolCallId = String((event as CustomEvent).detail ?? "");
			const card = this.toolCards.get(toolCallId);
			const previous = this.toolCardEls.get(toolCallId);
			if (!card || !previous) return;
			// renderToolCard already flipped card.expanded on the header click; swap
			// the single card node so the transcript (and its scroll) stays put.
			const next = renderToolCard(card, MODAL_TOOL_CARD_OPTIONS);
			this.toolCardEls.set(toolCallId, next);
			previous.replaceWith(next);
		});
		this.taskEl = h(
			"div",
			{ class: "c-modal-task", title: row.taskFull },
			row.taskFull || row.task || "(no task text)",
		);
		const rawLogPath = raw?.dir ? `${raw.dir.replace(/\/$/, "")}/output-0.log` : undefined;
		const rawLogLink =
			rawLogPath && opts.openLog
				? h(
						"button",
						{ class: "c-btn", title: rawLogPath, onclick: () => opts.openLog?.(rawLogPath) },
						"open raw log →",
					)
				: undefined;

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
			this.taskEl,
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
			this.chatEl,
			rawLogLink,
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
		void this.refreshTranscript();
		if (isSteerableState(row.state)) {
			this.transcriptPollTimer = setInterval(() => void this.refreshTranscript(), LOG_POLL_MS);
		}
	}

	/** Fetch the projected transcript; keep the view pinned while the user stays at the bottom. */
	private async refreshTranscript(): Promise<void> {
		if (this.transcriptInFlight) return;
		this.transcriptInFlight = true;
		const pinned =
			this.transcriptFirstLoad ||
			this.chatEl.scrollTop + this.chatEl.clientHeight >= this.chatEl.scrollHeight - LOG_PIN_SLACK_PX;
		try {
			this.renderTranscript(await this.opts.loadTranscript(this.shownRunId));
		} catch (error) {
			this.transcriptSig = undefined; // let the next successful poll repaint
			this.chatEl.replaceChildren(
				h("div", { class: "c-subagent-empty" }, `transcript unavailable: ${(error as Error).message}`),
			);
		} finally {
			if (pinned) this.chatEl.scrollTop = this.chatEl.scrollHeight;
			this.transcriptFirstLoad = false;
			this.transcriptInFlight = false;
		}
	}

	/** Paint the chat items (skipped when the payload is unchanged). */
	private renderTranscript(result: SubagentTranscriptResponse): void {
		const signature = transcriptSignature(result);
		if (signature === this.transcriptSig) return;
		this.transcriptSig = signature;
		this.toolCardEls.clear();
		this.toolCards.clear();
		const views = buildTranscriptItemView(result);
		if (views.length === 0) {
			this.chatEl.replaceChildren(
				h("div", { class: "c-subagent-empty" }, "(no messages yet — the runner hasn't emitted output)"),
			);
			return;
		}
		const nodes: HTMLElement[] = [];
		for (const view of views) {
			const wrap = h("div", { class: `transcript-item item-${view.kind}` });
			if (view.kind === "user") {
				wrap.appendChild(renderUserMessage(view));
			} else {
				wrap.appendChild(renderAssistantMessage(view, MODAL_ASSISTANT_OPTIONS));
				for (const card of view.toolCards.values()) {
					const el = renderToolCard(card, MODAL_TOOL_CARD_OPTIONS);
					this.toolCards.set(card.toolCallId, card);
					this.toolCardEls.set(card.toolCallId, el);
					wrap.appendChild(el);
				}
			}
			nodes.push(wrap);
		}
		if (result.truncated) {
			nodes.push(h("div", { class: "c-subagent-empty" }, "… transcript truncated (long run or large blocks)"));
		}
		this.chatEl.replaceChildren(...nodes);
		// The first user bubble IS the full prompt the master sent — the header
		// box duplicating it can go once the transcript is on screen.
		if (views.some((view) => view.kind === "user")) {
			this.taskEl?.remove();
			this.taskEl = undefined;
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
		if (this.transcriptPollTimer) clearInterval(this.transcriptPollTimer);
		this.transcriptPollTimer = undefined;
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
/** Modal tool cards are read-only: no image lightbox, no bash-stop wiring. */
const MODAL_TOOL_CARD_OPTIONS = { showImages: false } as const;
/** Assistant bubbles default to collapsed thinking (the main transcript's default). */
const MODAL_ASSISTANT_OPTIONS = { thinkingLevel: "medium", thinkingVisible: false, hideThinkingBlock: false } as const;

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
	/** Signature of the last painted rows — polls skip equal repaints (scroll). */
	private subagentBodySignature: string | undefined;
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
		this.subagentBodySignature = undefined;
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
			// Session scope: the panel follows the ACTIVE session, so switching
			// sessions swaps the list instead of keeping every run on the machine.
			const sessionFile = this.opts.store.getState().sessionState?.sessionFile;
			const data = (await connection.request({
				type: "subagent_status",
				...(sessionFile ? { sessionPath: sessionFile } : {}),
			})) as SubagentStatusResponse;
			const runs = filterRunsForSession(data?.runs, sessionFile);
			this.subagentRows = subagentRows(runs, Date.now());
			this.subagentRawRuns = new Map(runs.filter((run) => run?.id).map((run) => [String(run.id), run]));
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
		// Scroll-preservation at the PANEL level: clearElement below detaches
		// the reused card node, and detaching a scroll container resets its
		// scrollTop in every engine — signature-gating the body rows is not
		// enough (owner: "list jumps back to the top" every few seconds).
		// Capture the body offset before the detach and restore it after the
		// re-attach; widget cards have no scrollable bodies of their own.
		const cardBody = this.subagentCardEl?.querySelector<HTMLElement>(".c-subagent-body");
		const bodyScroll = cardBody?.isConnected ? cardBody.scrollTop : 0;
		clearElement(this.element);
		this.element.append(...cards);
		if (bodyScroll > 0) {
			const restored = this.subagentCardEl?.querySelector<HTMLElement>(".c-subagent-body");
			if (restored) restored.scrollTop = bodyScroll;
		}
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
		const snapshot = this.snapshotLabels();
		if (this.subagentCardEl?.isConnected) {
			// Re-render in place: keep the card node, refresh its body so
			// expanded-detail toggles survive poll refreshes.
			this.fillSubagentBody(this.subagentCardEl, snapshot.byRunId);
			this.updateSubagentBadge(this.subagentCardEl, snapshot.childrenRunning);
			return this.subagentCardEl;
		}
		const card = h("div", { class: "c-card c-subagent-card" });
		card.appendChild(h("div", { class: "c-card-title" }, "Subagents", h("span", { class: "c-subagent-count" }, "0")));
		this.fillSubagentBody(card, snapshot.byRunId);
		this.updateSubagentBadge(card, snapshot.childrenRunning);
		this.subagentCardEl = card;
		return card;
	}

	/**
	 * Live-step count for the card badge: the disk poll reports per-RUN states,
	 * while the extension snapshot counts the running workflow CHILDREN — the
	 * higher of the two tells the owner how much work is actually in flight.
	 */
	private updateSubagentBadge(card: HTMLElement, childrenRunning: number): void {
		const badge = card.querySelector<HTMLElement>(".c-subagent-count");
		if (!badge) return;
		const runsRunning = this.subagentRows.filter((row) => row.state === "running").length;
		const running = Math.max(runsRunning, childrenRunning);
		badge.textContent = String(running);
		badge.classList.toggle("is-running", running > 0);
	}

	/** Snapshot enrichment: workflow labels + running-child count (live between polls). */
	private snapshotLabels(): { byRunId: ReadonlyMap<string, string>; childrenRunning: number } {
		const byRunId = new Map<string, string>();
		let childrenRunning = 0;
		const widget = this.opts.store.getState().widgets.get(ASYNC_SNAPSHOT_WIDGET_KEY);
		const snapshot = parseAsyncSnapshot(widget?.lines);
		for (const run of snapshot?.runs ?? []) {
			if (run?.id && run.label) byRunId.set(run.id, run.label);
			for (const child of run?.children ?? []) {
				if (child?.state === "running") childrenRunning += 1;
			}
		}
		return { byRunId, childrenRunning };
	}

	private buildSubagentHint(): HTMLElement {
		return h(
			"div",
			{ class: "c-card c-subagent-card" },
			h("div", { class: "c-card-title" }, "Subagents"),
			h("div", { class: "c-subagent-empty" }, "Subagent status unavailable"),
		);
	}

	/**
	 * The scrollable rows body. Polls arrive every 3s and every agent event
	 * re-renders the panel; rebuilding equal rows would reset `scrollTop` each
	 * time (owner: "list jumps back to the top"). The signature skips equal
	 * repaints and the scroll offset survives real ones.
	 */
	private fillSubagentBody(card: HTMLElement, labels: ReadonlyMap<string, string>): void {
		const body = card.querySelector<HTMLElement>(".c-subagent-body");
		if (!body) {
			const created = h("div", { class: "c-subagent-body" });
			card.appendChild(created);
			this.fillSubagentBody(card, labels);
			return;
		}
		const signature = subagentRowsSignature(this.subagentRows, labels);
		if (signature === this.subagentBodySignature && body.childElementCount > 0) return;
		this.subagentBodySignature = signature;
		const scrollTop = body.scrollTop;
		clearElement(body);
		if (this.subagentRows.length === 0) {
			body.appendChild(h("div", { class: "c-subagent-empty" }, "No subagents in this session."));
			return;
		}
		for (const row of this.subagentRows) {
			body.appendChild(this.subagentRowEl(row, labels.get(row.id)));
		}
		body.scrollTop = scrollTop;
	}

	private subagentRowEl(row: SubagentRowView, label?: string): HTMLElement {
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
		// The status.json activity line is often blank for workflows; the extension
		// snapshot's label ("reviewer, reviewer, reviewer, +1 more") fills the gap.
		const activity = row.activity || label;
		if (activity) {
			el.appendChild(h("div", { class: "c-subagent-activity" }, activity));
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
			loadTranscript: (id) => this.loadTranscript(id),
		});
	}

	/** Chat transcript for the modal (projected from the run's event stream). */
	private async loadTranscript(runId: string): Promise<SubagentTranscriptResponse> {
		const connection = this.opts.connection;
		if (!connection) throw new Error("not connected");
		return (await connection.request({ type: "subagent_transcript", runId })) as SubagentTranscriptResponse;
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
