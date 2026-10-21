/**
 * subagent_transcript: project a pi-subagents run's on-disk transcript into
 * bounded chat items the web console renders like a real transcript (thinking
 * blocks, tool cards, markdown), instead of a raw log dump.
 *
 * Two on-disk sources, same projection:
 * - `events.jsonl` (single-mode runs; verified against a live run dir
 *   `{tmpdir()}/pi-subagents-<uid>/async-subagent-runs/<runId>/events.jsonl`):
 *   `message_end` carries the FULL message record (role "user" = the prompt the
 *   master session sent; role "assistant" = content blocks thinking / text /
 *   toolCall plus usage/model/responseId; role "toolResult" = toolCallId +
 *   content). `message_start` carries the first chunk (assistant starts are
 *   empty, so only `message_end` is authoritative). `tool_execution_start` /
 *   `tool_execution_end` bracket each tool call by `toolCallId`; the end event
 *   carries `result.content` and `isError`. `tool_execution_update` (partial
 *   streaming) is not projected.
 * - Workflow and chain runs never write message events to their own
 *   events.jsonl (only orchestration traces): their per-step transcripts live
 *   in `status.json steps[].sessionFile` (the pi session format, entries
 *   `{type: "message", message: {role, content…}}`). When events.jsonl yields
 *   no items, the step session files are projected in step order with the same
 *   bounds and tool-card resolution.
 *
 * The projection is bounded end to end (2 MB head read per file, per-block
 * text caps, hard item cap) so the payload stays small enough to poll over the
 * websocket while a run is live. Every clip sets `truncated: true`.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { findRunDir, SubagentSteerError } from "./subagent-steer.ts";

/** One tool card of a transcript item; mirrors the frontend ToolCardState. */
export interface SubagentTranscriptToolCard {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Full toolResult message (or the execution_end result) once resolved. */
	result?: unknown;
	isError: boolean;
	/** True between tool_execution_start and its end/toolResult event. */
	running: boolean;
}

/** One chat-renderable transcript item. */
export interface SubagentTranscriptItem {
	kind: "user" | "assistant";
	id: string;
	/** Agent message record (role, content blocks, usage, model, …). */
	message: Record<string, unknown>;
	toolCards: SubagentTranscriptToolCard[];
}

export interface SubagentTranscriptResult {
	runId: string;
	dir: string;
	state: string;
	/** Absolute path of the master session .jsonl (status.json `sessionId`). */
	sessionFile?: string;
	items: SubagentTranscriptItem[];
	/** True when any clip/omit/cap limit hit while projecting. */
	truncated: boolean;
	/** Parsed JSONL lines actually read from the transcript source. */
	lineCount: number;
}

/**
 * Why a transcript could not be produced. `web-commands` catches this (and
 * `SubagentSteerError`, which `findRunDir` throws for unknown runs) and maps
 * both to an RPC error response.
 */
export class SubagentTranscriptError extends Error {
	/** Stable machine reason. */
	readonly code: "invalid-run-id" | "unknown-run";

	constructor(code: "invalid-run-id" | "unknown-run", message: string) {
		super(message);
		this.name = "SubagentTranscriptError";
		this.code = code;
	}
}

/** Head-read cap per JSONL source file (older transcripts beyond are clipped). */
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Per-block clip for user/assistant text and thinking. */
const MAX_TEXT_CHARS = 6000;
/** Per-block clip for toolResult content (tool output is often huge). */
const MAX_TOOL_RESULT_CHARS = 2000;
/** Per-string clip applied when walking tool-call args. */
const MAX_ARGS_STRING_CHARS = 2000;
/** Hard cap on projected items (oldest kept). */
const MAX_ITEMS = 400;
/**
 * Total serialized-payload budget for the returned items (polled every few
 * seconds while a run is live). Once hit, further items are dropped (oldest
 * kept) and `truncated` is raised.
 */
const MAX_PAYLOAD_BYTES = 512 * 1024;
/** Depth guard for the args walk (cyclic/deep payloads must not hang). */
const MAX_ARGS_DEPTH = 12;
/** Step session files projected at most in the chain/workflow fallback. */
const MAX_STEP_FILES = 8;
/** Appended to any clipped string. */
const TRUNCATION_MARK = "… [truncated]";

type JsonRecord = Record<string, unknown>;

/** Mutable projection state: any clip flips `truncated`. */
interface ClipState {
	truncated: boolean;
}

/** Mirror of the subagent-steer runId rules: a bare directory name only. */
function validateRunId(runId: unknown): string {
	if (
		typeof runId !== "string" ||
		runId.length === 0 ||
		/\s/.test(runId) ||
		runId.includes("/") ||
		runId.includes("\\")
	) {
		throw new SubagentTranscriptError("invalid-run-id", "runId must be a non-empty run directory name");
	}
	return runId;
}

