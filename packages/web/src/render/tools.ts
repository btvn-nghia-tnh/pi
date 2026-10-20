/**
 * Tool card rendering with per-tool summaries and output renderers,
 * mirroring the TUI ToolExecutionComponent behavior.
 */

import { ansiToHtml, stripAnsi } from "../ansi.ts";
import { iconEl, pillEl } from "../components/kit.ts";
import { toolStatusDescriptor } from "../components/tool-status.ts";
import { renderEditDiff } from "../diff.ts";
import { h } from "../dom.ts";
import type { ToolCardState } from "../state.ts";

interface ToolOutputBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

interface ToolResultShape {
	content?: ToolOutputBlock[];
	details?: {
		truncation?: string | null;
		fullOutputPath?: string | null;
		diff?: string;
		patch?: string;
		oldString?: string;
		newString?: string;
		originalText?: string;
		replaceText?: string;
	};
}

interface EditArgsShape {
	path?: string;
	filepath?: string;
	old_string?: string;
	new_string?: string;
	originalText?: string;
	replaceText?: string;
	diff?: string;
}

function firstOutputText(result: unknown): string {
	const shape = result as ToolResultShape | undefined;
	const blocks = shape?.content;
	if (!Array.isArray(blocks)) return "";
	for (const block of blocks) {
		if (block?.type === "text" && block.text) return block.text;
	}
	return "";
}

type SummarySegment = { text: string } | { path: string };

function toolSummarySegments(card: ToolCardState): SummarySegment[] {
	const args = (card.args ?? {}) as Record<string, unknown>;
	const resultText = firstOutputText(card.result ?? card.partialResult);
	const resultLines = resultText.trim() ? resultText.trim().split("\n").length : 0;
	const argPath = (name: string): string => (typeof args[name] === "string" ? (args[name] as string) : "");

	switch (card.toolName) {
		case "read": {
			const offset = args.offset !== undefined ? `+${String(args.offset)}` : "";
			const limit = args.limit !== undefined ? `:${String(args.limit)}` : "";
			return [{ path: argPath("path") }, { text: `${offset}${limit}` }];
		}
		case "write": {
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? content.split("\n").length : 0;
			return [{ path: argPath("path") }, { text: ` (${lines} lines)` }];
		}
		case "edit": {
			return [{ path: argPath("path") || argPath("filepath") }, { text: " (edit)" }];
		}
		case "ls": {
			return [{ path: argPath("path") }, { text: ` (${resultLines} entries)` }];
		}
		default: {
			const summary = toolSummary(card);
			return summary ? [{ text: summary }] : [];
		}
	}
}

/** One-line summary shown in the collapsed header, per tool. */
export function toolSummary(card: ToolCardState): string {
	const args = (card.args ?? {}) as Record<string, unknown>;
	const resultText = firstOutputText(card.result ?? card.partialResult);
	const resultLines = resultText.trim() ? resultText.trim().split("\n").length : 0;

	switch (card.toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "";
			if (!command) return "";
			const exit = (card.result as { exitCode?: number } | undefined)?.exitCode;
			return exit === undefined ? command : `${command}${exit !== 0 ? ` (exit ${exit})` : ""}`;
		}
		case "read": {
			const path = typeof args.path === "string" ? args.path : "";
			const offset = args.offset !== undefined ? `+${String(args.offset)}` : "";
			const limit = args.limit !== undefined ? `:${String(args.limit)}` : "";
			return `${path}${offset}${limit}`;
		}
		case "write": {
			const path = typeof args.path === "string" ? args.path : "";
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? content.split("\n").length : 0;
			return `${path} (${lines} lines)`;
		}
		case "edit": {
			const path = typeof args.path === "string" ? args.path : "";
			return `${path} (edit)`;
		}
		case "ls": {
			const path = typeof args.path === "string" ? args.path : "";
			return `${path} (${resultLines} entries)`;
		}
		case "find":
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			return pattern ? `${pattern} (${resultLines} matches)` : `${resultLines} matches`;
		}
		default:
			return resultText.trim().split("\n")[0]?.slice(0, 100) ?? "";
	}
}

function renderEditArgs(card: ToolCardState): HTMLElement | undefined {
	const args = (card.args ?? {}) as EditArgsShape;
	const result = (card.result ?? card.partialResult) as ToolResultShape | undefined;
	// The edit tool returns the diff in details.diff (content text is just a
	// success summary); older hosts may put diff-formatted text in content.
	const diffText = result?.details?.diff ?? firstOutputText(card.result ?? card.partialResult);
	const path = args.path ?? args.filepath ?? "";
	const header = h("div", { class: "tool-args" }, path);
	const wrapper = h("div", {});
	wrapper.appendChild(header);

	const parsed = diffText.split("\n").some((line) => /^([+-\s])\s*\d*\s/.test(line));
	if (parsed) {
		wrapper.appendChild(renderEditDiff(diffText));
	} else if (result?.details?.oldString !== undefined || args.old_string) {
		const oldText = String(result?.details?.oldString ?? args.old_string ?? "");
		const newText = String(result?.details?.newString ?? args.new_string ?? "");
		const removed = h("div", { class: "d-line d-remove" }, h("code", {}, oldText));
		const added = h("div", { class: "d-line d-add" }, h("code", {}, newText));
		const diff = h("div", { class: "diff" }, removed, added);
		wrapper.appendChild(diff);
	}
	return wrapper;
}

function renderGenericArgs(card: ToolCardState): HTMLElement {
	const wrapper = h("div", { class: "tool-args" });
	const pre = h("pre", {});
	try {
		pre.textContent = JSON.stringify(card.args, null, 2);
	} catch {
		pre.textContent = String(card.args);
	}
	wrapper.appendChild(pre);
	return wrapper;
}

