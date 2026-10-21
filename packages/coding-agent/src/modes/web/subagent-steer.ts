/**
 * subagent_steer / subagent_stop: write control requests into a running
 * pi-subagents run's on-disk inbox (web console batch-4, owner request:
 * steer + stop subagents from the Subagents card modal).
 *
 * Protocol source (verified against pi-subagents v0.61.0,
 * node_modules/pi-subagents/src/runs/background/control-channel.ts and
 * src/runs/foreground/workflow-foreground-steering.ts):
 * - ASYNC runs (detached `subagent-runner` process) own a control inbox at
 *   `<asyncDir>/control/`. Steering: drop a JSON request file into
 *   `control/steer-requests/` named `${String(ts).padStart(13, "0")}-${base64url(id)}.json`
 *   with the shape `{ type: "steer", id, ts, message, mode?, targetIndex?, source? }`.
 *   `targetIndex` addresses one workflow child (the runner forwards it via
 *   enqueueStepSteer); without it the runner routes to every running child.
 *   Acks land in `control/steer-acks/<index>/<file>.json` with state
 *   "delivered" | "queued" | "failed". The runner's watcher consumes (deletes)
 *   ack files as it reads them — absence is normal, not an error.
 * - SYNC workflow children (in-process in the master Pi) have NO top-level
 *   inbox watcher; instead the master registers a per-child steering route at
 *   `<asyncDir>/control/workflow-foreground/<childId>/` while the child is
 *   live (removed when it ends). The route owns `steer-targets/<index>/`,
 *   `steer-capabilities/<index>.json`, and `steer-acks/<index>/` — the same
 *   file protocol `steerWorkflowForegroundTarget` uses, so the web layer can
 *   steer live in-process children purely through files.
 * - Stopping: `{ type: "stop", ts?, source?, reason?, targetIndex?, childId? }`
 *   into `control/stop.json` (the portable single-run request file the
 *   runner's `consumeStopRequestPayloads` reads as its legacy path).
 *   targetIndex/childId stop one child. Sync children are only stoppable through
 *   in-memory controls the web cannot reach — that combination answers with an
 *   honest error instead of a dead letter..
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { discoverSubagentRunRoots, workflowForegroundRouteDir } from "./subagent-status.ts";

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
	/** Workflow child the request targeted (child rows only). */
	childId?: string;
	/** Step index the request targeted (child rows only). */
	index?: number;
}

export interface StopResult {
	/** Always "requested" on success — the runner consumes stop.json asynchronously. */
	delivered: "requested";
	runDir: string;
	stopPath: string;
	/** Workflow child the stop targeted (child stops only). */
	childId?: string;
	/** Step index the stop targeted (child stops only). */
	index?: number;
}

/**
 * Find a run directory by run id. Resolution walks the run ROOT directories
 * and matches directory NAMES — it deliberately does NOT reuse the subagent_status
 * row projection, because that projection expands workflow runs into per-child
 * rows and no longer carries a row for the parent directory. The scan lists
 * real directories, so a match only happens for an id that literally names a
 * run dir (no traversal).
 */
export function findRunDir(runId: string, roots?: string[]): string {
	const scanRoots = roots !== undefined ? roots : discoverSubagentRunRoots();
	for (const root of scanRoots) {
		try {
			const entry = join(root, runId);
			if (existsSync(entry) && statSync(entry).isDirectory()) return entry;
		} catch {
			// Junk/unreadable roots are skipped.
		}
	}
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

/** Child run-id validation — same charset constraints as run ids: the child id
 * names a directory inside the run's control tree, so traversal is rejected. */
function validateChildId(childId: unknown): string {
	if (
		typeof childId !== "string" ||
		childId.length === 0 ||
		/\s/.test(childId) ||
		childId.includes("/") ||
		childId.includes("\\") ||
		childId.length > 256
	) {
		throw new SubagentSteerError("invalid-child-id", "childId must be a non-empty child run id (<= 256 chars)");
	}
	return childId;
}

/** Steer-target step index validation (targetIndex contract: 0..1_000_000). */
function validateIndex(index: unknown): number {
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 1_000_000) {
		throw new SubagentSteerError("invalid-index", "index must be an integer between 0 and 1000000");
	}
	return index;
}

interface JsonRecord {
	[key: string]: unknown;
}

