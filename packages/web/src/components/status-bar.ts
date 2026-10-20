/**
 * Bottom status bar (spec §3.2.5): cwd/branch/session left, context bar center,
 * cost/tokens + model chip right, sanitized extension-status chips.
 * Replaces the legacy FooterView text line.
 */
import { type StatusTone, sanitizeStatusText } from "../ansi-clean.ts";
import { h } from "../dom.ts";
import { formatCwdForFooter } from "../footer-format.ts";
import type { AppState, Store } from "../state.ts";
import type { UsageInfo } from "../types.ts";
import { cacheHitPct, contextLabel, totalsLine } from "../usage-text.ts";
import { chipEl, type ProgressHandle, progressEl, toggleEl } from "./kit.ts";
import { modelShortName } from "./session-panel.ts";

/** Alias for the store state shape (Task 12 imports this name). */
export type StoreState = AppState;

/**
 * TUI-equivalent context tokens (agent-session.ts calculateContextTokens):
 * totalTokens when reported, else input+output+cacheRead+cacheWrite.
 * Pure — unit-tested.
 */
export function contextTokensOf(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}): number {
	const reported = usage.totalTokens ?? 0;
	return reported || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** The freshest usable usage: streaming latestUsage, else the last rehydrated assistant message with usage. */
export function lastAssistantUsage(state: StoreState): UsageInfo | undefined {
	if (state.latestUsage) return state.latestUsage;
	const items = state.items ?? [];
	for (let i = items.length - 1; i >= 0; i--) {
		const message = items[i]?.message as { role?: string; usage?: UsageInfo } | undefined;
		if (message?.role !== "assistant" || !message.usage) continue;
		const usage = message.usage;
		if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.totalTokens ?? 0) > 0) {
			return usage;
		}
	}
	return undefined;
}

export interface StatusBarParts {
	cwdText: string;
	branch: string | undefined;
	sessionName: string | undefined;
	context: { percent: number | null; window: number; auto: boolean };
	rightText: string;
	modelText: string;
	statuses: Array<{ key: string; text: string; tone: StatusTone }>;
}

/** Home dir ≈ agent dir minus the ".pi/agent" suffix — deterministic in browser and tests. */
function homeFromAgentDir(agentDir: string | undefined): string | undefined {
	if (!agentDir) return undefined;
	const home = agentDir.replace(/\/\.pi\/agent$/, "");
	return home === agentDir ? undefined : home;
}

function prettyCwd(cwd: string, agentDir: string | undefined): string {
	return formatCwdForFooter(cwd, homeFromAgentDir(agentDir));
}

export function statusBarProjector(state: StoreState): StatusBarParts {
	const sessionState = state.sessionState;
	// Derived context (matches TUI footer semantics): when the server has not
	// reported a live context percent, derive one from the freshest assistant
	// usage so the bar never sticks on "? of <window>".
	const contextWindow = state.contextUsage?.contextWindow ?? sessionState?.model?.contextWindow ?? 0;
	let contextPercent = state.contextUsage?.percent ?? null;
	if (contextPercent === null && contextWindow > 0) {
		const usage = lastAssistantUsage(state);
		if (usage) {
			const tokens = contextTokensOf(usage);
			if (tokens > 0) contextPercent = (tokens / contextWindow) * 100;
		}
	}
	const parts: StatusBarParts = {
		cwdText: prettyCwd(state.contextInfo?.cwd ?? "", state.contextInfo?.agentDir),
		branch: state.contextInfo?.gitBranch || undefined,
		sessionName: sessionState?.sessionName || undefined,
		context: {
			percent: contextPercent,
			window: contextWindow,
			auto: sessionState?.autoCompactionEnabled ?? false,
		},
		rightText: "",
		modelText: "no-model",
		statuses: [],
	};
	if (sessionState?.model) {
		const shortId = modelShortName(sessionState.model);
		parts.modelText = sessionState.thinkingLevel ? `${shortId} · ${sessionState.thinkingLevel}` : shortId;
	}
	const hit = state.latestUsage ? cacheHitPct(state.latestUsage) : null;
	parts.rightText = totalsLine(
		{
			input: state.footerUsage.input,
			output: state.footerUsage.output,
			cost: state.footerUsage.cost,
		},
		hit,
	);
	for (const [key, text] of state.extensionStatuses ?? new Map()) {
		const clean = sanitizeStatusText(text);
		if (clean.text) parts.statuses.push({ key, ...clean });
	}
	return parts;
}

