/**
 * subagent_status: enumerate live + recent pi-subagents runs from their on-disk
 * protocol (web console right-panel "Subagents" card, user issue batch 3).
 *
 * Investigation summary (read-only probe of /tmp/pi-subagents-uid-<uid>/async-subagent-runs):
 * - Each run lives in `<root>/<runId>/` (best-effort, all optional):
 *   - `status.json` — THE source. Shape: { runId, state: "running"|"complete"|"failed"|…,
 *     mode, cwd, startedAt, lastActivityAt, lastUpdate, currentStep, chainStepCount,
 *     steps: [{ agent, sessionName: "<agent>: <prompt head>", model, thinking, status,
 *     turnCount, toolCount, tokens, startedAt, endedAt, recentTools: [{tool,args,endMs}],
 *     recentOutput: [line, …] }], totalTokens, turnCount, toolCount }
 *   - `events.jsonl` — state transitions (subagent.run.started / step.started /
 *     step.completed {exitCode} / run.completed {status}). Fallback source.
 *   - `output-0.log` — raw agent log (line count only).
 *   - `subagent-log-<runId>.md`, `mission.json`, `process-terminal.json`, … (unread here).
 * - Runs provide `sessionName` heads like "reviewer: You are reviewing one task's…"
 *   which carry the agent + task text; prompts are otherwise redacted.
 *
 * Every parse failure degrades gracefully: a run directory that yields nothing
 * still appears with state:"unknown". Sort: running first, then by updatedAt desc.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface SubagentStatusRun {
	/** Run id (directory name). */
	id: string;
	/** Absolute run directory. */
	dir: string;
	/** "running" | "complete" | "failed" | … (extension-defined) | "unknown". */
	state: string;
	/** Agent of the current/first step (e.g. "worker", "reviewer"). */
	agent?: string;
	/** Prompt head (≤80 chars, single line). */
	task?: string;
	/**
	 * Full task text for the detail modal (review wave, T2 P1-2): the runner
	 * truncates status.json's `sessionName`-derived `task`, so the readable
	 * prompt comes from events.jsonl's first user message. The wrapper block
	 * ("Task: You are a delegated subagent…") is stripped when the actual
	 * task follows a `\nTask:\n` marker. Capped at 4000 chars.
	 */
	taskFull?: string;
	/** e.g. "bioturing/glm-5.1:high" when recorded. */
	model?: string;
	startedAt?: number;
	updatedAt?: number;
	/** Last meaningful line (≤120 chars): recentOutput tail, else last tool call. */
	activity?: string;
	/** Line count of the raw output log, when present. */
	lines?: number;
	turnCount?: number;
	toolCount?: number;
	/** Steps in the chain (1 for single-mode runs). */
	steps?: number;
	/**
	 * Steering window the runner itself maintains inside status.json
	 * (batch-4 steer): counters + recent request records. Pure pass-through of
	 * the `steering` block the runner writes; absent on runners/older runs
	 * that never steered. Never synthesized from the control inbox.
	 */
	steering?: Record<string, unknown>;
}

export interface SubagentStatusResult {
	/** Run roots that were scanned (transparent about discovery). */
	roots: string[];
	/** Runs sorted: running first, then most recently updated. */
	runs: SubagentStatusRun[];
}

export interface SubagentStatusOptions {
	/** Explicit run roots (tests). Defaults to every `{tmpdir()}/pi-subagents-<uid>/async-subagent-runs`. */
	roots?: string[];
}

/** Default discovery: every `{tmpdir()}/pi-subagents-<uid>/async-subagent-runs` that exists. */
function discoverRoots(): string[] {
	const base = tmpdir();
	let candidates: string[] = [];
	try {
		candidates = readdirSync(base)
			.filter((name) => name.startsWith("pi-subagents-"))
			.map((name) => join(base, name, "async-subagent-runs"))
			.filter((path) => existsSync(path));
	} catch {
		return [];
	}
	return candidates;
}

interface JsonRecord {
	[key: string]: unknown;
}

/** Best-effort JSON parse; null when absent/malformed. */
function readJson(path: string): JsonRecord | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as JsonRecord;
	} catch {
		return null;
	}
}

/** Tail lines of a jsonl file (parsed), newest last; empty on failure. */
function tailJsonLines(path: string, limit: number): JsonRecord[] {
	try {
		if (!existsSync(path)) return [];
		const text = readFileSync(path, "utf-8");
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		return lines
			.slice(-limit)
			.map((line) => {
				try {
					return JSON.parse(line) as JsonRecord;
				} catch {
					return null;
				}
			})
			.filter((record): record is JsonRecord => record !== null);
	} catch {
		return [];
	}
}

