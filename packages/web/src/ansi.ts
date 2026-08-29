/**
 * ANSI SGR to HTML conversion for tool output, ported from the coding-agent
 * export-html ansi-to-html module. Only covers SGR styling; control
 * sequences are stripped.
 */

interface AnsiSpan {
	class: string;
	inverse?: boolean;
}

const ANSI_PATTERN = /\x1b\[([0-9;]*)m/g;

/** Map an SGR parameter string to color classes. */
function parseAnsiParams(params: string): AnsiSpan | undefined {
	if (params === "" || params === "0") return undefined;
	const parts = params.split(";").map((part) => (part === "" ? "0" : part));
	const span: AnsiSpan = { class: "" };
	const colorNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
	const brightColorNames = colorNames.map((name) => `bright-${name}`);

	for (let i = 0; i < parts.length; i++) {
		const code = Number.parseInt(parts[i]!, 10);
		if (Number.isNaN(code)) continue;
		if (code >= 30 && code <= 37) {
			span.class += ` ansi-fg-${colorNames[code - 30]}`;
		} else if (code === 39) {
			span.class = span.class.replace(/ ansi-fg-\S+/g, "");
		} else if (code >= 90 && code <= 97) {
			span.class += ` ansi-fg-${brightColorNames[code - 90]}`;
		} else if (code >= 40 && code <= 47) {
			span.class += ` ansi-bg-${colorNames[code - 40]}`;
		} else if (code === 49) {
			span.class = span.class.replace(/ ansi-bg-\S+/g, "");
		} else if (code >= 100 && code <= 107) {
			span.class += ` ansi-bg-${brightColorNames[code - 100]}`;
		} else if (code === 1) {
			span.class += " ansi-bold";
		} else if (code === 2) {
			span.class += " ansi-dim";
		} else if (code === 3) {
			span.class += " ansi-italic";
		} else if (code === 4) {
			span.class += " ansi-underline";
		} else if (code === 7) {
			span.inverse = true;
		}
	}
	return span.class || span.inverse ? span : undefined;
}

function escapeHtmlText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Convert ANSI-styled text to HTML with span-based classes. */
export function ansiToHtml(text: string): string {
	const stack: AnsiSpan[] = [];
	let html = "";
	let lastIndex = 0;

	for (const match of text.matchAll(ANSI_PATTERN)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			html += escapeHtmlText(text.slice(lastIndex, index));
		}
		const params = match[1] ?? "";
		if (params === "" || params === "0") {
			// Reset: close all open spans
			for (let i = 0; i < stack.length; i++) html += "</span>";
			stack.length = 0;
		} else {
			const span = parseAnsiParams(params);
			if (span) {
				stack.push(span);
				html += `<span class="${span.class.trim()}${span.inverse ? " ansi-inverse" : ""}">`;
			}
		}
		lastIndex = index + match[0].length;
	}
	if (lastIndex < text.length) {
		html += escapeHtmlText(text.slice(lastIndex));
	}
	for (let i = 0; i < stack.length; i++) html += "</span>";
	return html;
}

/** Strip ANSI escape sequences entirely. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
