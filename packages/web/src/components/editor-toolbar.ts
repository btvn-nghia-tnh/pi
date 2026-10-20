/**
 * Editor toolbar (spec §3.2.4): model/thinking popovers, queue add, Send↔Stop.
 * The toolbar is presentational + request-wiring; app.ts supplies behavior hooks.
 */
import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import type { Store } from "../state.ts";
import { chipEl, iconEl, openAnchoredMenu } from "./kit.ts";
import { modelShortName } from "./session-panel.ts";

export interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	authenticated?: boolean;
}

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
	const q = query.trim().toLowerCase();
	if (!q) return models;
	return models.filter((m) => [m.provider, m.id, m.name ?? ""].join(" ").toLowerCase().includes(q));
}

export interface PrimaryState {
	isStreaming: boolean;
	isCompacting: boolean;
	retryActive: boolean;
	streaming: boolean;
}

export function primaryButtonState(s: PrimaryState): {
	label: string;
	kind: "send" | "stop";
	tone: "primary" | "danger";
} {
	if (s.isStreaming || s.isCompacting || s.retryActive || s.streaming) {
		return { label: "Stop", kind: "stop", tone: "danger" };
	}
	return { label: "Send", kind: "send", tone: "primary" };
}

export interface EditorToolbarOpts {
	connection: PiConnection;
	store: Store;
	onPrimaryAction: (kind: "send" | "stop") => void;
	/** Visible while a turn runs; queues the editor prompt (steer/follow-up). */
	onQueuePrompt?: () => void;
}

export class EditorToolbar {
	readonly element: HTMLElement;
	private readonly opts: EditorToolbarOpts;
	private unsubscribe: (() => void) | undefined;
	/** Latest rendered thinking chip — anchor for /thinking and status-bar popovers. */
	private thinkChipEl: HTMLElement | undefined;

	constructor(opts: EditorToolbarOpts) {
		this.opts = opts;
		this.element = h("div", { class: "c-editor-toolbar" });
	}

	mount(): void {
		this.unsubscribe = this.opts.store.subscribe(() => this.render());
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private render(): void {
		const state = this.opts.store.getState();
		const session = state.sessionState;
		const model = session?.model;
		const modelName = modelShortName(model);
		const think = session?.thinkingLevel ?? "think";
		const busy = Boolean(session?.isStreaming || state.compaction || state.retry);

		clearElement(this.element);
		const modelChip = chipEl(`${modelName} ▾`, {
			mono: true,
			onClick: () => this.openModelPicker(modelChip),
			title: "Switch model (⌘K)",
		});
		const thinkChip = chipEl(`${think} ▾`, {
			onClick: () => this.openThinkingPicker(thinkChip),
			title: "Switch thinking level",
		});
		this.thinkChipEl = thinkChip;
		this.element.append(modelChip, thinkChip);
		if (busy && this.opts.onQueuePrompt) {
			this.element.append(
				h(
					"button",
					{
						class: "c-btn c-btn--green",
						onclick: this.opts.onQueuePrompt,
						title: "Queue this prompt — steering/follow-up",
					},
					"+ queue",
				),
			);
		}
		const primary = primaryButtonState({
			isStreaming: session?.isStreaming ?? false,
			isCompacting: session?.isCompacting ?? false,
			retryActive: state.retry !== undefined,
			streaming: busy,
		});
		const button = h(
			"button",
			{
				class: `c-editor-primary ${primary.tone === "danger" ? "is-stop" : ""}`,
				onclick: () => this.opts.onPrimaryAction(primary.kind),
			},
			primary.kind === "stop" ? iconEl("stop") : iconEl("send"),
			h("span", {}, primary.label),
		);
		this.element.appendChild(button);
	}

	public openModelPicker(anchor: HTMLElement): void {
		void this.opts.connection
			.request<{ models: ModelInfo[] }>({ type: "get_available_models" })
			.then((data) => {
				openAnchoredMenu(anchor, (close) => {
					const input = h("input", {
						class: "c-popover-search",
						placeholder: "filter models…",
					}) as HTMLInputElement;
					const list = h("div", { class: "c-popover-list" });
					const render = (query: string): void => {
						clearElement(list);
						for (const m of filterModels(data.models ?? [], query)) {
							const row = h(
								"button",
								{
									class: "c-popover-row",
									onclick: () => {
										void this.opts.connection
											.request({ type: "set_model", provider: m.provider, modelId: m.id })
											.then((updated) => {
												this.opts.store.setModel(updated as never);
												close();
											})
											.catch(() => {});
									},
								},
								h("span", { class: "c-popover-main" }, `${m.provider}/${m.id}`),
								h(
									"span",
									{ class: "c-popover-meta" },
									m.authenticated === false ? "auth needed" : (m.name ?? ""),
								),
							);
							list.appendChild(row);
						}
					};
					input.addEventListener("input", () => render(input.value));
					render("");
					return h("div", {}, input, list);
				});
			})
			.catch(() => {});
	}

	/** R8/R15: /thinking no-args opens the picker anchored at the toolbar's thinking chip. */
	revealThinkingPicker(): void {
		if (this.thinkChipEl) this.openThinkingPicker(this.thinkChipEl);
	}

	private openThinkingPicker(anchor: HTMLElement): void {
		void this.opts.connection
			.request<{ levels: string[] }>({ type: "get_available_thinking_levels" })
			.then((data) => {
				openAnchoredMenu(anchor, (close) => {
					const list = h("div", { class: "c-popover-list" });
					const current = this.opts.store.getState().sessionState?.thinkingLevel;
					for (const level of data.levels ?? []) {
						list.appendChild(
							h(
								"button",
								{
									class: `c-popover-row${level === current ? " is-active" : ""}`,
									onclick: () => {
										void this.opts.connection
											.request({ type: "set_thinking_level", level: level as never })
											.then(() => {
												this.opts.store.setThinkingLevel(level as never);
												close();
											})
											.catch(() => {});
									},
								},
								level,
							),
						);
					}
					return list;
				});
			})
			.catch(() => {});
	}
}
