/**
 * Message renderers: user, assistant (markdown + thinking blocks), custom.
 */

import { h } from "../dom.ts";
import { renderMarkdown } from "../markdown.ts";
import type { TranscriptItem } from "../state.ts";
import type { AgentMessage } from "../types.ts";

interface ImageBlock {
	type: string;
	data?: string;
	mimeType?: string;
	text?: string;
}

function renderContentBlocks(content: unknown, className: string): HTMLElement[] {
	const blocks: HTMLElement[] = [];
	if (typeof content === "string") {
		blocks.push(h("div", { class: className }, content));
		return blocks;
	}
	if (!Array.isArray(content)) return blocks;
	for (const block of content as ImageBlock[]) {
		if (block?.type === "text" && block.text) {
			blocks.push(h("div", { class: className }, block.text));
		} else if (block?.type === "image" && block.data) {
			blocks.push(
				h("img", { src: `data:${block.mimeType ?? "image/png"};base64,${block.data}`, alt: "attachment" }),
			);
		}
	}
	return blocks;
}

export function renderUserMessage(item: TranscriptItem): HTMLElement {
	const message = item.message as { content?: unknown; timestamp?: number } | undefined;
	const container = h("div", { class: "message-user" });
	const body = h("div", {});
	if (message && typeof message.content === "string") {
		body.appendChild(h("div", {}, message.content));
	} else if (Array.isArray(message?.content)) {
		for (const element of renderContentBlocks(message.content, "user-text")) {
			body.appendChild(element);
		}
	}
	container.appendChild(body);
	const attachments = h("div", { class: "attachments" });
	if (Array.isArray(message?.content)) {
		for (const block of message.content as ImageBlock[]) {
			if (block?.type === "image" && block.data) {
				attachments.appendChild(
					h("img", { src: `data:${block.mimeType ?? "image/png"};base64,${block.data}`, alt: "attachment" }),
				);
			}
		}
	}
	if (attachments.firstChild) container.appendChild(attachments);
	return container;
}

const THINKING_LEVEL_LABEL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function renderAssistantMessage(
	item: TranscriptItem,
	options: { thinkingLevel: string; thinkingVisible: boolean; hideThinkingBlock: boolean },
): HTMLElement {
	const message = item.message as
		| {
				content?: Array<{ type: string; text?: string; thinking?: string }>;
				usage?: { output?: number };
		  }
		| undefined;
	const container = h("div", { class: "message-assistant" });
	if (!message?.content) return container;

	const body = h("div", { class: `md-body${item.streaming ? " stream-cursor" : ""}` });
	let textBuffer = "";
	const flushText = () => {
		if (textBuffer.trim()) {
			const rendered = h("div", {});
			rendered.innerHTML = renderMarkdown(textBuffer.trim());
			body.appendChild(rendered);
		}
		textBuffer = "";
	};

	for (const block of message.content) {
		if (block.type === "text" && block.text) {
			textBuffer += block.text;
		} else if (block.type === "thinking" && block.thinking) {
			flushText();
			if (options.hideThinkingBlock || !options.thinkingVisible) {
				body.appendChild(
					h(
						"details",
						{ class: `thinking-block thinking-${options.thinkingLevel}` },
						h("summary", {}, "Thinking..."),
						h("div", { class: "thinking-body" }, block.thinking),
					),
				);
			} else {
				body.appendChild(
					h(
						"details",
						{ class: `thinking-block thinking-${options.thinkingLevel}`, open: "" },
						h("summary", {}, `Thinking (${options.thinkingLevel})`),
						h("div", { class: "thinking-body" }, block.thinking),
					),
				);
			}
		}
	}
	flushText();
	container.appendChild(body);
	return container;
}

export function renderCustomMessage(item: TranscriptItem): HTMLElement {
	const message = item.message as { customType?: string; data?: unknown } | undefined;
	const container = h("div", { class: "custom-item" });
	container.appendChild(h("div", { class: "custom-label" }, `[${message?.customType ?? "custom"}]`));
	const body = h("pre", {});
	try {
		body.textContent = typeof message?.data === "string" ? message.data : JSON.stringify(message?.data, null, 2);
	} catch {
		body.textContent = String(message?.data ?? "");
	}
	container.appendChild(body);
	return container;
}

export function renderBashExecution(item: TranscriptItem): HTMLElement {
	const message = item.message as
		| { command?: string; output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }
		| undefined;
	const container = h("div", { class: "bash-execution" });
	if (message?.command) {
		container.appendChild(h("div", { class: "bash-command" }, `$ ${message.command}`));
	}
	const outputSource = message?.output ?? item.notice?.text ?? "";
	if (outputSource) {
		container.appendChild(h("div", { class: "bash-output" }, outputSource));
	}
	if (message && typeof message.exitCode === "number") {
		const badges: string[] = [];
		if (message.exitCode !== 0) badges.push(`exit ${message.exitCode}`);
		if (message.cancelled) badges.push("cancelled");
		if (message.truncated) badges.push("truncated");
		if (badges.length > 0) {
			container.appendChild(h("div", { class: "bash-badges" }, badges.join(" · ")));
		}
	}
	return container;
}

export function renderNotice(item: TranscriptItem): HTMLElement {
	const level = item.notice?.level ?? "info";
	return h("div", { class: `notice-item ${level}` }, item.notice?.text ?? "");
}

export function renderSummary(item: TranscriptItem, label: string): HTMLElement {
	const container = h("div", { class: "summary-item" });
	container.appendChild(h("div", { class: "summary-label" }, label));
	const body = h("div", { class: "md-body" });
	body.innerHTML = renderMarkdown(item.notice?.text ?? "");
	container.appendChild(body);
	return container;
}

/** Guess message kind for items without a message object. */
export function agentMessageKind(message: AgentMessage): TranscriptItem["kind"] {
	switch (message.role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "bashExecution":
			return "bashExecution";
		case "custom":
			return "custom";
		default:
			return "notice";
	}
}

export { THINKING_LEVEL_LABEL };
