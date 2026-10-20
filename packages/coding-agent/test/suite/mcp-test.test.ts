/**
 * mcp_test: connection probe for configured MCP servers.
 * Contract per lane brief: http probe classifications, stdio handshake +
 * optional tools/list count, fast-crash classification, config-layer lookup
 * (project → global, scope-directed), and the web-commands dispatch.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import { testMcpServer } from "../../src/modes/web/mcp-test.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

let tempCount = 0;
function tempRoot(name: string): string {
	tempCount += 1;
	const dir = join(tmpdir(), `pi-mcp-test-${name}-${Date.now()}-${tempCount}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write a JSON file with parent dirs. */
function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Start an HTTP stub on 127.0.0.1 with an ephemeral port. */
async function startStub(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
	server: Server;
	port: number;
}> {
	const server = createServer(handler);
	return await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ server, port });
		});
	});
}

describe("testMcpServer", () => {
	let agentRoot: string;
	let projectDir: string;
	let stubs: Server[];

	beforeEach(() => {
		agentRoot = tempRoot("agent");
		projectDir = tempRoot("proj");
		stubs = [];
	});
	afterEach(async () => {
		for (const stub of stubs) {
			await new Promise<void>((resolve) => stub.close(() => resolve()));
		}
		rmSync(agentRoot, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("classifies a 2xx MCP endpoint as a successful handshake", async () => {
		const { server, port } = await startStub((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { serverInfo: { name: "stub" }, protocolVersion: "2025-06-18" },
				}),
			);
		});
		stubs.push(server);
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { remote: { url: `http://127.0.0.1:${port}` } },
		});
		const result = await testMcpServer({ server: "remote", scope: "project", cwd: projectDir, agentDir: agentRoot });
		expect(result.ok).toBe(true);
		expect(result.reachable).toBe(true);
		expect(result.httpStatus).toBe(200);
		expect(result.detail).toBe("handshake ok");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("treats 401 as reachable but auth-required", async () => {
		const { server, port } = await startStub((_request, response) => {
			response.writeHead(401);
			response.end();
		});
		stubs.push(server);
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { remote: { url: `http://127.0.0.1:${port}` } },
		});
		const result = await testMcpServer({ server: "remote", scope: "project", cwd: projectDir, agentDir: agentRoot });
		expect(result.ok).toBe(false);
		expect(result.authRequired).toBe(true);
		expect(result.httpStatus).toBe(401);
		expect(result.detail).toBe("reachable — authentication required");
	});

	it("treats other HTTP statuses as reachable-but-not-ok", async () => {
		const { server, port } = await startStub((_request, response) => {
			response.writeHead(500);
			response.end();
		});
		stubs.push(server);
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { remote: { url: `http://127.0.0.1:${port}` } },
		});
		const result = await testMcpServer({ server: "remote", scope: "project", cwd: projectDir, agentDir: agentRoot });
		expect(result.ok).toBe(false);
		expect(result.reachable).toBe(true);
		expect(result.detail).toBe("HTTP 500");
	});

	it("reports connection-refused as unreachable", async () => {
		const { server, port } = await startStub((_request, response) => {
			response.writeHead(200);
			response.end("{}");
		});
		stubs.push(server);
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { remote: { url: `http://127.0.0.1:${port}` } },
		});
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const result = await testMcpServer({ server: "remote", scope: "project", cwd: projectDir, agentDir: agentRoot });
		expect(result.ok).toBe(false);
		expect(result.reachable).toBe(false);
		expect(result.detail.length).toBeGreaterThan(0);
	});

	it("completes a stdio handshake and reports the tools/list count", async () => {
		const fixturePath = join(projectDir, "stdio-fixture.cjs");
		writeFileSync(
			fixturePath,
			`const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg; try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === 1) {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "0.0.0" } } }) + "\\n");
	} else if (msg.id === 2) {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "echo" }, { name: "add" }] } }) + "\\n");
	}
});
`,
			"utf-8",
		);
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { local: { command: process.execPath, args: [fixturePath] } },
		});
		const result = await testMcpServer({
			server: "local",
			scope: "project",
			cwd: projectDir,
			agentDir: agentRoot,
			timeoutMs: 3000,
		});
		expect(result.ok).toBe(true);
		expect(result.reachable).toBe(true);
		expect(result.toolCount).toBe(2);
		expect(result.detail).toBe("2 tools");
	});

	it("classifies an instantly crashing stdio server", async () => {
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { crasher: { command: process.execPath, args: ["-e", "process.exit(3)"] } },
		});
		const result = await testMcpServer({
			server: "crasher",
			scope: "project",
			cwd: projectDir,
			agentDir: agentRoot,
			timeoutMs: 300,
		});
		expect(result.ok).toBe(false);
		expect(result.detail).toBe("exited 3");
	});

	it("classifies a silent stdio server as no handshake response", async () => {
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { sleeper: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] } },
		});
		const result = await testMcpServer({
			server: "sleeper",
			scope: "project",
			cwd: projectDir,
			agentDir: agentRoot,
			timeoutMs: 300,
		});
		expect(result.ok).toBe(false);
		expect(result.detail).toBe("no handshake response");
	});

	it("surfaces spawn errors for unknown commands instead of hanging", async () => {
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { ghost: { command: "definitely-not-a-real-command-xyz-private" } },
		});
		const result = await testMcpServer({
			server: "ghost",
			scope: "project",
			cwd: projectDir,
			agentDir: agentRoot,
			timeoutMs: 2000,
		});
		expect(result.ok).toBe(false);
		expect(result.detail.startsWith("error:")).toBe(true);
	}, 10000);

	it("falls back to the global layer when the project layer lacks the server", async () => {
		const { server, port } = await startStub((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
		});
		stubs.push(server);
		writeJson(join(agentRoot, "mcp.json"), {
			mcpServers: { sharepoint: { url: `http://127.0.0.1:${port}` } },
		});
		const result = await testMcpServer({
			server: "sharepoint",
			scope: "project",
			cwd: projectDir,
			agentDir: agentRoot,
		});
		expect(result.ok).toBe(true);
	});

	it("finds scope=global entries in the global layer", async () => {
		const { server, port } = await startStub((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
		});
		stubs.push(server);
		writeJson(join(agentRoot, "mcp.json"), {
			mcpServers: { sharepoint: { url: `http://127.0.0.1:${port}` } },
		});
		const result = await testMcpServer({
			server: "sharepoint",
			scope: "global",
			cwd: projectDir,
			agentDir: agentRoot,
		});
		expect(result.ok).toBe(true);
		expect(result.detail).toBe("handshake ok");
	});

	it("throws when the server is not configured anywhere", async () => {
		await expect(
			testMcpServer({ server: "nowhere", scope: "project", cwd: projectDir, agentDir: agentRoot }),
		).rejects.toThrow(/is not configured/);
	});

	it("carries definition headers on the http probe", async () => {
		let sawToken: string | undefined;
		const { server, port } = await startStub((request, response) => {
			sawToken = String(request.headers["x-test-token"] ?? "");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
		});
		stubs.push(server);
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: {
				tokened: { url: `http://127.0.0.1:${port}`, headers: { "X-Test-Token": "sekrit" } },
			},
		});
		const result = await testMcpServer({ server: "tokened", scope: "project", cwd: projectDir, agentDir: agentRoot });
		expect(result.ok).toBe(true);
		expect(sawToken).toBe("sekrit");
	});
});

