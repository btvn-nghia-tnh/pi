/** Status projection for tool cards (spec §3.2.2): spec §5 stop rules. */
import type { ToolCardState } from "../state.ts";

export interface ToolStatusDescriptor {
	label: string;
	tone: "ok" | "warn" | "danger" | "muted";
	running: boolean;
	canStop: boolean;
}

export function toolStatusDescriptor(card: ToolCardState, now: number): ToolStatusDescriptor {
	const started = card.startedAt ?? now;
	if (card.running) {
		const seconds = Math.max(0, Math.round((now - started) / 1000));
		return {
			label: `running ${seconds}s`,
			tone: "warn",
			running: true,
			canStop: card.toolName === "bash",
		};
	}
	const seconds = card.endedAt ? Math.max(0, Math.round((card.endedAt - started) / 1000)) : 0;
	if (card.isError) return { label: "✗ failed", tone: "danger", running: false, canStop: false };
	if (seconds > 0) return { label: `✓ ${seconds}s`, tone: "ok", running: false, canStop: false };
	return { label: "✓", tone: "muted", running: false, canStop: false };
}
