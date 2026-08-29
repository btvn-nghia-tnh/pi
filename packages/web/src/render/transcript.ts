/**
 * Transcript list controller: renders store items, keeps scroll behavior.
 */

import { h } from "../dom.ts";
import type { Store, TranscriptItem } from "../state.ts";
import {
	renderAssistantMessage,
	renderBashExecution,
	renderCustomMessage,
	renderNotice,
	renderSummary,
	renderUserMessage,
} from "./messages.ts";
import { renderToolCard } from "./tools.ts";

export interface TranscriptOptions {
	store: Store;
	showImages: boolean;
}

export class TranscriptView {
	readonly element: HTMLElement;
	private readonly store: Store;
	private readonly options: TranscriptOptions;
	private readonly rendered = new Map<string, HTMLElement>();
	private userScrolledUp = false;
	private unsubscribe: (() => void) | undefined;
	private version = 0;

	constructor(options: TranscriptOptions) {
		this.options = options;
		this.store = options.store;
		this.element = h("div", { class: "transcript" });
		this.element.addEventListener("toggle-tool", () => {
			this.render();
		});
	}

	mount(wrap: HTMLElement): void {
		wrap.addEventListener("scroll", () => {
			const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
			this.userScrolledUp = !atBottom;
		});
		this.unsubscribe = this.store.subscribe(() => {
			this.render();
		});
		this.render();
	}

	unmount(): void {
		this.unsubscribe?.();
	}

	private itemKey(item: TranscriptItem): string {
		return item.id;
	}

	private itemVersion(item: TranscriptItem): string {
		// Re-render an item when its message, streaming state, tool cards, or
		// global toggles change.
		const toolState = [...item.toolCards.values()]
			.map((card) => `${card.toolCallId}:${card.result ? "done" : "live"}:${card.expanded ? "e" : "c"}`)
			.join(",");
		const state = this.store.getState();
		return `${item.streaming ? "s" : "n"}:${state.thinkingVisible ? "t" : "h"}:${toolState}`;
	}

	render(): void {
		this.version++;
		const state = this.store.getState();

		for (const item of state.items) {
			const key = this.itemKey(item);
			const version = this.itemVersion(item);
			const existing = this.rendered.get(key);
			if (existing?.dataset.version === version) continue;

			const element = this.renderItem(item);
			element.dataset.version = version;
			if (existing) {
				existing.replaceWith(element);
			} else {
				this.element.appendChild(element);
			}
			this.rendered.set(key, element);
		}

		// Drop rendered nodes for items that no longer exist (session switch).
		const liveIds = new Set(state.items.map((item) => this.itemKey(item)));
		for (const [key, element] of this.rendered) {
			if (!liveIds.has(key)) {
				element.remove();
				this.rendered.delete(key);
			}
		}

		if (!this.userScrolledUp) {
			this.scrollToBottom();
		}
	}

	reset(): void {
		this.rendered.clear();
		while (this.element.firstChild) {
			this.element.removeChild(this.element.firstChild);
		}
	}

	scrollToBottom(): void {
		const wrap = this.element.parentElement;
		if (wrap) {
			wrap.scrollTop = wrap.scrollHeight;
		}
	}

	private renderItem(item: TranscriptItem): HTMLElement {
		const state = this.store.getState();
		const container = h("div", { class: `transcript-item item-${item.kind}` });
		container.dataset.itemId = item.id;

		switch (item.kind) {
			case "user":
				container.appendChild(renderUserMessage(item));
				break;
			case "assistant": {
				container.appendChild(
					renderAssistantMessage(item, {
						thinkingLevel: state.sessionState?.thinkingLevel ?? "off",
						thinkingVisible: state.thinkingVisible,
						hideThinkingBlock: state.hideThinkingBlock,
					}),
				);
				// Tool cards render inline after the assistant message, in
				// tool call order.
				const message = item.message as { content?: Array<{ type: string; id?: string }> } | undefined;
				const orderedIds: string[] = [];
				for (const block of message?.content ?? []) {
					if (block?.type === "toolCall" && block.id) orderedIds.push(block.id);
				}
				for (const id of orderedIds) {
					const card = item.toolCards.get(id);
					if (card) container.appendChild(renderToolCard(card, { showImages: this.options.showImages }));
				}
				break;
			}
			case "bashExecution":
				container.appendChild(renderBashExecution(item));
				break;
			case "custom":
				container.appendChild(renderCustomMessage(item));
				break;
			case "compaction":
				container.appendChild(renderSummary(item, "Compaction summary"));
				break;
			case "branchSummary":
				container.appendChild(renderSummary(item, "Branch summary"));
				break;
			default:
				container.appendChild(renderNotice(item));
				break;
		}
		return container;
	}
}
