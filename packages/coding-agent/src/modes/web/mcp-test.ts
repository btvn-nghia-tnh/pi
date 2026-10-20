/**
 * mcp_test: probe whether a configured MCP server is connectable (web
 * console MCP page, user issue batch 4).
 *
 * Locates the server definition like mcp_config_list does — the project Pi
 * override layer `<cwd>/.pi/mcp.json`, else the pi global `<agentDir>/mcp.json`
 * — and probes it WITHOUT importing pi-mcp-adapter:
 *
 * - http (definition.url): POSTs a minimal MCP JSON-RPC `initialize` request
 *   with a 5s abort budget, carrying definition headers. Any 2xx counts as a
 *   handshake; 401/403 = reachable-but-auth-required; other statuses are
 *   reachable-but-not-ok; network/DNS/TLS errors are unreachable.
 * - stdio (definition.command): spawns the process, writes the `initialize`
 *   request as one JSON line, and waits up to the timeout for a response line
 *   with `id === 1`. On handshake it sends `notifications/initialized` plus a
 *   `tools/list` request and — when the server answers — reports the tool
 *   count. A non-zero exit before any handshake output fails fast with
 *   `exited <code>`; a silent child (timeout, or death without a response)
 *   fails with `no handshake response`.
 *
 * The probe never enables, disables, or persists anything; the child process
 * is always terminated (SIGTERM). Every probe owns its own state, so
 * concurrent probes are safe.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { PROJECT_CONFIG_FILE, readRawConfig, serversOf } from "./mcp-config-write.ts";

export class McpTestError extends Error {
	override readonly name = "McpTestError";
}

export interface McpTestResult {
	/** True when the full MCP handshake (and optional tools/list) succeeded. */
	ok: boolean;
	/** Something is listening (auth failures and HTTP errors still are). */
	reachable?: boolean;
	/** The server is up but demands authentication. */
	authRequired?: boolean;
	/** HTTP status observed on the http probe. */
	httpStatus?: number;
	/** Tool count from the stdio tools/list phase, when it answered. */
	toolCount?: number;
	/** Human summary, shown on the MCP card. */
	detail: string;
	/** Wall-clock milliseconds spent inside the probe. */
	latencyMs: number;
}

export interface McpTestOptions {
	/** Server name (key inside the servers map). */
	server: string;
	/** Scope the UI saw the entry in; the probe still falls back project→global. */
	scope?: "project" | "global";
	/** Project directory; falls back to the session cwd when omitted. */
	cwd?: string;
	/** Agent dir hosting the pi global config; defaults to getAgentDir(). */
	agentDir?: string;
	/** Internal probe budget (handshake phase); default 5000 ms. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** Grace window for classifying an early non-zero child exit as a crash. */
const FAST_EXIT_WINDOW_MS = 1500;
/** Extra budget for the optional tools/list phase after a handshake. */
const TOOLS_PHASE_MS = 3000;

/** A minimal MCP initialize request, identical for both transports. */
const INITIALIZE_REQUEST = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "pi-web-probe", version: "1.0" },
	},
} as const;

const TOOLS_REQUEST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as const;
const INITIALIZED_NOTIFICATION = { jsonrpc: "2.0", method: "notifications/initialized" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Locate the server definition: project layer first (when a cwd is given), else global. */
function findDefinition(options: McpTestOptions): {
	definition: Record<string, unknown>;
	foundIn: string;
} {
	if (typeof options.server !== "string" || options.server.trim().length === 0) {
		throw new McpTestError("mcp_test: server must be a non-empty string");
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const projectPath = join(options.cwd ?? "", ".pi", PROJECT_CONFIG_FILE);
	const globalPath = join(agentDir, PROJECT_CONFIG_FILE);
	const candidates: string[] = [];
	if (typeof options.cwd === "string" && options.cwd.length > 0) {
		candidates.push(projectPath);
	}
	candidates.push(globalPath);

	// Find the first candidate whose config actually defines the server; the
	// named scope picks the start of the search, the other layer backs it up.
	if (options.scope === "global") candidates.reverse();

	for (const path of candidates) {
		const raw = readRawConfig(path);
		if (!raw) continue;
		const definition = serversOf(raw)[options.server];
		if (definition === undefined) continue;
		if (isRecord(definition)) return { definition, foundIn: path };
		throw new McpTestError(`server "${options.server}" in ${path} must be an object`);
	}
	throw new McpTestError(`server "${options.server}" is not configured`);
}

// ---------------------------------------------------------------------
// http probe
// ---------------------------------------------------------------------

async function probeHttp(
	url: string,
	definitionHeaders: unknown,
	timeoutMs: number,
): Promise<Omit<McpTestResult, "latencyMs">> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = {};
		if (isRecord(definitionHeaders)) {
			for (const [key, value] of Object.entries(definitionHeaders)) {
				if (typeof value === "string") headers[key] = value;
			}
		}
		headers["Content-Type"] = "application/json";
		headers.Accept = "application/json";
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(INITIALIZE_REQUEST),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return {
				ok: false,
				reachable: true,
				authRequired: true,
				httpStatus: response.status,
				detail: "reachable — authentication required",
			};
		}
		if (response.status < 200 || response.status >= 300) {
			return { ok: false, reachable: true, httpStatus: response.status, detail: `HTTP ${response.status}` };
		}
		return { ok: true, reachable: true, httpStatus: response.status, detail: "handshake ok" };
	} catch (error) {
		const aborted = controller.signal.aborted;
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reachable: false, detail: aborted ? `probe timed out after ${timeoutMs}ms` : message.trim() };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------
// stdio probe
// ---------------------------------------------------------------------

