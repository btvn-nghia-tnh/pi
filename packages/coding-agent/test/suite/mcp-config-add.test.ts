import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { addMcpServer, McpConfigAddError } from "../../src/modes/web/mcp-config-add.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(
		tmpdir(),
		`pi-mcp-config-add-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`,
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

describe("addMcpServer", () => {
	let prevAgentDir: string | undefined;
	let agentRoot: string;
	let projectDir: string;
	let piLayerPath: string;
	let globalPath: string;

	beforeEach(() => {
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentRoot = tempRoot("agent");
		projectDir = tempRoot("project");
		piLayerPath = join(projectDir, ".pi", "mcp.json");
		globalPath = join(agentRoot, "mcp.json");
		process.env.PI_CODING_AGENT_DIR = agentRoot;
	});
	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(agentRoot, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("project add creates the pi layer with the entry and leaves .mcp.json untouched", async () => {
		const original = { mcpServers: { github: { url: "https://example.test/sse" } } };
		writeJson(join(projectDir, ".mcp.json"), original);
		const before = readFileSync(join(projectDir, ".mcp.json"), "utf-8");

		const result = await addMcpServer(
			"project",
			"my-tools",
			{ command: "npx", args: ["-y", "my-mcp-server"] },
			{ cwd: projectDir },
		);
		expect(result.path).toBe(piLayerPath);
		expect(readJson(piLayerPath)).toEqual({
			mcpServers: { "my-tools": { command: "npx", args: ["-y", "my-mcp-server"] } },
		});
		expect(readFileSync(join(projectDir, ".mcp.json"), "utf-8")).toBe(before);
	});

	it("project add preserves existing entries in the pi layer", async () => {
		writeJson(piLayerPath, { mcpServers: { existing: { command: "x" } }, unrelated: { keep: true } });
		await addMcpServer("project", "new-one", { command: "y" }, { cwd: projectDir });
		const raw = readJson(piLayerPath);
		expect((raw.mcpServers as Record<string, unknown>).existing).toEqual({ command: "x" });
		expect((raw.mcpServers as Record<string, unknown>)["new-one"]).toEqual({ command: "y" });
		expect(raw.unrelated).toEqual({ keep: true });
	});

	it("global add writes to the pi agent global config", async () => {
		const result = await addMcpServer("global", "search", { url: "https://mcp.example.test" }, { cwd: projectDir });
		expect(result.path).toBe(globalPath);
		expect(readJson(globalPath)).toEqual({ mcpServers: { search: { url: "https://mcp.example.test" } } });
	});

	it("duplicate name in the same scope errors with 'already exists'", async () => {
		writeJson(piLayerPath, { mcpServers: { github: { url: "u" } } });
		await expect(addMcpServer("project", "github", { command: "x" }, { cwd: projectDir })).rejects.toThrow(
			/already exists/,
		);
		// Same name in the OTHER scope is fine (layered configs shadow per precedence).
		await expect(addMcpServer("global", "github", { command: "x" }, { cwd: projectDir })).resolves.toEqual({
			path: globalPath,
		});
	});

	it("stdio add round-trips command, args and env", async () => {
		await addMcpServer(
			"project",
			"stdio-tools",
			{ command: "uvx", args: ["mcp", "server"], env: { API_KEY_ENV: "1" } },
			{ cwd: projectDir },
		);
		expect(readJson(piLayerPath)).toEqual({
			mcpServers: { "stdio-tools": { command: "uvx", args: ["mcp", "server"], env: { API_KEY_ENV: "1" } } },
		});
	});

	it("http add round-trips url and headers; disabled passthrough", async () => {
		await addMcpServer(
			"project",
			"http-tools",
			{ url: "https://mcp.test/api", headers: { Authorization: "Bearer x" }, disabled: true },
			{ cwd: projectDir },
		);
		expect(readJson(piLayerPath)).toEqual({
			mcpServers: {
				"http-tools": { url: "https://mcp.test/api", headers: { Authorization: "Bearer x" }, disabled: true },
			},
		});
	});

	it("definitions must pick exactly one transport", async () => {
		await expect(
			addMcpServer("project", "both", { url: "https://x", command: "y" }, { cwd: projectDir }),
		).rejects.toThrow(/exactly one transport/);
		await expect(addMcpServer("project", "neither", {}, { cwd: projectDir })).rejects.toThrow(
			/stdio servers need command/,
		);
		await expect(addMcpServer("project", "empty", { url: "   " }, { cwd: projectDir })).rejects.toThrow(
			McpConfigAddError,
		);
	});

	it("rejects an empty server name and non-object definitions", async () => {
		await expect(addMcpServer("project", "  ", { url: "x" }, { cwd: projectDir })).rejects.toThrow(McpConfigAddError);
		await expect(addMcpServer("project", "x", "not-an-object" as never, { cwd: projectDir })).rejects.toThrow(
			McpConfigAddError,
		);
	});

	it("malformed existing target is a hard error, not a silent replace", async () => {
		writeRaw(piLayerPath, "{ nope");
		await expect(addMcpServer("project", "x", { command: "y" }, { cwd: projectDir })).rejects.toThrow(
			/Failed to read/,
		);
		expect(readFileSync(piLayerPath, "utf-8")).toBe("{ nope");
	});

	it("writes are 2-space JSON with a trailing newline and preserve legacy key spelling", async () => {
		writeJson(piLayerPath, { "mcp-servers": { old: { command: "o" } } });
		await addMcpServer("project", "added", { command: "n" }, { cwd: projectDir });
		const text = readFileSync(piLayerPath, "utf-8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text).toContain('"mcp-servers"');
		const raw = readJson(piLayerPath);
		const servers = raw["mcp-servers"] as Record<string, unknown>;
		expect(servers.old).toEqual({ command: "o" });
		expect(servers.added).toEqual({ command: "n" });
	});
});

describe("mcp_config_add web command", () => {
	let prevAgentDir: string | undefined;
	let agentRoot: string;
	let projectDir: string;

	beforeEach(() => {
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentRoot = tempRoot("cmd-agent");
		projectDir = tempRoot("cmd-project");
		process.env.PI_CODING_AGENT_DIR = agentRoot;
	});
	afterEach(() => {
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

	it("writes through the handler and reports the path", async () => {
		const handler = createWebCommandHandler();
		const response = (await handler(
			{
				type: "mcp_config_add",
				scope: "project",
				server: "tools",
				definition: { command: "npx", args: ["x"] },
			} as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; data: { path: string } };
		expect(response.type).toBe("response");
		expect(response.command).toBe("mcp_config_add");
		expect(response.success).toBe(true);
		expect(response.data.path).toBe(join(projectDir, ".pi", "mcp.json"));
		expect(existsSync(join(projectDir, ".pi", "mcp.json"))).toBe(true);
	});

	it("duplicate add surfaces the rpcError path with 'already exists'", async () => {
		const handler = createWebCommandHandler();
		const first = (await handler(
			{ type: "mcp_config_add", scope: "project", server: "dup", definition: { url: "https://x" } } as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as { success: boolean };
		expect(first.success).toBe(true);
		const second = (await handler(
			{ type: "mcp_config_add", scope: "project", server: "dup", definition: { url: "https://x" } } as never,
			coreFor(projectDir) as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; error?: string };
		expect(second.type).toBe("response");
		expect(second.command).toBe("mcp_config_add");
		expect(second.success).toBe(false);
		expect(second.error).toMatch(/already exists/);
	});
});
