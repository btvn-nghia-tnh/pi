/** Pure text projections for usage surfaces (spec §4). */
import { formatTokens } from "./footer-format.ts";

export function formatCost(cost: number): string {
	const clamped = Number.isFinite(cost) ? Math.max(0, cost) : 0;
	if (clamped > 0 && clamped < 1) return `$${clamped.toFixed(3)}`;
	return `$${clamped.toFixed(2)}`;
}

export function contextLabel(ctx: { percent: number | null; window: number; auto: boolean }): string {
	const windowText = formatTokens(ctx.window);
	if (ctx.percent === null) return `? of ${windowText} (${ctx.auto ? "auto" : "manual"})`;
	const pct = ctx.percent >= 10 ? Math.round(ctx.percent) : ctx.percent.toFixed(1);
	return `${pct}% of ${windowText} (${ctx.auto ? "auto" : "manual"})`;
}

export function usageLine(
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } },
	opts: { withCost?: boolean } = {},
): string {
	const parts: string[] = [];
	const flow: string[] = [];
	if (usage.input) flow.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) flow.push(`↓${formatTokens(usage.output)}`);
	if (flow.length > 0) parts.push(flow.join(" "));
	if (usage.cacheRead) parts.push(`R ${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W ${formatTokens(usage.cacheWrite)}`);
	if (opts.withCost !== false) parts.push(formatCost(usage.cost.total));
	return parts.join(" · ");
}

export function cacheHitPct(usage: { input: number; cacheRead: number; cacheWrite: number }): number | null {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	if (prompt <= 0) return null;
	return Math.round((usage.cacheRead / prompt) * 100);
}

export function totalsLine(totals: { input: number; output: number; cost: number }, hitPct: number | null): string {
	const hit = hitPct === null ? "" : ` · R ${hitPct}%`;
	return `${formatCost(totals.cost)} · ↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}${hit}`;
}