/** Best-effort status.json read for run-level state and step lookup. */
function readRunStatusJson(runDir: string): JsonRecord | undefined {
	try {
		if (!existsSync(join(runDir, "status.json"))) return undefined;
		const parsed = JSON.parse(readFileSync(join(runDir, "status.json"), "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as JsonRecord;
	} catch {
		return undefined;
	}
}

/** Step index of a workflow child by its run id; throws unknown-child. */
function findChildIndex(runDir: string, childId: string): number {
	const status = readRunStatusJson(runDir);
	const steps = Array.isArray(status?.steps) ? (status.steps as unknown[]) : [];
	for (let index = 0; index < steps.length; index += 1) {
		const raw = steps[index];
		const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonRecord) : undefined;
		if (record && typeof record.runId === "string" && record.runId === childId) return index;
	}
	throw new SubagentSteerError("unknown-child", `Run ${basename(runDir)} has no child with id ${childId}`);
}

/** Honest-state gate for the top-level inbox: a finished run never consumes. */
function assertRunSteerable(runDir: string): void {
	const status = readRunStatusJson(runDir);
	const state = typeof status?.state === "string" ? (status.state as string) : undefined;
	if (state !== undefined && state !== "running" && state !== "queued") {
		throw new SubagentSteerError("not-running", `Run ${basename(runDir)} is ${state} and no longer accepts steering`);
	}
}

/** Ack poll sleep for the sync steering route.
 *
 * A sync child may live in the SAME event loop (in-process children watch
 * their inbox via fs.watch), so the wait must yield — Atomics.wait would
 * starve the very consumer the request waits for. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** writeSteerAck widens the file name with a ` -<ts>-<order>-<state>` suffix;
 * scan all *.json. The consumer cleans files downstream, junk is skipped. */
function readLatestAckFlat(dir: string, requestId: string): SteerAckInfo | undefined {
	let files: string[];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return undefined;
	}
	for (const file of files) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as AckRecord;
			if (!parsed || typeof parsed !== "object") continue;
			if (parsed.requestId !== requestId) continue;
			const state = typeof parsed.state === "string" ? parsed.state : undefined;
			if (state === undefined) continue;
			return {
				state,
				message: typeof parsed.message === "string" ? parsed.message : undefined,
				ts: typeof parsed.ts === "number" ? parsed.ts : undefined,
			};
		} catch {
			// Junk ack files are skipped; the watcher cleans files as it consumes.
		}
	}
	return undefined;
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