function renderResultOutput(card: ToolCardState): HTMLElement {
	const result = (card.result ?? card.partialResult) as ToolResultShape | undefined;
	const container = h("div", { class: "tool-output" });
	const blocks = result?.content;

	const text = firstOutputText(card.result ?? card.partialResult);
	if (text) {
		const rendered = h("pre", {});
		if (card.toolName === "bash" || card.toolName === "grep") {
			rendered.innerHTML = ansiToHtml(text);
		} else {
			rendered.textContent = text;
		}
		container.appendChild(rendered);
	}

	if (Array.isArray(blocks)) {
		for (const block of blocks) {
			if (block?.type === "image" && block.data) {
				container.appendChild(
					h("img", {
						src: `data:${block.mimeType ?? "image/png"};base64,${block.data}`,
						alt: "tool output image",
					}),
				);
			}
		}
	}

	if (result?.details?.fullOutputPath) {
		const fullPath = String(result.details.fullOutputPath);
		container.appendChild(
			h(
				"div",
				{ class: "full-output-hint" },
				"Full output: ",
				h("span", { class: "file-ref", "data-path": fullPath }, fullPath),
			),
		);
	}
	return container;
}

/** Options for {@link renderToolCard}. */
export interface RenderToolCardOptions {
	showImages: boolean;
	/** Sends `{ type: "abort_bash" }` (session-scoped, no payload). Rendered only while a bash card runs; wired in app.ts. */
	onStopBash?: () => void;
}

/** Map the descriptor tone onto a pillEl tone (pillEl has no "muted"). */
function pillTone(tone: "ok" | "warn" | "danger" | "muted"): "ok" | "warn" | "danger" | "neutral" {
	if (tone === "muted") return "neutral";
	return tone;
}

/** Render a complete tool card. */
export function renderToolCard(card: ToolCardState, options: RenderToolCardOptions): HTMLElement {
	const element = h("div", { class: `tool-card${card.isError ? " is-error" : card.result ? " is-done" : ""}` });
	element.dataset.toolCallId = card.toolCallId;

	const headerChildren: HTMLElement[] = [h("span", { class: "tool-name" }, card.toolName)];
	for (const segment of toolSummarySegments(card)) {
		if ("path" in segment) {
			if (segment.path) {
				headerChildren.push(h("span", { class: "tool-summary file-ref", "data-path": segment.path }, segment.path));
			}
		} else {
			headerChildren.push(h("span", { class: "tool-summary" }, segment.text));
		}
	}
	headerChildren.push(...toolStatusHeaderParts(card, options, element));
	headerChildren.push(h("span", { class: "tool-hint" }, card.expanded ? "▾" : "▸"));
	const header = h("div", { class: "tool-header" }, ...headerChildren);
	header.addEventListener("click", (event) => {
		// File-ref clicks open the preview; they must not toggle the card.
		if ((event.target as HTMLElement).closest(".file-ref")) return;
		card.expanded = !card.expanded;
		element.dispatchEvent(new CustomEvent("toggle-tool", { bubbles: true, detail: card.toolCallId }));
	});
	element.appendChild(header);

	if (card.expanded) {
		const body = h("div", { class: "tool-body" });
		if (card.toolName === "edit") {
			const rendered = renderEditArgs(card);
			if (rendered) body.appendChild(rendered);
		} else if (
			card.toolName === "bash" ||
			card.toolName === "read" ||
			card.toolName === "write" ||
			card.toolName === "ls" ||
			card.toolName === "find" ||
			card.toolName === "grep"
		) {
			const args = h("div", { class: "tool-args" });
			const pre = h("pre", {});
			try {
				pre.textContent = JSON.stringify(card.args, null, 2);
			} catch {
				pre.textContent = String(card.args);
			}
			args.appendChild(pre);
			body.appendChild(args);
		} else {
			body.appendChild(renderGenericArgs(card));
		}
		body.appendChild(renderResultOutput(card));
		element.appendChild(body);
	}

	return element;
}

/**
 * Status pill (left: state, right side of header) + per-bash stop chip + a
 * 1s DOM-only tick that keeps "running Ns" current between store renders.
 * The tick self-cleans when the element detaches (renderToolCard elements are
 * rebuilt each store render) and stops itself once the card stops running.
 */
function toolStatusHeaderParts(
	card: ToolCardState,
	options: RenderToolCardOptions,
	element: HTMLElement,
): HTMLElement[] {
	const status = toolStatusDescriptor(card, Date.now());
	const pill = pillEl(status.label, pillTone(status.tone));
	if (status.running) {
		const label = pill.lastChild;
		if (label) {
			const timer = setInterval(() => {
				if (!document.contains(element)) {
					clearInterval(timer);
					return;
				}
				const next = toolStatusDescriptor(card, Date.now());
				label.textContent = next.label;
				if (!next.running) clearInterval(timer);
			}, 1000);
		}
	}
	const extra: HTMLElement[] = [pill];
	if (status.canStop && options.onStopBash) {
		extra.push(
			h(
				"button",
				{
					class: "c-tool-stop",
					title: "Stop this bash process",
					onclick: (event) => {
						event.stopPropagation();
						options.onStopBash?.();
					},
				},
				iconEl("stop"),
				"stop",
			),
		);
	}
	return extra;
}

/** Plain text extraction for copy features. */
export function toolCardPlainText(card: ToolCardState): string {
	return stripAnsi(firstOutputText(card.result ?? card.partialResult));
}
