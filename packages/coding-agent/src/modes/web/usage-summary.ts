/**
 * get_usage_summary: aggregate token/cost usage across on-disk session files
 * for the web console Usage page (spec §6.1).
 *
 * Accounting model — document-level caveats that reviewers should know:
 * - The sessions tree is scanned recursively for all .jsonl files; each file is
 *   accounted as ONE session, mirroring how list_sessions treats files.
 * - Subagent task sessions (nested `<root>/<task>/run-N/session.jsonl`,
 *   written by the pi-subagents extension) use the same record format and are
 *   counted as their own sessions — they represent real usage.
 * - Fork export files (`forks/*.jsonl`) copy the origin history; like the rest
 *   of the product's file-per-session model, they are counted as separate
 *   sessions (their copied prefix double-counts in lifetime views).
 * - Range filtering: files are pre-filtered by mtime, then records are
 *   filtered by their own timestamp (message.timestamp, else the line's ISO
 *   wrapper timestamp, else file mtime). Totals, perDay, perModel, and session
 *   rows all derive from the SAME in-range record set, so the invariant
 *   totals == Σ perDay == Σ sessions holds for any range.
 * - In-flight turns: records are appended to disk when a turn completes, so at
 *   most the actively-streaming turn is missing. In-memory merging is
 *   deliberately skipped for v1 (accepted by the plan with documentation).
 * - Malformed lines increment `skipped` and never throw; unreadable files
 *   count one skip and are abandoned.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getSessionsDir } from "../../config.ts";
import type { RpcUsageSummary } from "../rpc/rpc-types.ts";

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 30_000;

/** Scan options. `rangeDays` of 0 (or undefined) means all time. */
export interface UsageSummaryOptions {
	rangeDays?: number;
	/** Deterministic time base for tests; defaults to Date.now(). */
	now?: number;
}

interface FileAccumulator {
	file: string;
	id: string;
	name: string;
	cwd: string;
	/** Distinct in-range usage records seen (drives session-row inclusion). */
	hasUsage: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Model of the most recent in-range usage record. */
	lastModel: string;
	/** Timestamp of the most recent in-range usage record. */
	lastActivityMs: number;
}

interface DayAccumulator {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface ModelAccumulator extends DayAccumulator {
	files: Set<string>;
}

function emptyDay(): DayAccumulator {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Cost sums cross the wire to UI formatters; micro-round kills IEEE754 dust
 * (0.1 + 0.05 = 0.15000000000000002 style) at the aggregate boundary without
 * affecting display precision (formatters render 2-3 decimals).
 */
function roundCost(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

/** Collect every .jsonl file under `dir` (recursive), one path per file. */
async function collectSessionFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	// A missing/unreadable dir is an empty scan, not an error (mirrors
	// SessionManager.listAll's best-effort discovery).
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			out.push(...(await collectSessionFiles(path)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			out.push(path);
		}
	}
	return out;
}

function normalizeRangeDays(rangeDays: unknown): number {
	const n = typeof rangeDays === "number" ? Math.floor(rangeDays) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Aggregate usage across all session files under `sessionsRoot`.
 * Never throws for bad input; malformed lines/records increment `skipped`.
 */
export async function scanUsageSummary(
	sessionsRoot: string,
	options: UsageSummaryOptions = {},
): Promise<RpcUsageSummary> {
	const rangeDays = normalizeRangeDays(options.rangeDays);
	const now = options.now ?? Date.now();
	const cutoff = rangeDays > 0 ? now - rangeDays * DAY_MS : Number.NEGATIVE_INFINITY;

	const files = await collectSessionFiles(sessionsRoot);

	let skipped = 0;
	const dayMap = new Map<string, DayAccumulator>();
	const modelMap = new Map<string, ModelAccumulator>();
	const sessionRows = new Map<string, FileAccumulator>();

	for (const file of files) {
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(file)).mtimeMs;
		} catch {
			skipped++;
			continue;
		}
		if (mtimeMs < cutoff) {
			// No in-range record can live in an untouched file: a record's
			// timestamp never exceeds the write time of its own append.
			continue;
		}

		const acc: FileAccumulator = {
			file,
			id: "",
			name: "",
			cwd: "",
			hasUsage: false,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			lastModel: "",
			lastActivityMs: 0,
		};

		let headerSeen = false;
		try {
			const rl = createInterface({
				input: createReadStream(file, { encoding: "utf8" }),
				crlfDelay: Infinity,
			});
			for await (const line of rl) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let record: unknown;
				try {
					record = JSON.parse(trimmed);
				} catch {
					skipped++;
					continue;
				}
				if (typeof record !== "object" || record === null) {
					skipped++;
					continue;
				}
				const entry = record as Record<string, unknown>;
				const type = entry.type;

				if (type === "session") {
					if (!headerSeen) {
						headerSeen = true;
						if (typeof entry.id === "string") acc.id = entry.id;
						if (typeof entry.cwd === "string") acc.cwd = entry.cwd;
					}
					continue;
				}
				if (type === "session_info") {
					if (typeof entry.name === "string") acc.name = entry.name.trim();
					continue;
				}
				if (type !== "message") continue;

				const message = entry.message;
				if (typeof message !== "object" || message === null) continue;
				const msg = message as Record<string, unknown>;
				if (msg.role !== "assistant") continue;

				const usage = msg.usage;
				if (usage === undefined) {
					// Assistant turns without usage (aborted/streaming) are expected
					// bookkeeping-free records, not corruption.
					continue;
				}
				if (typeof usage !== "object" || usage === null) {
					skipped++;
					continue;
				}
				const u = usage as Record<string, unknown>;
				const costObj = u.cost;
				const costTotal =
					typeof costObj === "object" && costObj !== null
						? finiteNumber((costObj as Record<string, unknown>).total)
						: 0;
				if (
					u.input === undefined &&
					u.output === undefined &&
					u.cacheRead === undefined &&
					u.cacheWrite === undefined
				) {
					// Empty usage envelopes carry no signal; treat as malformed.
					skipped++;
					continue;
				}
				const input = finiteNumber(u.input);
				const output = finiteNumber(u.output);
				const cacheRead = finiteNumber(u.cacheRead);
				const cacheWrite = finiteNumber(u.cacheWrite);

				let recordMs = 0;
				if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
					recordMs = msg.timestamp;
				} else if (typeof entry.timestamp === "string") {
					const parsed = Date.parse(entry.timestamp);
					if (Number.isFinite(parsed)) recordMs = parsed;
				}
				if (recordMs <= 0) recordMs = mtimeMs;
				if (recordMs < cutoff) continue;

				acc.input += input;
				acc.output += output;
				acc.cacheRead += cacheRead;
				acc.cacheWrite += cacheWrite;
				acc.cost += costTotal;
				acc.hasUsage = true;
				if (typeof msg.model === "string") acc.lastModel = msg.model;
				if (recordMs > acc.lastActivityMs) acc.lastActivityMs = recordMs;

				const dayKey = new Date(recordMs).toISOString().slice(0, 10);
				const day = dayMap.get(dayKey) ?? emptyDay();
				day.input += input;
				day.output += output;
				day.cacheRead += cacheRead;
				day.cacheWrite += cacheWrite;
				day.cost += costTotal;
				dayMap.set(dayKey, day);

				const model = typeof msg.model === "string" ? msg.model : "";
				const model1 = modelMap.get(model) ?? { ...emptyDay(), files: new Set<string>() };
				model1.input += input;
				model1.output += output;
				model1.cacheRead += cacheRead;
				model1.cacheWrite += cacheWrite;
				model1.cost += costTotal;
				model1.files.add(file);
				modelMap.set(model, model1);
			}
		} catch {
			// Mid-scan read failure (permissions, races): count and move on.
			skipped++;
		}

