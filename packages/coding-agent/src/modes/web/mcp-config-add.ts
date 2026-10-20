/**
 * mcp_config_add: persist a NEW MCP server definition (web console MCP page,
 * user issue batch 2).
 *
 * Scope layers (mirrors mcp-config-write.ts conventions — the same layer the
 * pi-mcp-adapter discovers):
 * - "project" → the project Pi override layer `<cwd>/.pi/mcp.json`
 * - "global"  → the pi agent global `<agentDir>/mcp.json`
 *
 * The written entry mirrors the user-suppliable subset of the adapter's
 * ServerEntry shape (pi-mcp-adapter/types.ts): stdio servers carry
 * `command` / `args?` / `env?`, http servers carry `url` / `headers?`, and any
 * server may carry `disabled`. Validation enforces exactly one transport:
 * `url` (http) xor `command` (stdio).
 *
 * Unlike mcp_config_write (which refuses to materialize configs), ADD creates
 * its target file when absent — that is its purpose. A duplicate server name
 * in the chosen scope is a hard error ("already exists"). Malformed target
 * files are hard errors, never silently replaced.
 *
 * Writes are atomic (tmp + rename) with `JSON.stringify(raw, null, 2)` and a
 * trailing newline, preserving the file's existing servers key spelling
 * (`mcpServers` preferred; legacy `mcp-servers` kept when the file used it).
 *
 * Changes apply when the adapter reloads config (next session start).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { PROJECT_CONFIG_FILE, writeRawConfigObject } from "./mcp-config-write.ts";

export class McpConfigAddError extends Error {
	override readonly name = "McpConfigAddError";
}

/** User-suppliable subset of the adapter's ServerEntry (see module header). */
export interface McpAddServerDefinition {
	command?: string;
	args?: Array<string>;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
}

export type McpAddScope = "project" | "global";

export interface McpConfigAddOptions {
	/** Project directory (session cwd); the project override layer lives beneath it. */
	cwd: string;
	/** Agent dir hosting the pi global config; defaults to getAgentDir(). */
	agentDir?: string;
}

export interface McpConfigAddResult {
	/** The file the definition was appended to. */
	path: string;
}

/** Strict read of the add target; malformed files are hard errors. */
function readTargetConfig(path: string, label: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new McpConfigAddError(
			`Failed to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new McpConfigAddError(`Failed to read ${label} at ${path}: root value must be an object`);
	}
	return parsed as Record<string, unknown>;
}

/** The servers key the file already uses, defaulting to the modern spelling. */
function serverKeyOf(raw: Record<string, unknown>): "mcpServers" | "mcp-servers" {
	if (raw.mcpServers !== undefined) return "mcpServers";
	if (raw["mcp-servers"] !== undefined) return "mcp-servers";
	return "mcpServers";
}

const KNOWN_FIELDS = new Set(["command", "args", "env", "url", "headers", "disabled"]);

/** Validate + copy only the known definition fields, enforcing one transport. */
function validateDefinition(definition: unknown): McpAddServerDefinition {
	if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
		throw new McpConfigAddError("mcp_config_add: definition must be an object");
	}
	const source = definition as Record<string, unknown>;
	const next: McpAddServerDefinition = {};
	for (const [key, value] of Object.entries(source)) {
		if (!KNOWN_FIELDS.has(key)) continue;
		(next as Record<string, unknown>)[key] = value;
	}

	const hasUrl = typeof next.url === "string" && next.url.trim().length > 0;
	const hasCommand = typeof next.command === "string" && next.command.trim().length > 0;
	if (hasUrl && hasCommand) {
		throw new McpConfigAddError(
			"mcp_config_add: definition must specify exactly one transport — url (http) or command (stdio)",
		);
	}
	if (!hasUrl && !hasCommand) {
		throw new McpConfigAddError("mcp_config_add: stdio servers need command, http servers need url");
	}
	if (hasUrl) {
		next.url = next.url!.trim();
		delete next.command;
	} else {
		next.command = next.command!.trim();
		delete next.url;
	}
	if (next.args !== undefined) {
		if (!Array.isArray(next.args) || next.args.some((arg) => typeof arg !== "string")) {
			throw new McpConfigAddError("mcp_config_add: args must be an array of strings");
		}
		next.args = next.args.map((arg) => (arg as string).trim()).filter((arg) => arg.length > 0);
		if (next.args.length === 0) delete next.args;
	}
	if (next.env !== undefined) {
		if (typeof next.env !== "object" || next.env === null || Array.isArray(next.env)) {
			throw new McpConfigAddError("mcp_config_add: env must be a string map");
		}
	}
	if (next.headers !== undefined) {
		if (typeof next.headers !== "object" || next.headers === null || Array.isArray(next.headers)) {
			throw new McpConfigAddError("mcp_config_add: headers must be a string map");
		}
	}
	if (next.disabled !== undefined && typeof next.disabled !== "boolean") {
		throw new McpConfigAddError("mcp_config_add: disabled must be a boolean");
	}
	return next;
}

/**
 * Append a new MCP server definition to the chosen scope's config layer.
 * Throws McpConfigAddError on invalid input, malformed files, or duplicates.
 */
export async function addMcpServer(
	scope: McpAddScope,
	serverInput: string,
	definitionInput: unknown,
	options: McpConfigAddOptions,
): Promise<McpConfigAddResult> {
	if (typeof serverInput !== "string" || serverInput.trim().length === 0) {
		throw new McpConfigAddError("mcp_config_add: server must be a non-empty string");
	}
	const server = serverInput.trim();
	const definition = validateDefinition(definitionInput);

	// Path math mirrors mcp-config-write.ts resolvedPaths (same layer order).
	const agentDir = options.agentDir ?? getAgentDir();
	const targetPath =
		scope === "project" ? join(options.cwd, ".pi", PROJECT_CONFIG_FILE) : join(agentDir, PROJECT_CONFIG_FILE);
	const label = scope === "project" ? "project MCP override" : "pi global MCP config";

	const raw = readTargetConfig(targetPath, label);
	const serverKey = serverKeyOf(raw);
	const rawServers = raw[serverKey];
	if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) {
		throw new McpConfigAddError(`Failed to update ${label} at ${targetPath}: ${serverKey} must be an object`);
	}
	const servers = (rawServers ?? {}) as Record<string, unknown>;
	if (servers[server] !== undefined) {
		throw new McpConfigAddError(`server "${server}" already exists in ${targetPath}`);
	}

	servers[server] = definition;
	raw[serverKey] = servers;
	writeRawConfigObject(targetPath, raw);
	return { path: targetPath };
}