/**
 * Resolve the run dir with the same tolerant scan as subagent_status/steer.
 * The steer layer throws `SubagentSteerError("unknown-run")`; normalize it to
 * this module's error so callers only have to know two error types.
 */
function resolveRunDir(runId: string, roots: string[] | undefined): string {
	try {
		return findRunDir(runId, roots);
	} catch (error) {
		if (error instanceof SubagentSteerError) {
			throw new SubagentTranscriptError("unknown-run", error.message);
		}
		throw error;
	}
}

interface RunStatusInfo {
	state: string;
	sessionFile?: string;
	/** Per-step session transcripts (chain/workflow runs only). */
	stepSessionFiles: string[];
}

/** status.json subset the transcript result needs; absent/garbage → defaults. */
function readRunStatus(runDir: string): RunStatusInfo {
	const fallback: RunStatusInfo = { state: "unknown", stepSessionFiles: [] };
	try {
		const path = join(runDir, "status.json");
		if (!existsSync(path)) return fallback;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
		const record = parsed as JsonRecord;
		const steps = Array.isArray(record.steps) ? (record.steps as unknown[]) : [];
		const stepSessionFiles: string[] = [];
		for (const step of steps) {
			const stepRecord = asRecord(step);
			const sessionFile = asString(stepRecord?.sessionFile);
			if (sessionFile && existsSync(sessionFile) && !stepSessionFiles.includes(sessionFile)) {
				stepSessionFiles.push(sessionFile);
			}
		}
		return {
			state: typeof record.state === "string" ? record.state : "unknown",
			sessionFile: typeof record.sessionId === "string" ? record.sessionId : undefined,
			stepSessionFiles,
		};
	} catch {
		return fallback;
	}
}

/**
 * Read one JSONL file bounded to MAX_TRANSCRIPT_BYTES. A larger file is cut at
 * the last complete newline (a trailing partial line is never parsed) and the
 * caller is told via `truncated`. Junk lines are skipped silently.
 */
function readJsonLines(path: string, clip: ClipState): { records: JsonRecord[]; count: number } {
	let text: string;
	try {
		if (!existsSync(path)) return { records: [], count: 0 };
		const size = statSync(path).size;
		const fd = openSync(path, "r");
		let read: number;
		try {
			const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
			read = readSync(fd, buffer, 0, MAX_TRANSCRIPT_BYTES, 0);
			text = buffer.subarray(0, read).toString("utf-8");
		} finally {
			closeSync(fd);
		}
		if (size > read) {
			clip.truncated = true;
			const lastNewline = text.lastIndexOf("\n");
			text = lastNewline >= 0 ? text.slice(0, lastNewline) : "";
		}
	} catch {
		return { records: [], count: 0 };
	}
	const records: JsonRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as JsonRecord);
		} catch {
			// Junk line — skip; protocol files are append-only and can be cut.
		}
	}
	return { records, count: records.length };
}

/** Clip one string, flipping `truncated` when the clip lands. */
function clipString(value: string, max: number, state: ClipState): string {
	if (value.length <= max) return value;
	state.truncated = true;
	return `${value.slice(0, max)}${TRUNCATION_MARK}`;
}

/** Walk a tool-call argument payload and clip oversized strings. */
function deepClipArgs(value: unknown, state: ClipState, depth = 0): unknown {
	if (typeof value === "string") return clipString(value, MAX_ARGS_STRING_CHARS, state);
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_ARGS_DEPTH) return value;
	if (Array.isArray(value)) return value.map((entry) => deepClipArgs(entry, state, depth + 1));
	const out: JsonRecord = {};
	for (const [key, entry] of Object.entries(value as JsonRecord)) {
		out[key] = deepClipArgs(entry, state, depth + 1);
	}
	return out;
}

/**
 * Bound content blocks: text/thinking clipped to `textMax`, tool-call args
 * deep-clipped, every other block type (images, unknown payloads) dropped.
 */
function boundContentBlocks(content: unknown[], textMax: number, state: ClipState): unknown[] {
	const blocks: unknown[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const record = block as JsonRecord;
		const type = typeof record.type === "string" ? record.type : "";
		if (type === "text" && typeof record.text === "string") {
			blocks.push({ ...record, text: clipString(record.text, textMax, state) });
		} else if (type === "thinking" && typeof record.thinking === "string") {
			blocks.push({ ...record, thinking: clipString(record.thinking, textMax, state) });
		} else if (type === "toolCall") {
			blocks.push({ ...record, arguments: deepClipArgs(record.arguments, state) });
		} else {
			// Image/data blocks are not shipped to the browser transcript.
			state.truncated = true;
		}
	}
	return blocks;
}

