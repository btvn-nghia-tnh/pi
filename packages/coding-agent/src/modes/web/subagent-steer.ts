/**
 * subagent_steer / subagent_stop: write control requests into a running
 * pi-subagents run's on-disk inbox (web console batch-4, owner request:
 * steer + stop subagents from the Subagents card modal).
 *
 * Protocol source (verified against pi-subagents v0.61.0,
 * node_modules/pi-subagents/src/runs/background/control-channel.ts):
 * - Every async run dir owns a control inbox at `<asyncDir>/control/`.
 * - Steering: drop a JSON request file into `control/steer-requests/` named
 *   `${String(ts).padStart(13, "0")}-${base64url(id)}.json` with the shape
 *   `{ type: "steer", id, ts, message, mode?, source? }`. The runner watches
 *   that directory (fs.watch + 5s safety poll) and consumes valid requests.
 * - Acks: a consumed request produces `control/steer-acks/<index>/<file>.json`
 *   records `{ type: "steer-ack", protocolVersion: 1, requestId, index, ts,
 *   state, message }` with state "delivered" | "queued" | "failed". The
 *   runner's watcher consumes (deletes) ack files as it reads them — absence
 *   is normal, not an error.
 * - Inbox closed: once the run finishes, the runner writes
 *   `control/steer-inbox-closed.json` and stops consuming — steer requests
 *   written after that will never be picked up, so this command refuses them.
 * - Stopping: `{ type: "stop", ts?, source?, reason?, targetIndex?, childId? }`
 *   into `control/stop.json` (the portable single-run request file the
 *   runner's `consumeStopRequestPayloads` reads as its legacy path).
 *
 * Validation mirrors `validSteerRequest` from the source module (byte
 * limits, id charset, delivery modes) so a written file is never silently
 * ignored by the runner. We do NOT import pi-subagents (not a dependency of
 * this package); the rules are copied and pinned here with tests.
 *
 * Run resolution reuses the tolerant subagent_status scan and matches by
 * directory name — user-supplied ids are never joined into paths, so path
 * traversal cannot happen.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { listSubagentRuns } from "./subagent-status.ts";

/** Steer message size cap (validSteerRequest: MAX_STEER_MESSAGE_BYTES). */
export const MAX_STEER_MESSAGE_BYTES = 128 * 1024;
/** Steer request id cap (validSteerRequest: MAX_STEER_REQUEST_ID_LENGTH). */
export const MAX_STEER_REQUEST_ID_LENGTH = 256;
/** Acceptable delivery modes (validSteerRequest / RPC steer). */
export const STEER_DELIVERY_MODES = ["steer", "follow_up", "auto"] as const;
export type SteerDeliveryMode = (typeof STEER_DELIVERY_MODES)[number];

/** Marker file the runner leaves when the steer inbox is closed for good. */
export const STEER_INBOX_CLOSED_FILE = "steer-inbox-closed.json";
/** Directory consumed for steering requests. */
export const STEER_REQUESTS_DIR = "steer-requests";
/** Directory where the runner writes per-request acknowledgements. */
export const STEER_ACKS_DIR = "steer-acks";
/** Portable single-run stop request file. */
export const STOP_REQUEST_FILE = "stop.json";

export class SubagentSteerError extends Error {
	/** Stable machine reason: "unknown-run" | "invalid-run-id" | "invalid-message" | "invalid-mode" | "invalid-request-id" | "invalid-reason" | "inbox-closed". */
	readonly reason: string;

	constructor(reason: string, message: string) {
		super(message);
		this.name = "SubagentSteerError";
		this.reason = reason;
	}
}

/** Control inbox of an async run dir. */
export function controlInboxDir(asyncDir: string): string {
	return join(asyncDir, "control");
}