/** Steer capability record the child runtime drops next to its inbox. */
function readSyncRouteCapability(routeDir: string, index: number): { supported?: boolean } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(routeDir, "steer-capabilities", `${index}.json`), "utf-8")) as Record<
			string,
			unknown
		>;
		if (!parsed || typeof parsed !== "object") return undefined;
		return {
			...(typeof parsed.supported === "boolean" ? { supported: parsed.supported } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * subagent_steer: steer a whole run or one workflow child.
 *
 * Child routing (childId given):
 * - live in-process route → write into `workflow-foreground/<childId>/steer-targets/<index>`
 *   and wait for the child ack (≤ syncAckWaitMs); a vanishing route is an honest error.
 * - otherwise → detached-runner path: top-level inbox request WITH targetIndex.
 *
 * Pure-options object keeps the web-command layer thin; tests may inject
 * roots, a deterministic requestId, and the ack wait windows.
 */
export async function steerSubagentRun(options: {
	runId: unknown;
	message: unknown;
	mode?: unknown;
	/** Workflow child target — when given, the request is routed to that child. */
	childId?: unknown;
	/** Optional explicit step index (status.json steps[] position). */
	index?: unknown;
	roots?: string[];
	requestId?: string;
	/** Top-level settle window for a detached-runner ack (ms, default 100, max 1000). */
	ackCheckDelayMs?: number;
	/** Sync-route ack window (ms, default 3000). */
	syncAckWaitMs?: number;
	/** Sync-route poll cadence (ms, default 50). */
	syncAckPollMs?: number;
}): Promise<SteerResult> {
	const runId = validateRunId(options.runId);
	const message = validateMessage(options.message);
	const mode = validateMode(options.mode);
	const childId =
		options.childId !== undefined && options.childId !== null ? validateChildId(options.childId) : undefined;
	const explicitIndex =
		options.index !== undefined && options.index !== null ? validateIndex(options.index) : undefined;
	const runDir = findRunDir(runId, options.roots);
	let index = explicitIndex;
	if (childId !== undefined) {
		index = index ?? findChildIndex(runDir, childId);
	}
	const requestId =
		options.requestId !== undefined ? validateRequestId(options.requestId) : `web-${Date.now()}-${randomUUID()}`;
	const ts = Date.now();
	const request: Record<string, unknown> = { type: "steer", id: requestId, ts, message };
	if (mode !== undefined) request.mode = mode;
	request.source = "pi-web";
	if (index !== undefined) request.targetIndex = index;

	if (childId !== undefined && existsSync(workflowForegroundRouteDir(runDir, childId))) {
		return steerSyncRouteChild({ runDir, childId, index, request, requestId, options });
	}
	return topInboxSteer();

	async function topInboxSteer(): Promise<SteerResult> {
		if (existsSync(steerInboxClosedPath(runDir))) {
			throw new SubagentSteerError(
				"inbox-closed",
				`Run ${runId} is no longer accepting steering requests (inbox closed)`,
			);
		}
		assertRunSteerable(runDir);
		const requestPath = join(steerRequestsDir(runDir), steerRequestFileName(ts, requestId));
		// The runner tolerates a missing inbox dir, but we create it for the
		// rename-based atomic write (joining our own convention dir is safe).
		mkdirSync(steerRequestsDir(runDir), { recursive: true });
		writeJsonFile(requestPath, request);
		const delayMs = options.ackCheckDelayMs ?? 100;
		if (delayMs > 0) {
			// Small settle window for a runner that consumed instantly (fs.watch).
			await sleep(Math.min(delayMs, 1000));
		}
		const ack = readAckForRequest(runDir, requestId);
		return {
			delivered: ack?.state === "delivered" ? "delivered" : "queued",
			...(ack !== undefined ? { ack } : {}),
			requestId,
			runDir,
			requestPath,
			...(childId !== undefined ? { childId } : {}),
			...(index !== undefined ? { index } : {}),
		};
	}
}

/** Sync (in-process) workflow child: per-child route inbox + ack window. */
async function steerSyncRouteChild(input: {
	runDir: string;
	childId: string;
	index: number | undefined;
	request: Record<string, unknown>;
	requestId: string;
	options: { syncAckWaitMs?: number; syncAckPollMs?: number };
}): Promise<SteerResult> {
	const { runDir, childId, request, requestId, options } = input;
	const index = input.index ?? findChildIndex(runDir, childId);
	const routeDir = workflowForegroundRouteDir(runDir, childId);
	const capability = readSyncRouteCapability(routeDir, index);
	if (capability?.supported === false) {
		throw new SubagentSteerError("child-not-steerable", `Child ${childId} does not support steering`);
	}
	const inboxDir = join(routeDir, "steer-targets", String(index));
	const requestPath = join(inboxDir, steerRequestFileName(request.ts as number, requestId));
	mkdirSync(inboxDir, { recursive: true });
	writeJsonFile(requestPath, request);
	const pollMs = Math.max(1, options.syncAckPollMs ?? 50);
	const waitMs = Math.max(0, options.syncAckWaitMs ?? 3_000);
	const deadline = Date.now() + waitMs;
	let ack: SteerAckInfo | undefined;
	while (true) {
		if (!existsSync(routeDir)) {
			throw new SubagentSteerError(
				"child-not-live",
				`Child ${childId} is no longer live in run ${basename(runDir)} (steering route closed)`,
			);
		}
		ack = readLatestAckFlat(join(routeDir, "steer-acks", String(index)), requestId);
		if (ack !== undefined || Date.now() >= deadline) break;
		await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
	return {
		delivered: ack?.state === "delivered" ? "delivered" : "queued",
		...(ack !== undefined ? { ack } : {}),
		requestId,
		runDir,
		requestPath,
		childId,
		index,
	};
}

/**
 * subagent_stop: write the portable stop request the detached runner consumes
 * on its next inbox sweep (5s safety poll worst-case, usually immediate).
 * A childId targets one workflow child (targetIndex + childId in the payload);
 * stopping an in-process (sync) child is refused honestly — no file consumer.
 */
export function stopSubagentRun(options: {
	runId: unknown;
	reason?: unknown;
	childId?: unknown;
	index?: unknown;
	roots?: string[];
}): StopResult {
	const runId = validateRunId(options.runId);
	const childId =
		options.childId !== undefined && options.childId !== null ? validateChildId(options.childId) : undefined;
	const explicitIndex =
		options.index !== undefined && options.index !== null ? validateIndex(options.index) : undefined;
	let reason: string | undefined;
	if (options.reason !== undefined && options.reason !== null) {
		if (typeof options.reason !== "string") {
			throw new SubagentSteerError("invalid-reason", "reason must be a string");
		}
		reason = options.reason.trim() || undefined;
	}
	const runDir = findRunDir(runId, options.roots);
	let index = explicitIndex;
	if (childId !== undefined) {
		index = index ?? findChildIndex(runDir, childId);
		if (existsSync(workflowForegroundRouteDir(runDir, childId))) {
			throw new SubagentSteerError(
				"sync-child-stop-unsupported",
				`Child ${childId} runs in-process; stop it via the parent workflow run ${runId} instead`,
			);
		}
	}
	const payload: Record<string, unknown> = { type: "stop", ts: Date.now(), source: "pi-web" };
	if (reason !== undefined) payload.reason = reason;
	if (index !== undefined) payload.targetIndex = index;
	if (childId !== undefined) payload.childId = childId;
	const stopPath = stopRequestPath(runDir);
	// The runner tolerates a missing control dir, but an atomic rename needs
	// the destination directory to exist before the tmp file lands.
	mkdirSync(controlInboxDir(runDir), { recursive: true });
	writeJsonFile(stopPath, payload);
	return {
		delivered: "requested",
		runDir,
		stopPath,
		...(childId !== undefined ? { childId } : {}),
		...(index !== undefined ? { index } : {}),
	};
}