/**
 * Context popover body (spec §3.2.5). app.ts (Task 12) opens it via
 * `openAnchoredMenu(anchor, contextMenu(...))`; compaction actions map to
 * `{ type: "compact" }` and `{ type: "set_auto_compaction", enabled: next }`.
 */
export function contextMenu(
	handlers: { onCompactNow: () => void; onToggleAuto: (next: boolean) => void },
	ctx: { auto: boolean },
): (close: () => void) => HTMLElement {
	return (close: () => void) =>
		h(
			"div",
			{ class: "c-popover-list" },
			h(
				"button",
				{
					class: "c-popover-row",
					onclick: () => {
						handlers.onCompactNow();
						close();
					},
				},
				"Compact context now",
			),
			h(
				"div",
				{ class: "c-popover-row" },
				h("span", { class: "c-popover-main" }, "Auto-compaction"),
				toggleEl(ctx.auto, handlers.onToggleAuto),
			),
		);
}

/**
 * Popover callbacks receive the anchor element so the popover can be
 * positioned on the exact chip/button the user clicked (Task 12 wiring).
 */
export interface StatusBarOpts {
	onOpenModels(anchor: HTMLElement): void;
	onOpenContext(anchor: HTMLElement): void;
}

export class StatusBarView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private readonly opts: StatusBarOpts;
	private progress: ProgressHandle | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(store: Store, opts: StatusBarOpts) {
		this.store = store;
		this.opts = opts;
		this.element = h(
			"div",
			{ class: "c-statusbar" },
			h("span", { class: "c-sb-left" }),
			h("span", { class: "c-sb-center" }),
			h("span", { class: "c-sb-right" }),
		);
	}

	mount(): void {
		if (this.unsubscribe) return; // idempotent across double-mount cycles
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.progress = undefined;
	}

	private render(): void {
		const state = this.store.getState();
		const parts = statusBarProjector(state);
		const left = this.element.querySelector<HTMLElement>(".c-sb-left")!;
		const center = this.element.querySelector<HTMLElement>(".c-sb-center")!;
		const right = this.element.querySelector<HTMLElement>(".c-sb-right")!;
		left.replaceChildren(
			h("span", { class: "c-sb-cwd mono" }, parts.cwdText),
			...(parts.branch ? [h("span", { class: "c-sb-item" }, `⎇ ${parts.branch}`)] : []),
			...(parts.sessionName ? [h("span", { class: "c-sb-item dim" }, parts.sessionName)] : []),
		);
		if (!this.progress) {
			this.progress = progressEl(parts.context.percent ?? 0, 180);
		}
		this.progress.update(parts.context.percent ?? 0);
		const ctxButton = h(
			"button",
			{ class: "c-sb-ctx", title: "Context — compact / auto-compaction" },
			this.progress.el,
			h("span", { class: "c-sb-ctx-label mono" }, contextLabel(parts.context)),
		);
		ctxButton.addEventListener("click", (event) => {
			this.opts.onOpenContext(event.currentTarget as HTMLElement);
		});
		center.replaceChildren(ctxButton);
		const modelChip = chipEl(parts.modelText, {
			mono: true,
			tone: "accent",
			title: "Switch model / thinking level",
		});
		modelChip.addEventListener("click", () => {
			this.opts.onOpenModels(modelChip);
		});
		const statusChips = parts.statuses.map((s) =>
			chipEl(s.text, { tone: s.tone === "info" ? "blue" : s.tone, mono: false, title: `extension: ${s.key}` }),
		);
		right.replaceChildren(h("span", { class: "c-sb-totals mono" }, parts.rightText), ...statusChips, modelChip);
	}
}
