/**
 * Extension status strings enter raw (TUI heritage, ANSI SGR included).
 * The console never renders escape codes: sanitize to plain label + tone.
 */
import { stripAnsi } from "./ansi.ts";

export type StatusTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

const TONE_RULES: Array<{ tone: StatusTone; test: RegExp }> = [
	{ tone: "danger", test: /✗|failed|failure|error/i },
	{ tone: "warn", test: /⚠|warn|deprecat|expiring?|rate.?limit/i },
	{ tone: "ok", test: /✓|ok$|healthy|complete/i },
	{ tone: "accent", test: /●|running|in progress/i },
	{ tone: "info", test: /mcp|hooks|servers? enabled|enabled:/i },
];

export interface SanitizedStatus {
	text: string;
	tone: StatusTone;
}

export function sanitizeStatusText(input: string): SanitizedStatus {
	// stripAnsi removes CSI/OSC sequences; also drop C0 control chars (BEL, etc.)
	const text = stripAnsi(input ?? "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
		.trim();
	let tone: StatusTone = "neutral";
	for (const rule of TONE_RULES) {
		if (rule.test.test(text)) {
			tone = rule.tone;
			break;
		}
	}
	return { text, tone };
}
