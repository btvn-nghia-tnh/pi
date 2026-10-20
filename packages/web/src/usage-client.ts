/**
 * Usage page client projections (spec §3.5, §6.1): thin fetch wrapper + pure
 * projections of the get_usage_summary payload.
 *
 * Type mirrors below re-declare the backend contract by hand because the web
 * and coding-agent packages are not import-linked. The source of truth is
 * packages/coding-agent/src/modes/rpc/rpc-types.ts (RpcUsageSummary,
 * RpcUsageDayRow, RpcUsageModelRow, RpcUsageSessionRow) — reconcile drift
 * toward the backend.
 */

import type { PiConnection } from "./connection.ts";
import { formatTokens } from "./footer-format.ts";
import { formatCost } from "./usage-text.ts";

// ---------------------------------------------------------------------------
// Mirrored backend contract
// ---------------------------------------------------------------------------

/** Mirror of RpcUsageDayRow (UTC date key "YYYY-MM-DD"). */
export interface UsageDayRow {
	day: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Mirror of RpcUsageModelRow. */
export interface UsageModelRow {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Distinct session files that used this model in range. */
	sessions: number;
}

/** Mirror of RpcUsageSessionRow. */
export interface UsageSessionRow {
	/** Session file path on disk (the accounting identity, like list_sessions). */
	file: string;
	id: string;
	/** Latest session_info name; empty when unnamed. */
	name: string;
	cwd: string;
	/** Model of the session's most recent in-range usage record. */
	model: string;
	input: number;
	output: number;
	cost: number;
	/** ISO timestamp of the last in-range usage record. */
	modified: string;
}

/** Mirror of RpcUsageSummary (get_usage_summary response data). */
export interface UsageSummary {
	totals: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		/** Sessions contributing at least one in-range usage record. */
		sessions: number;
		/** Malformed lines/records encountered while scanning. */
		skipped: number;
	};
	/** Ascending by day. */
	perDay: UsageDayRow[];
	/** Descending by cost. */
	perModel: UsageModelRow[];
	/** Descending by modified. */
	sessions: UsageSessionRow[];
}

// ---------------------------------------------------------------------------
// Fetch wrapper
// ---------------------------------------------------------------------------

/** Request a usage summary. rangeDays: 0 = all time, otherwise 1/7/30. */
export function fetchUsageSummary(connection: PiConnection, rangeDays: number): Promise<UsageSummary> {
	return connection.request<UsageSummary>({ type: "get_usage_summary", rangeDays });
}

// ---------------------------------------------------------------------------
// Stat cards (Usage page header)
// ---------------------------------------------------------------------------

export interface UsageStatCards {
	/** "↑ tokens" card value: input + cache-read (mockup 05: "in + cache-read"). */
	tokensIn: string;
	/** "↓ tokens" card value: output. */
	tokensOut: string;
	/** Formatted cache-write tokens for the ↓ card sub-line. */
	cacheWrite: string;
	/** Cache hit percent from totals, rounded; null when the denominator is 0. */
	hitPct: number | null;
	cost: string;
	/** "+12%" / "-5%" vs the previous period; "—" when not computable. */
	costDelta: string;
	/** Session count as plain text. */
	sessions: string;
	skipped: number;
}

export function usageStatCards(s: UsageSummary, prev: UsageSummary | null): UsageStatCards {
	const totals = s.totals;
	const denom = totals.input + totals.cacheRead + totals.cacheWrite;
	let costDelta = "—";
	if (prev && prev.totals.cost > 0) {
		const pct = Math.round(((totals.cost - prev.totals.cost) / prev.totals.cost) * 100);
		costDelta = `${pct >= 0 ? "+" : ""}${pct}%`;
	}
	return {
		cost: formatCost(totals.cost),
		costDelta,
		sessions: String(totals.sessions),
		tokensIn: formatTokens(totals.input + totals.cacheRead),
		tokensOut: formatTokens(totals.output),
		cacheWrite: formatTokens(totals.cacheWrite),
		hitPct: denom > 0 ? Math.round((totals.cacheRead / denom) * 100) : null,
		skipped: totals.skipped,
	};
}

// ---------------------------------------------------------------------------
// Chart series (per-day stacked bars)
// ---------------------------------------------------------------------------

export interface StackedBarDay {
	day: string;
	/** Segment heights as fractions of the busiest day's total (0..1, cache = read+write). */
	h: { input: number; output: number; cache: number };
	cost: number;
	/** Formatted cost, e.g. "$9.62". */
	label: string;
}

/** Per-day bar segments normalized against the busiest day's total stack. */
export function stackedBarSeries(s: UsageSummary): StackedBarDay[] {
	const days = [...s.perDay].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
	let max = 0;
	for (const day of days) {
		max = Math.max(max, day.input + day.output + day.cacheRead + day.cacheWrite);
	}
	return days.map((day) => {
		const h =
			max > 0
				? {
						input: day.input / max,
						output: day.output / max,
						cache: (day.cacheRead + day.cacheWrite) / max,
					}
				: { input: 0, output: 0, cache: 0 };
		return { day: day.day, h, cost: day.cost, label: formatCost(day.cost) };
	});
}

// ---------------------------------------------------------------------------
// Model breakdown rows
// ---------------------------------------------------------------------------

export interface ModelRow {
	model: string;
	costText: string;
	/** "↑<in> ↓<out>" via formatTokens. */
	tokensText: string;
	/** Cost relative to the costliest model, 0..100 (rounded). */
	pctBar: number;
}

export function modelRows(s: UsageSummary): ModelRow[] {
	const rows = [...s.perModel].sort((a, b) => b.cost - a.cost);
	let max = 0;
	for (const row of rows) max = Math.max(max, row.cost);
	return rows.map((row) => ({
		model: row.model,
		costText: formatCost(row.cost),
		tokensText: `↑${formatTokens(row.input)} ↓${formatTokens(row.output)}`,
		pctBar: max > 0 ? Math.round((row.cost / max) * 100) : 0,
	}));
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

export interface SessionRow {
	id: string;
	/** Session name passthrough; empty when unnamed (page decides the fallback). */
	name: string;
	/** Project working directory (session cwd passthrough). */
	path: string;
	model: string;
	tokensText: string;
	costText: string;
	/** ISO timestamp passthrough (R17: summary's own "modified" semantics). */
	activeText: string;
}

export function sessionRows(s: UsageSummary): SessionRow[] {
	const rows = [...s.sessions].sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		path: row.cwd,
		model: row.model,
		tokensText: `↑${formatTokens(row.input)} ↓${formatTokens(row.output)}`,
		costText: formatCost(row.cost),
		activeText: row.modified,
	}));
}