/** Derive state from events.jsonl tail (fallback when status.json is absent). */
function stateFromEvents(runDir: string): { state?: string; agent?: string; startedAt?: number } {
	const events = tailJsonLines(join(runDir, "events.jsonl"), 400);
	let hasStarted = false;
	let failedExit = false;
	let completedStatus: string | undefined;
	let agent: string | undefined;
	let startedAt: number | undefined;
	for (const event of events) {
		const type = typeof event.type === "string" ? String(event.type) : undefined;
		if (!type) continue;
		if (type === "subagent.run.started") {
			hasStarted = true;
			if (typeof event.ts === "number" && startedAt === undefined) startedAt = event.ts;
		}
		if (type === "subagent.step.started" && agent === undefined) {
			agent = typeof event.agent === "string" ? String(event.agent) : undefined;
		}
		if (type === "subagent.step.completed" && event.exitCode !== undefined && event.exitCode !== 0) {
			failedExit = true;
		}
		if (type === "subagent.run.completed") {
			completedStatus = typeof event.status === "string" ? String(event.status) : "complete";
		}
	}
	const state = completedStatus ?? (failedExit ? "failed" : hasStarted ? "running" : undefined);
	return { state, agent, startedAt };
}

/** Single line, truncated. */
function clampLine(text: string | undefined, max: number): string | undefined {
	if (typeof text !== "string") return undefined;
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length === 0) return undefined;
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/** First (or current) step record of a parsed status.json. */
function activeStepOf(status: JsonRecord): JsonRecord | undefined {
	const steps = Array.isArray(status.steps) ? (status.steps as unknown[]) : [];
	const current = typeof status.currentStep === "number" ? status.currentStep : 0;
	const step = steps[current] ?? steps[0];
	if (step && typeof step === "object" && !Array.isArray(step)) return step as JsonRecord;
	return undefined;
}

/** The prompt head: strip the "agent: " prefix of sessionName. */
function taskFromStep(step: JsonRecord | undefined, agent: string | undefined): string | undefined {
	const raw = typeof step?.sessionName === "string" ? (step.sessionName as string) : undefined;
	if (raw === undefined) return undefined;
	const stripped = agent && raw.startsWith(`${agent}:`) ? raw.slice(agent.length + 1) : raw;
	return clampLine(stripped, 80);
}

const MAX_TASK_FULL = 4000;
const TASK_FULL_HEAD_BYTES = 128 * 1024;

/** First parsed jsonl lines of a file, reading only a bounded head slice. */
function headJsonLines(path: string, byteLimit: number): JsonRecord[] {
	try {
		if (!existsSync(path)) return [];
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(byteLimit);
			const read = readSync(fd, buffer, 0, byteLimit, 0);
			const text = buffer.subarray(0, read).toString("utf-8");
			// Drop a trailing partial line (head slice can cut one in half).
			const lastNewline = text.lastIndexOf("\n");
			const complete = lastNewline >= 0 ? text.slice(0, lastNewline) : "";
			return complete
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => {
					try {
						return JSON.parse(line) as JsonRecord;
					} catch {
						return null;
					}
				})
				.filter((record): record is JsonRecord => record !== null);
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

/**
 * Full prompt text from the first user message in events.jsonl (review wave
 * T2 P1-2). status.json's `task` is pre-truncated by the runner, so the modal
 * needs this to show the real prompt. Wrapper preamble is stripped when the
 * delegated task follows `\nTask:\n`.
 */
function taskFullFromEvents(runDir: string): string | undefined {
	for (const event of headJsonLines(join(runDir, "events.jsonl"), TASK_FULL_HEAD_BYTES)) {
		if (event.type !== "message_start") continue;
		const message = event.message;
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const record = message as JsonRecord;
		if (record.role !== "user") continue;
		const content = Array.isArray(record.content) ? (record.content as unknown[]) : [];
		const parts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && !Array.isArray(block)) {
				const b = block as JsonRecord;
				if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) parts.push(b.text);
			}
		}
		const text = parts.join("\n").trim();
		if (text.length === 0) continue;
		const marker = text.lastIndexOf("\nTask:\n");
		const body = (marker >= 0 ? text.slice(marker + "\nTask:\n".length) : text).trim();
		if (body.length === 0) continue;
		return body.length > MAX_TASK_FULL ? `${body.slice(0, MAX_TASK_FULL - 1)}…` : body;
	}
	return undefined;
}

