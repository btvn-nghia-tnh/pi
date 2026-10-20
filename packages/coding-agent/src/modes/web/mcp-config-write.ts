/**
 * mcp_config_write: persist enable/disable for one MCP server (web console MCP
 * page fallback, spec §6.2).
 *
 * Mirrors the pi-mcp-adapter config conventions (investigated from
 * pi-mcp-adapter/config.ts — see the task report for the discovery table):
 * - Configs are `{ mcpServers: { <name>: { ...definition, disabled?: true } } }`
 *   (the legacy `mcp-servers` key is tolerated on read and preserved on write;
 *   written files keep whichever key the file already used).
 * - ONLY the literal boolean `true` disables a server; absent === enabled.
 * - The canonical write layer is the PROJECT PI OVERRIDE:
 *   `<cwd>/.pi/mcp.json` — the same layer the adapter's own
 *   writeProjectServerDisabledOverride uses. Nothing but the `disabled` field
 *   is ever written there; server definitions and credentials are never copied.
 * - Disabling writes `{ disabled: true }` (merged over any existing override
 *   fields). Enabling REMOVES the disabled flag, unless a lower-precedence
 *   source (generic global, agents global, pi global, or project `.mcp.json`)
 *   carries `disabled: true` for the server — then an explicit `false` is
 *   pinned. (The adapter additionally expands import-style configs like
 *   opencode/cursor for this check; that machinery is out of scope for the
 *   v1 fallback — documented as a residual simplification.)
 * - Writes are atomic (tmp file + rename) with `JSON.stringify(raw, null, 2)`.
 *
 * Safety guard: the command refuses (McpConfigWriteError) when NO known MCP
 * config exists anywhere — so a stray call cannot materialize config
 * skeletons in a project that has none.
 *
 * Changes apply when the adapter reloads config (next session start).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";

/** File name of both the project-standard config and the pi override layer. */
const PROJECT_CONFIG_FILE = "mcp.json";
/** Project-standard MCP config (discovered by hosts and the adapter). */
const PROJECT_STANDARD_NAME = ".mcp.json";

export class McpConfigWriteError extends Error {
	override readonly name = "McpConfigWriteError";
}

export interface McpConfigWriteOptions {
	/** Project directory (session cwd). The pi override layer lives beneath it. */
	cwd: string;
	/** Agent dir hosting the pi global override; defaults to getAgentDir(). */
	agentDir?: string;
	/** Home dir override for the generic/agents global discovery paths (tests). */
	homeDir?: string;
}

/** Expand options for deterministic path computation. */
function resolvedPaths(options: McpConfigWriteOptions) {
	const home = options.homeDir ?? homedir();
	const agentDir = options.agentDir ?? getAgentDir();
	const piLayerPath = join(options.cwd, ".pi", PROJECT_CONFIG_FILE);
	return {
		home,
		piLayerPath,
		/** Lower-precedence discovery sources used for the guard + enable math. */
		lowerSources: [
			join(home, ".config", "mcp", "mcp.json"),
			join(home, ".agents", "mcp.json"),
			join(home, ".agents", "mcp", "mcp.json"),
			join(agentDir, PROJECT_CONFIG_FILE),
			join(options.cwd, PROJECT_STANDARD_NAME),
		],
	};
}

/** Parse a config file tolerantly; `null` when absent or unreadable. */
function readRawConfig(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** The servers map of a config; tolerates both key spellings. */
function serversOf(raw: Record<string, unknown>): Record<string, unknown> {
	const servers = raw.mcpServers ?? raw["mcp-servers"];
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
	return servers as Record<string, unknown>;
}

/** Read the pi layer strictly (malformed file is a hard error, not a skip). */
function readOverrideLayer(piLayerPath: string): Record<string, unknown> {
	if (!existsSync(piLayerPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(piLayerPath, "utf-8"));
	} catch (error) {
		throw new McpConfigWriteError(
			`Failed to read project MCP override at ${piLayerPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new McpConfigWriteError(
			`Failed to read project MCP override at ${piLayerPath}: root value must be an object`,
		);
	}
	return parsed as Record<string, unknown>;
}

/** Atomic 2-space JSON write (tmp + rename), mirrors the adapter writer. */
function writeRawConfigObject(path: string, raw: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, path);
}

export interface McpConfigWriteResult {
	/** The file that was (or would be) written — always the project pi layer. */
	path: string;
	/** False when the requested state was already persisted (file untouched). */
	changed: boolean;
}

/**
 * Persist the enabled/disabled state of one MCP server in the project pi
 * override layer. Throws McpConfigWriteError on absent configs, malformed
 * override files, or invalid arguments.
 */
export async function writeMcpServerEnabled(
	server: string,
	enabled: boolean,
	options: McpConfigWriteOptions,
): Promise<McpConfigWriteResult> {
	if (typeof server !== "string" || server.trim().length === 0) {
		throw new McpConfigWriteError("mcp_config_write: server must be a non-empty string");
	}
	const { piLayerPath, lowerSources } = resolvedPaths(options);

	// Guard: refuse to invent configs when none exist anywhere.
	if (!existsSync(piLayerPath) && !lowerSources.some(existsSync)) {
		throw new McpConfigWriteError(`No MCP config found (looked in ${[piLayerPath, ...lowerSources].join(", ")})`);
	}

	const raw = readOverrideLayer(piLayerPath);
	const serverKey =
		raw.mcpServers !== undefined ? "mcpServers" : raw["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
	const rawServers = raw[serverKey];
	if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) {
		throw new McpConfigWriteError(
			`Failed to update project MCP override at ${piLayerPath}: ${serverKey} must be an object`,
		);
	}
	const servers = (rawServers ?? {}) as Record<string, unknown>;
	const previous = servers[server];
	if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
		throw new McpConfigWriteError(
			`Failed to update project MCP override at ${piLayerPath}: server "${server}" must be an object`,
		);
	}
	const existing = previous as Record<string, unknown> | undefined;

	let next: Record<string, unknown>;
	if (!enabled) {
		next = { ...existing, disabled: true };
	} else {
		next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
		// Pin an explicit false only when a lower-precedence source disables it.
		const lowerDisabled = lowerSources.some((path) => {
			const lower = readRawConfig(path);
			const entry = lower ? serversOf(lower)[server] : undefined;
			return (entry as { disabled?: unknown } | undefined)?.disabled === true;
		});
		if (lowerDisabled) next.disabled = false;
	}

	if ((!existing && Object.keys(next).length === 0) || JSON.stringify(existing) === JSON.stringify(next)) {
		return { path: piLayerPath, changed: false };
	}

	if (Object.keys(next).length === 0) delete servers[server];
	else servers[server] = next;

	raw[serverKey] = servers;
	writeRawConfigObject(piLayerPath, raw);
	return { path: piLayerPath, changed: true };
}