describe("mcp_test dispatch", () => {
	it("answers through the web command handler with probe data", async () => {
		const projectDir = tempRoot("dispatch");
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => "/does-not-matter" } }),
			getRuntime: () => ({}),
		} as never;
		// Nothing reachable — but configured, so the probe must at least run.
		writeJson(join(projectDir, ".pi", "mcp.json"), {
			mcpServers: { unreach: { url: "http://127.0.0.1:1/mcp" } },
		});
		const response = (await handler(
			{ type: "mcp_test", server: "unreach", scope: "project", cwd: projectDir } as never,
			core as unknown as RpcCore,
		)) as {
			type: string;
			command: string;
			success: boolean;
			data: { ok: boolean; detail: string; latencyMs: number; reachable?: boolean };
		};
		expect(response.type).toBe("response");
		expect(response.command).toBe("mcp_test");
		expect(response.success).toBe(true);
		expect(response.data.ok).toBe(false);
		expect(response.data.reachable).toBe(false);
		expect(typeof response.data.latencyMs).toBe("number");
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("returns a command error for an unconfigured server", async () => {
		const projectDir = tempRoot("dispatch-miss");
		const handler = createWebCommandHandler();
		const core = {
			getSession: () => ({ sessionManager: { getCwd: () => projectDir } }),
			getRuntime: () => ({}),
		} as never;
		const response = (await handler(
			{ type: "mcp_test", server: "ghost", scope: "project" } as never,
			core as unknown as RpcCore,
		)) as { type: string; command: string; success: boolean; error?: string };
		expect(response.type).toBe("response");
		expect(response.command).toBe("mcp_test");
		expect(response.success).toBe(false);
		expect(response.error).toMatch(/is not configured/);
		rmSync(projectDir, { recursive: true, force: true });
	});
});