/** Bound a message record's content blocks; other fields pass through. */
function boundMessage(message: JsonRecord, textMax: number, state: ClipState): JsonRecord {
	const bounded: JsonRecord = { ...message };
	if (Array.isArray(message.content)) {
		bounded.content = boundContentBlocks(message.content as unknown[], textMax, state);
	}
	return bounded;
}

/** Unique item ids across a transcript (assistant ids derive from responseId). */
function uniqueId(base: string, used: Set<string>): string {
	let id = base;
	let suffix = 2;
	while (used.has(id)) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}
	used.add(id);
	return id;
}

function asRecord(value: unknown): JsonRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Accumulates items + tool cards from either transcript source. */
interface Projector {
	items: SubagentTranscriptItem[];
	handleMessageEnd(message: JsonRecord): void;
	handleMessageStart(message: JsonRecord): void;
	toolStarted(event: JsonRecord): void;
	toolEnded(event: JsonRecord): void;
	resolveFromToolResult(message: JsonRecord): void;
	/** Apply deferred fallbacks (message_start prompt, toolResult starts). */
	finalize(): void;
}

function createProjector(clip: ClipState): Projector {
	const items: SubagentTranscriptItem[] = [];
	const usedIds = new Set<string>();
	const cards = new Map<string, SubagentTranscriptToolCard>();
	/** Cards whose result came from a toolResult message (the winning source). */
	const resolvedByMessage = new Set<string>();
	/** toolResult message_end ids seen (suppresses the message_start fallback). */
	const toolResultEnds = new Set<string>();
	/** First toolResult message_start per toolCallId — fallback only. */
	const toolResultStarts = new Map<string, JsonRecord>();
	/** First user message_start — fallback only (no message_end:user exists). */
	let userStartFallback: JsonRecord | undefined;
	let userCount = 0;
	let assistantCount = 0;
	let finalized = false;
	/** Running estimate of the serialized payload (see MAX_PAYLOAD_BYTES). */
	let payloadBytes = 0;

	const pushItem = (item: SubagentTranscriptItem): void => {
		if (items.length >= MAX_ITEMS) {
			clip.truncated = true;
			return;
		}
		const estimate = JSON.stringify(item).length;
		if (payloadBytes + estimate > MAX_PAYLOAD_BYTES) {
			clip.truncated = true;
			return;
		}
		payloadBytes += estimate;
		items.push(item);
	};

	const cardFor = (toolCallId: string, toolName: string | undefined, args: unknown): SubagentTranscriptToolCard => {
		const existing = cards.get(toolCallId);
		if (existing) return existing;
		const card: SubagentTranscriptToolCard = {
			toolCallId,
			toolName: toolName ?? "",
			args: deepClipArgs(args, clip),
			isError: false,
			running: true,
		};
		cards.set(toolCallId, card);
		return card;
	};

	const handleUser = (message: JsonRecord): void => {
		userCount += 1;
		pushItem({
			kind: "user",
			id: uniqueId(`u-${userCount}`, usedIds),
			message: boundMessage(message, MAX_TEXT_CHARS, clip),
			toolCards: [],
		});
	};

	const handleAssistant = (message: JsonRecord): void => {
		assistantCount += 1;
		const bounded = boundMessage(message, MAX_TEXT_CHARS, clip);
		const declared = Array.isArray(bounded.content) ? (bounded.content as unknown[]) : [];
		const toolCards: SubagentTranscriptToolCard[] = [];
		for (const block of declared) {
			const record = asRecord(block);
			if (!record || record.type !== "toolCall") continue;
			const toolCallId = asString(record.id);
			if (!toolCallId) continue;
			toolCards.push(cardFor(toolCallId, asString(record.name), record.arguments));
		}
		const base = `a-${asString(message.responseId) ?? String(assistantCount)}`;
		pushItem({
			kind: "assistant",
			id: uniqueId(base, usedIds),
			message: bounded,
			toolCards,
		});
	};

	const resolveFromToolResult = (message: JsonRecord): void => {
		const toolCallId = asString(message.toolCallId);
		if (!toolCallId) return;
		const card = cardFor(toolCallId, asString(message.toolName), undefined);
		card.result = boundMessage(message, MAX_TOOL_RESULT_CHARS, clip);
		card.isError = message.isError === true;
		card.running = false;
		resolvedByMessage.add(toolCallId);
		payloadBytes += JSON.stringify(card.result).length;
	};

	return {
		items,
		handleMessageEnd(message: JsonRecord): void {
			const role = asString(message.role);
			if (role === "user") {
				handleUser(message);
			} else if (role === "assistant") {
				handleAssistant(message);
			} else if (role === "toolResult") {
				const toolCallId = asString(message.toolCallId);
				if (toolCallId) toolResultEnds.add(toolCallId);
				resolveFromToolResult(message);
			}
		},
		handleMessageStart(message: JsonRecord): void {
			const role = asString(message.role);
			if (role === "user") {
				if (userStartFallback === undefined) {
					const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
					const hasText = content.some((block) => {
						const record = asRecord(block);
						return record?.type === "text" && typeof record.text === "string" && record.text.trim().length > 0;
					});
					if (hasText) userStartFallback = message;
				}
			} else if (role === "toolResult") {
				const toolCallId = asString(message.toolCallId);
				if (toolCallId && !toolResultStarts.has(toolCallId)) toolResultStarts.set(toolCallId, message);
			}
		},
		toolStarted(event: JsonRecord): void {
			const toolCallId = asString(event.toolCallId);
			if (!toolCallId) return;
			// Keep an auto-registered card (declared by the assistant message);
			// only execution metadata would be new, and the message wins.
			cardFor(toolCallId, asString(event.toolName), event.args);
		},
		toolEnded(event: JsonRecord): void {
			const toolCallId = asString(event.toolCallId);
			if (!toolCallId) return;
			const card = cardFor(toolCallId, asString(event.toolName), undefined);
			if (resolvedByMessage.has(toolCallId)) return; // toolResult message wins
			const result = asRecord(event.result);
			if (result) {
				const content = Array.isArray(result.content)
					? boundContentBlocks(result.content as unknown[], MAX_TOOL_RESULT_CHARS, clip)
					: [];
				card.result = { content };
				payloadBytes += JSON.stringify(card.result).length;
			}
			card.isError = event.isError === true;
			card.running = false;
		},
		resolveFromToolResult,
		finalize(): void {
			if (finalized) return;
			finalized = true;
			// Old-format fallback: a run that never recorded message_end:user
			// still shows its prompt (the master's task) as the first bubble.
			if (userCount === 0 && userStartFallback) {
				items.unshift({
					kind: "user",
					id: uniqueId("u-1", usedIds),
					message: boundMessage(userStartFallback, MAX_TEXT_CHARS, clip),
					toolCards: [],
				});
			}
			// toolResult message_start fallback: only for cards no message_end resolved.
			for (const [toolCallId, message] of toolResultStarts) {
				if (toolResultEnds.has(toolCallId) || resolvedByMessage.has(toolCallId)) continue;
				resolveFromToolResult(message);
			}
		},
	};
}