/** Activity line: recentOutput tail, else last recent tool. */
function activityFromStatus(status: JsonRecord): string | undefined {
	const step = activeStepOf(status);
	const outputs = Array.isArray(step?.recentOutput) ? (step?.recentOutput as unknown[]) : [];
	for (let i = outputs.length - 1; i >= 0; i--) {
		const line = clampLine(typeof outputs[i] === "string" ? (outputs[i] as string) : undefined, 120);
		if (line) return line;
	}
	const tools = Array.isArray(step?.recentTools) ? (step?.recentTools as unknown[]) : [];
	for (let i = tools.length - 1; i >= 0; i--) {
		const tool = tools[i];
		if (tool && typeof tool === "object" && !Array.isArray(tool)) {
			const record = tool as JsonRecord;
			const name = typeof record.tool === "string" ? record.tool : undefined;
			const args = typeof record.args === "string" ? record.args : undefined;
			if (name !== undefined) return clampLine(`${name} ${args ?? ""}`.trim(), 120);
		}
	}
	return undefined;
}

/** Line count of the first output log, when present. */
function outputLines(runDir: string): number | undefined {
	const path = join(runDir, "output-0.log");
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf-8");
		return text.split("\n").filter((line) => line.trim().length > 0).length;
	} catch {
		return undefined;
	}
}

function dirMtimeMs(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Collect one run directory into a status entry; never throws. */
function collectRun(runDir: string): SubagentStatusRun {
	const id = basename(runDir);
	const status = readJson(join(runDir, "status.json"));
	const step = status ? activeStepOf(status) : undefined;
	let state: string | undefined;
	let agent: string | undefined;
	let startedAt: number | undefined;
	let model: string | undefined;
	let updatedAt: number | undefined;
	let task: string | undefined;
	if (status) {
		state = typeof status.state === "string" ? status.state : undefined;
		startedAt = typeof status.startedAt === "number" ? status.startedAt : undefined;
		agent = typeof step?.agent === "string" ? step.agent : undefined;
		model = typeof step?.model === "string" ? step.model : undefined;
		updatedAt = typeof status.lastUpdate === "number" ? status.lastUpdate : undefined;
		if (typeof status.lastActivityAt === "number") {
			updatedAt = Math.max(updatedAt ?? 0, status.lastActivityAt);
		}
		task = taskFromStep(step, agent);
	}
	if (state === undefined || agent === undefined || startedAt === undefined) {
		const fromEvents = stateFromEvents(runDir);
		state = state ?? fromEvents.state;
		agent = agent ?? fromEvents.agent;
		startedAt = startedAt ?? fromEvents.startedAt;
	}
	updatedAt = updatedAt ?? dirMtimeMs(runDir);
	const turnCount = status && typeof status.turnCount === "number" ? status.turnCount : undefined;
	const toolCount = status && typeof status.toolCount === "number" ? status.toolCount : undefined;
	const steps = status && Array.isArray(status.steps) ? (status.steps as unknown[]).length : undefined;
	const steering =
		status && typeof status.steering === "object" && status.steering !== null && !Array.isArray(status.steering)
			? (status.steering as Record<string, unknown>)
			: undefined;
	return {
		id,
		dir: runDir,
		state: state ?? "unknown",
		agent: agent ?? undefined,
		task: task ?? undefined,
		taskFull: taskFullFromEvents(runDir),
		model,
		startedAt,
		updatedAt,
		activity: status ? activityFromStatus(status) : undefined,
		lines: outputLines(runDir),
		turnCount,
		toolCount,
		steps,
		...(steering !== undefined ? { steering } : {}),
	};
}

/** Enumerate subagent runs. Tolerant of every failure; malformed dirs surface as state:"unknown". */
export function listSubagentRuns(options: SubagentStatusOptions = {}): SubagentStatusResult {
	const roots =
		options.roots !== undefined
			? options.roots.filter((root) => {
					try {
						return existsSync(root);
					} catch {
						return false;
					}
				})
			: discoverRoots();
	const runs: SubagentStatusRun[] = [];
	for (const root of roots) {
		let entries: Array<{ name: string; isDir: boolean }> = [];
		try {
			entries = readdirSync(root, { withFileTypes: true })
				.filter((dirent) => dirent.isDirectory())
				.map((dirent) => ({ name: dirent.name, isDir: true }));
		} catch {
			continue;
		}
		for (const entry of entries) {
			try {
				runs.push(collectRun(join(root, entry.name)));
			} catch {
				runs.push({ id: entry.name, dir: join(root, entry.name), state: "unknown" });
			}
		}
	}
	// running first (needs-attention kept in the recency bucket), then by updatedAt desc.
	runs.sort((a, b) => {
		const aRunning = a.state === "running" ? 0 : 1;
		const bRunning = b.state === "running" ? 0 : 1;
		if (aRunning !== bRunning) return aRunning - bRunning;
		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	});
	return { roots, runs };
}
