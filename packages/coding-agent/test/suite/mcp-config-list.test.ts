import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { listMcpServers } from "../../src/modes/web/mcp-config-list.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(
		tmpdir(),
		`pi-mcp-config-list-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeRaw(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf-8");
}

describe("listMcpServers", () => {
	let agentRoot: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		agentRoot = tempRoot("agent");
		projectA = tempRoot("projA");
		projectB = tempRoot("projB");
	});
	afterEach(() => {
		for (const root of [agentRoot, projectA, projectB]) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns empty entries when nothing is configured anywhere", () => {
		const result = listMcpServers({ cwds: [projectA, projectB], agentDir: agentRoot });
		expect(result.entries).toEqual([]);
	});

	it("lists project entries with the pi-override path and cwd", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), {
			mcpServers: { github: { url: "https://example.test/sse" } },
		});
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry.scope).toBe("project");
		expect(entry.cwd).toBe(projectA);
		expect(entry.path).toBe(join(projectA, ".pi", "mcp.json"));
		expect(entry.name).toBe("github");
		expect(entry.definition).toEqual({ url: "https://example.test/sse" });
	});

	it("merges multiple project cwds in the given order, then the global scope", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), { mcpServers: { a1: { command: "x" } } });
		writeJson(join(projectB, ".pi", "mcp.json"), { mcpServers: { b1: { command: "y" } } });
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { g1: { command: "z" } } });
		const result = listMcpServers({ cwds: [projectA, projectB], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["a1", "b1", "g1"]);
		expect(result.entries[2].scope).toBe("global");
		expect(result.entries[2].cwd).toBeUndefined();
		expect(result.entries[2].path).toBe(join(agentRoot, "mcp.json"));
	});

	it("skips missing project files without errors", () => {
		writeJson(join(projectB, ".pi", "mcp.json"), { mcpServers: { b1: { command: "y" } } });
		const result = listMcpServers({ cwds: [projectA, projectB], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["b1"]);
	});

	it("skips malformed project files and continues", () => {
		writeRaw(join(projectA, ".pi", "mcp.json"), "{ not json at all");
		writeJson(join(projectB, ".pi", "mcp.json"), { mcpServers: { b1: { command: "y" } } });
		const result = listMcpServers({ cwds: [projectA, projectB], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["b1"]);
	});

	it("flattens the legacy mcp-servers key spelling", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), { "mcp-servers": { legacy: { command: "x" } } });
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["legacy"]);
	});

	it("passes the disabled flag through untouched", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), {
			mcpServers: { paused: { command: "x", disabled: true } },
		});
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries[0].definition).toEqual({ command: "x", disabled: true });
	});

	it("skips server entries whose definitions are not objects", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), {
			mcpServers: { fine: { command: "x" }, bad: "string", worse: ["array"], nothing: null },
		});
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["fine"]);
	});

	it("collapses duplicate cwds", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), { mcpServers: { only: { command: "x" } } });
		const result = listMcpServers({ cwds: [projectA, projectA, projectA], agentDir: agentRoot });
		expect(result.entries.filter((entry) => entry.name === "only")).toHaveLength(1);
	});

	it("ignores empty-string and non-string cwd entries", () => {
		const result = listMcpServers({
			cwds: ["", projectA, "" as unknown as string],
			agentDir: agentRoot,
		});
		expect(result.entries).toEqual([]);
		expect(existsSync(join(projectA, ".pi"))).toBe(false);
	});

	it("answers global-only when cwds is empty", () => {
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { g1: { command: "z" } } });
		const result = listMcpServers({ cwds: [], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.scope)).toEqual(["global"]);
	});

	it("handles a missing global config file", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), { mcpServers: { a1: { command: "x" } } });
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["a1"]);
	});

	it("skips a malformed global config file without failing the command", () => {
		writeRaw(join(agentRoot, "mcp.json"), "<<broken>>");
		writeJson(join(projectA, ".pi", "mcp.json"), { mcpServers: { a1: { command: "x" } } });
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries.map((entry) => entry.name)).toEqual(["a1"]);
	});

	it("handles server configs that are empty objects", () => {
		writeJson(join(projectA, ".pi", "mcp.json"), { mcpServers: {} });
		const result = listMcpServers({ cwds: [projectA], agentDir: agentRoot });
		expect(result.entries).toEqual([]);
	});
});

describe("mcp_config_list web command", () => {
	let prevHome: string | undefined;
	let prevAgentDir: string | undefined;
	let agentRoot: string;
	let projectDir: string;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentRoot = tempRoot("cmd-agent");
		projectDir = tempRoot("cmd-project");
		process.env.HOME = tempRoot("cmd-home");
		process.env.PI_CODING_AGENT_DIR = agentRoot;
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(agentRoot, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	function coreFor(projectDir: string): never {
		return {
			getSession: () => ({ sessionManager: { getCwd: () => projectDir } }),
			getRuntime: () => ({}),
		} as never;
	}

	it("returns project and global entries through the handler", async () => {
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { local: { url: "https://example.test/sse" } },
		});
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { globalone: { command: "z" } } });
		const handler = createWebCommandHandler();
		const response = (await handler(
			{ type: "mcp_config_list", cwds: [projectDir] } as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as {
			type: string;
			command: string;
			success: boolean;
			data: { entries: Array<{ scope: string; name: string; path: string; cwd?: string }> };
		};
		expect(response.type).toBe("response");
		expect(response.command).toBe("mcp_config_list");
		expect(response.success).toBe(true);
		expect(response.data.entries.map((entry) => entry.name)).toEqual(["local", "globalone"]);
		expect(response.data.entries[0].cwd).toBe(projectDir);
		expect(response.data.entries[1].cwd).toBeUndefined();
	});

	it("answers with an empty list when nothing is configured", async () => {
		const handler = createWebCommandHandler();
		const response = (await handler(
			{ type: "mcp_config_list", cwds: [projectDir] } as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as { success: boolean; data: { entries: unknown[] } };
		expect(response.success).toBe(true);
		expect(response.data.entries).toEqual([]);
	});
});