/** Feed complete `\n`-terminated lines off a stream to a replaceable handler. */
function pipeLines(stream: NodeJS.ReadableStream | null | undefined): { onLine(next: (line: string) => void): void } {
	let handler: ((line: string) => void) | undefined;
	let buffer = "";
	if (stream) {
		stream.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (handler) handler(line);
				newlineIndex = buffer.indexOf("\n");
			}
		});
	}
	return {
		onLine(next) {
			handler = next;
		},
	};
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The resolved phase outcome for the stdio handshake. */
type HandshakeOutcome =
	| { kind: "ok"; response: Record<string, unknown> }
	| { kind: "timeout" }
	| { kind: "exit"; code: number | null; crashedFast: boolean; spawnError?: string };

/** Await exactly one event among: handshake line, timeout, child exit. */
function awaitHandshake(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<HandshakeOutcome> {
	return new Promise<HandshakeOutcome>((resolve) => {
		const startedAt = Date.now();
		let done = false;
		const settle = (outcome: HandshakeOutcome): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
			lineRouter.onLine(() => {});
			resolve(outcome);
		};
		const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
		const onExit = (code: number | null): void => {
			// A crash before any handshake output fails fast; any other death
			// without a response is silent — settle without burning the timer.
			const elapsed = Date.now() - startedAt;
			const crashedFast = code !== null && code !== 0 && elapsed <= FAST_EXIT_WINDOW_MS;
			settle({ kind: "exit", code, crashedFast });
		};
		child.once("exit", onExit);
		// ENOENT and friends surface as 'error' WITHOUT 'exit' — without this
		// listener a bad command would crash the process as an uncaught error.
		const onError = (error: Error): void => {
			settle({ kind: "exit", code: null, crashedFast: false, spawnError: error.message });
		};
		child.once("error", onError);
		const lineRouter = pipeLines(child.stdout);
		lineRouter.onLine((line) => {
			const parsed = parseJsonLine(line);
			if (parsed?.id === 1) settle({ kind: "ok", response: parsed });
		});
	});
}

/** Await the tools/list result (bonus phase); resolves {} on miss. */
function awaitTools(child: ReturnType<typeof spawn>, waitMs: number): Promise<{ count?: number }> {
	return new Promise<{ count?: number }>((resolve) => {
		let done = false;
		const settle = (value: { count?: number }): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			toolsRouter.onLine(() => {});
			resolve(value);
		};
		const timer = setTimeout(() => settle({}), waitMs);
		const toolsRouter = pipeLines(child.stdout);
		toolsRouter.onLine((line) => {
			const parsed = parseJsonLine(line);
			if (parsed?.id !== 2) return;
			const result = parsed.result;
			if (isRecord(result) && Array.isArray(result.tools)) settle({ count: result.tools.length });
			else settle({});
		});
	});
}

async function probeStdio(
	command: string,
	args: string[],
	definitionEnv: unknown,
	timeoutMs: number,
): Promise<Omit<McpTestResult, "latencyMs">> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (isRecord(definitionEnv)) {
		for (const [key, value] of Object.entries(definitionEnv)) {
			if (typeof value === "string") env[key] = value;
		}
	}

	const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.setEncoding("utf-8");

	const killChild = (): void => {
		try {
			child.kill("SIGTERM");
		} catch {
			// Already dead — nothing to do.
		}
	};
	process.once("exit", killChild);

	try {
		child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
	} catch {
		// The child died before we could even ask — fall through to the exit path.
	}

	const handshake = await awaitHandshake(child, timeoutMs);

	if (handshake.kind === "exit") {
		const detail = handshake.spawnError
			? `error: ${handshake.spawnError}`
			: handshake.crashedFast
				? `exited ${handshake.code}`
				: "no handshake response";
		process.removeListener("exit", killChild);
		return { ok: false, detail };
	}
	if (handshake.kind === "timeout") {
		killChild();
		process.removeListener("exit", killChild);
		return { ok: false, detail: "no handshake response" };
	}

	// Handshake ok — bonus phase: notifications/initialized + tools/list.
	try {
		child.stdin.write(`${JSON.stringify(INITIALIZED_NOTIFICATION)}\n`);
		child.stdin.write(`${JSON.stringify(TOOLS_REQUEST)}\n`);
	} catch {
		// Child died post-handshake; the handshake itself already succeeded.
	}
	const tools = await awaitTools(child, Math.min(TOOLS_PHASE_MS, timeoutMs + TOOLS_PHASE_MS));

	killChild();
	process.removeListener("exit", killChild);
	if (tools.count !== undefined) {
		return { ok: true, reachable: true, toolCount: tools.count, detail: `${tools.count} tools` };
	}
	return { ok: true, reachable: true, detail: "handshake ok" };
}

// ---------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------

/** Probe one configured MCP server end-to-end. Never mutates config. */
export async function testMcpServer(options: McpTestOptions): Promise<McpTestResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const { definition } = findDefinition(options);

	const url = typeof definition.url === "string" ? definition.url.trim() : undefined;
	const command = typeof definition.command === "string" ? definition.command.trim() : undefined;
	if (!url && !command) {
		throw new McpTestError(`server "${options.server}" has no url or command to probe`);
	}

	const startedAt = Date.now();
	const result = url
		? await probeHttp(url, definition.headers, timeoutMs)
		: await probeStdio(
				command!,
				Array.isArray(definition.args)
					? definition.args.filter((arg): arg is string => typeof arg === "string")
					: [],
				definition.env,
				timeoutMs,
			);
	return { ...result, latencyMs: Date.now() - startedAt };
}