export function steerRequestsDir(asyncDir: string): string {
	return join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

export function steerAcksDir(asyncDir: string): string {
	return join(controlInboxDir(asyncDir), STEER_ACKS_DIR);
}

export function steerInboxClosedPath(asyncDir: string): string {
	return join(controlInboxDir(asyncDir), STEER_INBOX_CLOSED_FILE);
}

export function stopRequestPath(asyncDir: string): string {
	return join(controlInboxDir(asyncDir), STOP_REQUEST_FILE);
}

/** Request file name convention (steerRequestFileName in the protocol source). */
export function steerRequestFileName(ts: number, id: string): string {
	return `${String(ts).padStart(13, "0")}-${Buffer.from(id, "utf-8").toString("base64url")}.json`;
}

export interface SteerAckInfo {
	state: string;
	message?: string;
	ts?: number;
}

export interface SteerResult {
	/**
	 * "queued" — written, no ack yet (the runner may consume it within its
	 * poll window). "delivered" — an ack record already answered this request.
	 */
	delivered: "queued" | "delivered";
	/** Runner ack when one showed up within ackCheckDelayMs. */
	ack?: SteerAckInfo;
	requestId: string;
	runDir: string;
	requestPath: string;
}

export interface StopResult {
	/** Always "requested" on success — the runner consumes stop.json asynchronously. */
	delivered: "requested";
	runDir: string;
	stopPath: string;
}

/**
 * Find a run directory by run id using the same tolerant scan as
 * subagent_status. The scan lists real directories, so a match only happens
 * for an id that literally names a run dir (no traversal).
 */
export function findRunDir(runId: string, roots?: string[]): string {
	const { runs } = listSubagentRuns(roots !== undefined ? { roots } : {});
	const match = runs.find((run) => run.id === runId);
	if (match) return match.dir;
	throw new SubagentSteerError("unknown-run", `No pi-subagents run found with id ${runId}`);
}

function validateRunId(runId: unknown): string {
	if (
		typeof runId !== "string" ||
		runId.length === 0 ||
		/\s/.test(runId) ||
		runId.includes("/") ||
		runId.includes("\\")
	) {
		throw new SubagentSteerError("invalid-run-id", "runId must be a non-empty run directory name");
	}
	return runId;
}

function validateMessage(message: unknown): string {
	if (typeof message !== "string") {
		throw new SubagentSteerError("invalid-message", "message must be a string");
	}
	if (message.trim().length === 0) {
		throw new SubagentSteerError("invalid-message", "message must not be empty");
	}
	if (Buffer.byteLength(message, "utf-8") > MAX_STEER_MESSAGE_BYTES) {
		throw new SubagentSteerError("invalid-message", `message exceeds ${MAX_STEER_MESSAGE_BYTES} bytes`);
	}
	return message;
}

function validateMode(mode: unknown): SteerDeliveryMode | undefined {
	if (mode === undefined || mode === null) return undefined;
	if (typeof mode !== "string" || !(STEER_DELIVERY_MODES as readonly string[]).includes(mode)) {
		throw new SubagentSteerError("invalid-mode", `mode must be one of ${STEER_DELIVERY_MODES.join(", ")}`);
	}
	return mode as SteerDeliveryMode;
}

function validateRequestId(id: string): string {
	if (typeof id !== "string" || id.length === 0 || /\s/.test(id) || id.length > MAX_STEER_REQUEST_ID_LENGTH) {
		throw new SubagentSteerError("invalid-request-id", "requestId must be a non-empty token (<= 256 chars)");
	}
	return id;
}

/** Atomic JSON write (writeJsonToExistingDir in the protocol source): tmp + rename. */
function writeJsonFile(filePath: string, payload: Record<string, unknown>): void {
	const dir = dirname(filePath);
	const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	try {
		writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: "utf-8", flag: "wx" });
		renameSync(tempPath, filePath);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

interface AckRecord {
	requestId?: unknown;
	state?: unknown;
	message?: unknown;
	ts?: unknown;
}

/**
 * Newest ack record matching `keep`, reading every
 * `control/steer-acks/<index>/*.json` file (the runner's watcher may already
 * have consumed and deleted some — absence is normal).
 */
function readLatestAck(runDir: string, keep: (record: AckRecord) => boolean): SteerAckInfo | undefined {
	let indexDirs: string[];
	try {
		indexDirs = readdirSync(steerAcksDir(runDir)).filter((name) => /^\d+$/.test(name));
	} catch {
		return undefined;
	}
	let best: SteerAckInfo | undefined;
	let bestTs = Number.NEGATIVE_INFINITY;
	for (const index of indexDirs) {
		let files: string[];
		try {
			files = readdirSync(join(steerAcksDir(runDir), index)).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				const parsed = JSON.parse(readFileSync(join(steerAcksDir(runDir), index, file), "utf-8")) as AckRecord;
				if (!parsed || typeof parsed !== "object") continue;
				if (!keep(parsed)) continue;
				const state = typeof parsed.state === "string" ? parsed.state : undefined;
				if (state === undefined) continue;
				const ts = typeof parsed.ts === "number" ? parsed.ts : Number.NEGATIVE_INFINITY;
				if (ts < bestTs) continue;
				bestTs = ts;
				best = {
					state,
					message: typeof parsed.message === "string" ? parsed.message : undefined,
					ts: typeof parsed.ts === "number" ? parsed.ts : undefined,
				};
			} catch {
				// Junk ack files are skipped; the watcher cleans files as it consumes.
			}
		}
	}
	return best;
}