		// Headerless files (corruption, partial copies) still count toward
		// totals but have no session identity to surface as a row.
		if (acc.hasUsage && acc.id !== "") {
			sessionRows.set(file, acc);
		}
	}

	const sessions = [...sessionRows.values()]
		.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
		.map((acc) => ({
			file: acc.file,
			id: acc.id,
			name: acc.name,
			cwd: acc.cwd,
			model: acc.lastModel,
			input: acc.input,
			output: acc.output,
			cost: roundCost(acc.cost),
			modified: new Date(acc.lastActivityMs).toISOString(),
		}));

	const perDay = [...dayMap.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a === b ? 0 : 1))
		.map(([day, acc]) => ({
			day,
			input: acc.input,
			output: acc.output,
			cacheRead: acc.cacheRead,
			cacheWrite: acc.cacheWrite,
			cost: roundCost(acc.cost),
		}));

	const perModel = [...modelMap.entries()]
		.sort((a, b) => b[1].cost - a[1].cost)
		.map(([model, acc]) => ({
			model,
			input: acc.input,
			output: acc.output,
			cacheRead: acc.cacheRead,
			cacheWrite: acc.cacheWrite,
			cost: roundCost(acc.cost),
			sessions: acc.files.size,
		}));

	const totalsInput = perDay.reduce((sum, row) => sum + row.input, 0);
	const totalsOutput = perDay.reduce((sum, row) => sum + row.output, 0);
	const totalsCacheRead = perDay.reduce((sum, row) => sum + row.cacheRead, 0);
	const totalsCacheWrite = perDay.reduce((sum, row) => sum + row.cacheWrite, 0);
	const totalsCost = roundCost(perDay.reduce((sum, row) => sum + row.cost, 0));

	return {
		totals: {
			input: totalsInput,
			output: totalsOutput,
			cacheRead: totalsCacheRead,
			cacheWrite: totalsCacheWrite,
			cost: totalsCost,
			sessions: sessions.length,
			skipped,
		},
		perDay,
		perModel,
		sessions,
	};
}

// ---------------------------------------------------------------------------
// Cached entry point (30s per rangeDays key) used by the web command handler.
// ---------------------------------------------------------------------------

const summaryCache = new Map<
	number,
	{ expiresAt: number; loading: Promise<RpcUsageSummary> | null; value: RpcUsageSummary | null }
>();

/** Flush the summary cache. Exported for tests and for smoke tooling. */
export function clearUsageSummaryCache(): void {
	summaryCache.clear();
}

/**
 * Cached getUsageSummary: identical results within the 30s TTL window for the
 * same rangeDays key, with de-duplicated concurrent loads.
 */
export async function getUsageSummary(options: UsageSummaryOptions = {}): Promise<RpcUsageSummary> {
	const rangeDays = normalizeRangeDays(options.rangeDays);
	if (options.now !== undefined) {
		// Deterministic test path — never polluted by (or polluting) the cache.
		return scanUsageSummary(getSessionsDir(), options);
	}
	const cached = summaryCache.get(rangeDays);
	const now = Date.now();
	if (cached?.value && cached.expiresAt > now) {
		return cached.value;
	}
	if (cached?.loading) {
		return cached.loading;
	}
	const loading = scanUsageSummary(getSessionsDir(), { rangeDays }).then((value) => {
		const entry = summaryCache.get(rangeDays);
		if (entry) {
			entry.loading = null;
			entry.value = value;
		}
		return value;
	});
	summaryCache.set(rangeDays, { expiresAt: now + CACHE_TTL_MS, loading, value: null });
	return loading;
}
