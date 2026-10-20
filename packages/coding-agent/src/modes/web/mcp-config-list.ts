/**
 * mcp_config_list: enumerate configured MCP servers from config files (web
 * console MCP page, user issue batch 3).
 *
 * Reads the SAME layers mcp_config_write/mcp_config_add manage:
 * - project: the project Pi override layer `<cwd>/.pi/mcp.json` per requested cwd
 * - global:  the pi agent global `<agentDir>/mcp.json`
 *
 * Configuration files are read TOLERANTLY — missing or malformed files are
 * skipped (no errors); the command answers with whatever is legibly
 * configured. Unlike mcp_config_write/add there is no guard requirement:
 * listing an empty world is a valid answer.
 *
 * Both server-map key spellings (`mcpServers`, legacy `mcp-servers`) are
 * flattened identically; the raw definition object (including a possible
 * `disabled` flag or anything else) is passed through untouched.
 */

import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { PROJECT_CONFIG_FILE, readRawConfig, serversOf } from "./mcp-config-write.ts";

export interface McpConfigListEntry {
	scope: "project" | "global";
	/** Project cwd the entry came from (absent for global). */
	cwd?: string;
	/** Config file the entry was read from. */
	path: string;
	/** Server name (key inside the servers map). */
	name: string;
	/** Raw server definition object, exactly as configured. */
	definition: Record<string, unknown>;
}

export interface McpConfigListOptions {
	/** Project cwds (session cwds) to enumerate; duplicates are collapsed. */
	cwds: string[];
	/** Agent dir hosting the pi global override; defaults to getAgentDir(). */
	agentDir?: string;
}

/** Render one config file's servers as entries; tolerant of junk. */
function entriesFromConfig(scope: "project" | "global", path: string, cwd: string | undefined): McpConfigListEntry[] {
	const raw = readRawConfig(path);
	if (!raw) return [];
	const servers = serversOf(raw);
	const entries: McpConfigListEntry[] = [];
	for (const [name, definition] of Object.entries(servers)) {
		if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
		entries.push({ scope, cwd, path, name, definition: definition as Record<string, unknown> });
	}
	return entries;
}

/** Enumerate configured MCP servers across the requested project cwds + global. */
export function listMcpServers(options: McpConfigListOptions): { entries: McpConfigListEntry[] } {
	const agentDir = options.agentDir ?? getAgentDir();
	const seenCwds = new Set<string>();
	const entries: McpConfigListEntry[] = [];
	for (const cwd of options.cwds ?? []) {
		if (typeof cwd !== "string" || cwd.length === 0 || seenCwds.has(cwd)) continue;
		seenCwds.add(cwd);
		entries.push(...entriesFromConfig("project", join(cwd, ".pi", PROJECT_CONFIG_FILE), cwd));
	}
	entries.push(...entriesFromConfig("global", join(agentDir, PROJECT_CONFIG_FILE), undefined));
	return { entries };
}
