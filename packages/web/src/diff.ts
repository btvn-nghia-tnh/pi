/**
 * Edit diff rendering, ported from the coding-agent TUI diff component:
 * `+123 content` / `-123 content` / ` 123 content` lines with word-level
 * intra-line highlighting via the `diff` package.
 */

import { diffWords } from "diff";
import { h } from "./dom.ts";

interface ParsedDiffLine {
	prefix: string;
	lineNum: string;
	content: string;
}

export function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1]!, lineNum: match[2]!, content: match[3]! };
}

function escapeHtmlText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Compute word-level intra-line diff and return highlighted HTML rows,
 * matching the TUI's renderIntraLineDiff behavior (leading whitespace of the
 * first changed part stays unhighlighted).
 */
export function intraLineDiffHtml(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				removedLine += escapeHtmlText(leadingWs);
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += `<span class="d-word-removed">${escapeHtmlText(value)}</span>`;
			}
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				addedLine += escapeHtmlText(leadingWs);
				isFirstAdded = false;
			}
			if (value) {
				addedLine += `<span class="d-word-added">${escapeHtmlText(value)}</span>`;
			}
		} else {
			const escaped = escapeHtmlText(part.value);
			removedLine += escaped;
			addedLine += escaped;
		}
	}

	return { removedLine, addedLine };
}

/**
 * Render an edit diff (the text the `edit` tool produces) as an HTML table.
 * Adjacent -/+ line pairs get word-level highlight.
 */
export function renderEditDiff(diffText: string): HTMLElement {
	const container = h("div", { class: "diff" });
	const lines = diffText.split("\n");
	let index = 0;

	while (index < lines.length) {
		const line = lines[index]!;
		const parsed = parseDiffLine(line);
		if (parsed && parsed.prefix === "-" && index + 1 < lines.length) {
			const next = parseDiffLine(lines[index + 1]!);
			if (next && next.prefix === "+") {
				const { removedLine, addedLine } = intraLineDiffHtml(parsed.content, next.content);
				container.appendChild(
					h(
						"div",
						{ class: "d-line d-remove" },
						h("span", { class: "d-num" }, parsed.lineNum.trim()),
						h("code", {}),
					),
				);
				const removedRow = container.lastElementChild!.querySelector("code")!;
				removedRow.innerHTML = removedLine;
				container.appendChild(
					h("div", { class: "d-line d-add" }, h("span", { class: "d-num" }, next.lineNum.trim()), h("code", {})),
				);
				const addedRow = container.lastElementChild!.querySelector("code")!;
				addedRow.innerHTML = addedLine;
				index += 2;
				continue;
			}
		}

		if (!parsed) {
			if (line.trim()) {
				container.appendChild(h("div", { class: "d-line d-hunk" }, h("code", {}, line)));
			}
		} else if (parsed.prefix === "-") {
			container.appendChild(
				h(
					"div",
					{ class: "d-line d-remove" },
					h("span", { class: "d-num" }, parsed.lineNum.trim()),
					h("code", {}, parsed.content),
				),
			);
		} else if (parsed.prefix === "+") {
			container.appendChild(
				h(
					"div",
					{ class: "d-line d-add" },
					h("span", { class: "d-num" }, parsed.lineNum.trim()),
					h("code", {}, parsed.content),
				),
			);
		} else {
			container.appendChild(
				h(
					"div",
					{ class: "d-line d-context" },
					h("span", { class: "d-num" }, parsed.lineNum.trim()),
					h("code", {}, parsed.content),
				),
			);
		}
		index++;
	}

	return container;
}