/** Newest ack record answering one request id. */
export function readAckForRequest(runDir: string, requestId: string): SteerAckInfo | undefined {
	return readLatestAck(runDir, (record) => record.requestId === requestId);
}

/**
 * subagent_steer: drop a steering request into the run's control inbox.
 * Pure-options object keeps the web-command layer thin; tests may inject
 * roots, a deterministic requestId, and the ack probe delay.
 */
export function steerSubagentRun(options: {
	runId: unknown;
	message: unknown;
	mode?: unknown;
	roots?: string[];
	requestId?: string;
	ackCheckDelayMs?: number;
}): SteerResult {
	const runId = validateRunId(options.runId);
	const message = validateMessage(options.message);
	const mode = validateMode(options.mode);
	const runDir = findRunDir(runId, options.roots);
	if (existsSync(steerInboxClosedPath(runDir))) {
		throw new SubagentSteerError(
			"inbox-closed",
			`Run ${runId} is no longer accepting steering requests (inbox closed)`,
		);
	}
	const requestId =
		options.requestId !== undefined ? validateRequestId(options.requestId) : `web-${Date.now()}-${randomUUID()}`;
	const ts = Date.now();
	const request: Record<string, unknown> = { type: "steer", id: requestId, ts, message };
	if (mode !== undefined) request.mode = mode;
	request.source = "pi-web";
	const requestPath = join(steerRequestsDir(runDir), steerRequestFileName(ts, requestId));
	// The runner tolerates a missing inbox dir, but we create it for the
	// rename-based atomic write (joining our own convention dir is safe).
	mkdirSync(steerRequestsDir(runDir), { recursive: true });
	writeJsonFile(requestPath, request);
	const delayMs = options.ackCheckDelayMs ?? 100;
	if (delayMs > 0) {
		// Small settle window for a runner that consumed instantly (fs.watch).
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delayMs, 1000));
	}
	const ack = readAckForRequest(runDir, requestId);
	return {
		delivered: ack?.state === "delivered" ? "delivered" : "queued",
		...(ack !== undefined ? { ack } : {}),
		requestId,
		runDir,
		requestPath,
	};
}

/**
 * subagent_stop: write the portable stop request the runner consumes on its
 * next inbox sweep (5s safety poll worst-case, usually immediate via fs.watch).
 */
export function stopSubagentRun(options: { runId: unknown; reason?: unknown; roots?: string[] }): StopResult {
	const runId = validateRunId(options.runId);
	let reason: string | undefined;
	if (options.reason !== undefined && options.reason !== null) {
		if (typeof options.reason !== "string") {
			throw new SubagentSteerError("invalid-reason", "reason must be a string");
		}
		reason = options.reason.trim() || undefined;
	}
	const runDir = findRunDir(runId, options.roots);
	const payload: Record<string, unknown> = { type: "stop", ts: Date.now(), source: "pi-web" };
	if (reason !== undefined) payload.reason = reason;
	const stopPath = stopRequestPath(runDir);
	// The runner tolerates a missing control dir, but an atomic rename needs
	// the destination directory to exist before the tmp file lands.
	mkdirSync(controlInboxDir(runDir), { recursive: true });
	writeJsonFile(stopPath, payload);
	return { delivered: "requested", runDir, stopPath };
}
