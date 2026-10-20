import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { McpConfigWriteError, writeMcpServerEnabled } from "../../src/modes/web/mcp-config-write.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(
		tmpdir(),
		`pi-mcp-config-write-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`,
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

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("writeMcpServerEnabled", () => {
	let prevHome: string | undefined;
	let prevAgentDir: string | undefined;
	let homeRoot: string;
	let agentRoot: string;
	let projectDir: string;
	let piLayerPath: string;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		homeRoot = tempRoot("home");
		agentRoot = tempRoot("agent");
		projectDir = tempRoot("project");
		piLayerPath = join(projectDir, ".pi", "mcp.json");
		process.env.HOME = homeRoot;
		process.env.PI_CODING_AGENT_DIR = agentRoot;
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(homeRoot, { recursive: true, force: true });
		rmSync(agentRoot, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("homedir reflects the stubbed HOME for hermetic global paths", () => {
		expect(homedir()).toBe(homeRoot);
	});

	it("disable writes {disabled:true} to the project .pi layer and leaves .mcp.json untouched", async () => {
		const original = { mcpServers: { github: { url: "https://example.test/sse" }, other: { command: "x" } } };
		writeJson(join(projectDir, ".mcp.json"), original);
		const before = readFileSync(join(projectDir, ".mcp.json"), "utf-8");
		await writeMcpServerEnabled("github", false, { cwd: projectDir });
		expect(readJson(piLayerPath)).toEqual({ mcpServers: { github: { disabled: true } } });
		expect(readFileSync(join(projectDir, ".mcp.json"), "utf-8")).toBe(before);
	});

	it("repeated disable is a no-op (changed:false, no write)", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { github: { url: "u" } } });
		await writeMcpServerEnabled("github", false, { cwd: projectDir });
		const writtenAt = readFileSync(piLayerPath, "utf-8");
		const result = await writeMcpServerEnabled("github", false, { cwd: projectDir });
		expect(result.changed).toBe(false);
		expect(readFileSync(piLayerPath, "utf-8")).toBe(writtenAt);
	});

	it("enable removes the flag when no lower source is disabled", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { github: { url: "u" } } });
		await writeMcpServerEnabled("github", false, { cwd: projectDir });
		await writeMcpServerEnabled("github", true, { cwd: projectDir });
		// Entry is dropped entirely (empty servers map remains, matching the adapter writer).
		expect(readJson(piLayerPath)).toEqual({ mcpServers: {} });
	});

	it("enable writes an explicit {disabled:false} when a lower source has disabled:true", async () => {
		writeJson(join(projectDir, ".mcp.json"), {
			mcpServers: { github: { url: "u", disabled: true } },
		});
		await writeMcpServerEnabled("github", true, { cwd: projectDir });
		expect(readJson(piLayerPath)).toEqual({ mcpServers: { github: { disabled: false } } });
	});

	it("unknown server name is added to the pi layer when config exists", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { other: { command: "x" } } });
		await writeMcpServerEnabled("brand-new", false, { cwd: projectDir });
		expect(readJson(piLayerPath)).toEqual({
			mcpServers: { "brand-new": { disabled: true } },
		});
	});

	it("global config alone satisfies discovery (project file missing)", async () => {
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { github: { url: "u" } } });
		const result = await writeMcpServerEnabled("github", false, { cwd: projectDir });
		expect(result.path).toBe(piLayerPath);
		expect(readJson(piLayerPath)).toEqual({ mcpServers: { github: { disabled: true } } });
	});

	it("generic global (~/.config/mcp/mcp.json) satisfies discovery too", async () => {
		writeJson(join(homeRoot, ".config", "mcp", "mcp.json"), { mcpServers: { g: { url: "u" } } });
		await writeMcpServerEnabled("g", false, { cwd: projectDir });
		expect(readJson(piLayerPath)).toEqual({ mcpServers: { g: { disabled: true } } });
	});

	it("pi global disabled:true forces {disabled:false} on enable", async () => {
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { github: { url: "u", disabled: true } } });
		await writeMcpServerEnabled("github", true, { cwd: projectDir });
		expect(readJson(piLayerPath)).toEqual({ mcpServers: { github: { disabled: false } } });
	});

	it("preserves unrelated entries and keeps an existing mcp-servers key name", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { a: { command: "x" } } });
		writeJson(piLayerPath, { "mcp-servers": { keep: { disabled: true } } });
		await writeMcpServerEnabled("github", false, { cwd: projectDir });
		expect(readJson(piLayerPath)).toEqual({
			"mcp-servers": { keep: { disabled: true }, github: { disabled: true } },
		});
	});

	it("malformed pi layer JSON raises McpConfigWriteError naming the path", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { github: { url: "u" } } });
		writeRaw(piLayerPath, "{ not json");
		await expect(writeMcpServerEnabled("github", false, { cwd: projectDir })).rejects.toThrow(
			new RegExp(piLayerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	});

	it("malformed pi layer root (array) raises McpConfigWriteError", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { github: { url: "u" } } });
		writeRaw(piLayerPath, "[1,2]");
		await expect(writeMcpServerEnabled("github", false, { cwd: projectDir })).rejects.toThrow(McpConfigWriteError);
	});

	it("errors when no MCP config exists anywhere", async () => {
		await expect(writeMcpServerEnabled("github", false, { cwd: projectDir })).rejects.toThrow(/No MCP config found/);
	});

	it("rejects an empty server name", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { a: { command: "x" } } });
		await expect(writeMcpServerEnabled("  ", false, { cwd: projectDir })).rejects.toThrow(McpConfigWriteError);
	});
});

describe("mcp_config_write web command", () => {
	let prevHome: string | undefined;
	let prevAgentDir: string | undefined;
	let homeRoot: string;
	let agentRoot: string;
	let projectDir: string;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		homeRoot = tempRoot("cmd-home");
		agentRoot = tempRoot("cmd-agent");
		projectDir = tempRoot("cmd-project");
		process.env.HOME = homeRoot;
		process.env.PI_CODING_AGENT_DIR = agentRoot;
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(homeRoot, { recursive: true, force: true });
		rmSync(agentRoot, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	function coreFor(projectDir: string): never {
		return {
			getSession: () => ({ sessionManager: { getCwd: () => projectDir } }),
			getRuntime: () => ({}),
		} as never;
	}

	it("writes through the handler and reports the path", async () => {
		writeJson(join(projectDir, ".mcp.json"), { mcpServers: { github: { url: "u" } } });
		const handler = createWebCommandHandler();
		const response = (await handler(
			{ type: "mcp_config_write", server: "github", enabled: false } as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; data: { path: string; changed: boolean } };
		expect(response.type).toBe("response");
		expect(response.command).toBe("mcp_config_write");
		expect(response.success).toBe(true);
		expect(response.data.changed).toBe(true);
		expect(response.data.path).toBe(join(projectDir, ".pi", "mcp.json"));
		expect(existsSync(join(projectDir, ".pi", "mcp.json"))).toBe(true);
	});

	it("returns rpcError when no config exists anywhere", async () => {
		const handler = createWebCommandHandler();
		const response = (await handler(
			{ type: "mcp_config_write", server: "github", enabled: false } as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; error?: string };
		expect(response.type).toBe("response");
		expect(response.command).toBe("mcp_config_write");
		expect(response.success).toBe(false);
		expect(response.error).toMatch(/No MCP config found/);
	});
});
