/**
 * Footer formatting, ported from the coding-agent FooterComponent.
 */

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) {
		return `~/${cwd.slice(home.length + 1)}`;
	}
	return cwd;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface FooterStatsInput {
	totals: UsageTotals;
	latestCacheHitRate?: number;
	contextUsage: ContextUsage | null;
	autoCompactionEnabled: boolean;
	usingSubscription: boolean;
}

export interface FooterStatsResult {
	statsLeft: string;
	contextPercent: number | null;
	contextClass: "ok" | "warning" | "error";
}

/** Build the left-hand footer stats string: ↑ ↓ R W CH% $cost context% */
export function buildFooterStats(input: FooterStatsInput): FooterStatsResult {
	const { totals } = input;
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && input.latestCacheHitRate !== undefined) {
		parts.push(`CH${input.latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost || input.usingSubscription) {
		parts.push(`$${totals.cost.toFixed(3)}${input.usingSubscription ? " (sub)" : ""}`);
	}

	const contextWindow = input.contextUsage?.contextWindow ?? 0;
	const autoIndicator = input.autoCompactionEnabled ? " (auto)" : "";
	if (input.contextUsage && input.contextUsage.percent !== null) {
		parts.push(`${input.contextUsage.percent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`);
	} else {
		parts.push(`?/${formatTokens(contextWindow)}${autoIndicator}`);
	}

	const contextPercent = input.contextUsage?.percent ?? 0;
	const contextClass = contextPercent > 90 ? "error" : contextPercent > 70 ? "warning" : "ok";

	return {
		statsLeft: parts.join(" "),
		contextPercent: input.contextUsage?.percent ?? null,
		contextClass,
	};
}

/** Cache hit rate of the latest assistant usage, mirroring FooterComponent. */
export function computeCacheHitRate(usage: UsageTotals): number | undefined {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return (usage.cacheRead / promptTokens) * 100;
}