/**
 * Project one run's transcript into chat items. Never throws for junk content;
 * only invalid-run-id / unknown-run surface as SubagentTranscriptError.
 */
export function readSubagentTranscript(options: { runId: unknown; roots?: string[] }): SubagentTranscriptResult {
	const runId = validateRunId(options.runId);
	const dir = resolveRunDir(runId, options.roots);
	const { state, sessionFile, stepSessionFiles } = readRunStatus(dir);
	const clip: ClipState = { truncated: false };
	const projector = createProjector(clip);
	let lineCount = 0;

	const eventSource = readJsonLines(join(dir, "events.jsonl"), clip);
	lineCount += eventSource.count;
	for (const event of eventSource.records) {
		const type = asString(event.type);
		if (type === "message_end") {
			const message = asRecord(event.message);
			if (message) projector.handleMessageEnd(message);
		} else if (type === "message_start") {
			const message = asRecord(event.message);
			if (message) projector.handleMessageStart(message);
		} else if (type === "tool_execution_start") {
			projector.toolStarted(event);
		} else if (type === "tool_execution_end") {
			projector.toolEnded(event);
		}
	}

	// Chain/workflow runs write no message events to their own events.jsonl —
	// project the per-step session transcripts instead (same bounds, same cards).
	if (projector.items.length === 0 && stepSessionFiles.length > 0) {
		const files = stepSessionFiles.slice(0, MAX_STEP_FILES);
		if (stepSessionFiles.length > files.length) clip.truncated = true;
		for (const file of files) {
			const step = readJsonLines(file, clip);
			lineCount += step.count;
			for (const entry of step.records) {
				if (asString(entry.type) !== "message") continue;
				const message = asRecord(entry.message);
				if (!message) continue;
				const role = asString(message.role);
				if (role === "user") projector.handleMessageEnd(message);
				else if (role === "assistant") projector.handleMessageEnd(message);
				else if (role === "toolResult") projector.resolveFromToolResult(message);
			}
		}
	}

	projector.finalize();

	return {
		runId,
		dir,
		state,
		...(sessionFile !== undefined ? { sessionFile } : {}),
		items: projector.items,
		truncated: clip.truncated,
		lineCount,
	};
}
