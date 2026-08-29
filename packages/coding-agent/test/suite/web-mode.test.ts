import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import type { WebModeHandle } from "../../src/modes/web/web-mode.ts";
import { startWebServer } from "../../src/modes/web/web-mode.ts";

interface ServerFixture {
	handle: WebModeHandle;
	token: string | undefined;
	tempDir: string;
	distDir: string;
}

async function startTestServer(options?: { token?: boolean }): Promise<ServerFixture> {
	const tempDir = join(tmpdir(), `pi-web-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const distDir = join(tempDir, "dist");
	mkdirSync(distDir, { recursive: true });
	writeFileSync(join(distDir, "index.html"), "<!doctype html><html><body>pi web</body></html>");
	process.env.PI_WEB_DIST = distDir;

	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
	faux.setResponses([fauxAssistantMessage("hello world")]);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const model = faux.getModel();
	const runtimeOptions = {
		agentDir: tempDir,
		authStorage,
		model,
		resourceLoaderOptions: {
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerProvider(model.provider, {
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((m) => ({
							id: m.id,
							name: m.name,
							api: m.api,
							reasoning: m.reasoning,
							input: m.input,
							cost: m.cost,
							contextWindow: m.contextWindow,
							maxTokens: m.maxTokens,
						})),
					});
				},
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			...runtimeOptions,
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: runtimeOptions.model,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir, tempDir),
	});

	const token = options?.token !== false;
	const handle = await startWebServer(runtime, {
		port: 0,
		host: "127.0.0.1",
		token,
		open: false,
	});

	const url = new URL(handle.url);
	const tokenValue = url.searchParams.get("token") ?? undefined;
	return { handle, token: tokenValue, tempDir, distDir };
}

function fetchStatus(url: string): Promise<number> {
	return fetch(url).then((response) => response.status);
}

function requestWithHost(url: string, token: string, host: string) {
	const parsed = new URL(url);
	return httpRequest({
		host: parsed.hostname,
		port: parsed.port,
		path: parsed.pathname + (token ? `?token=${token}` : ""),
		headers: { Host: host },
	});
}

interface SocketConnection {
	socket: WebSocket;
	next: () => Promise<Record<string, unknown>>;
}

/**
 * Connect and buffer every incoming frame. The server may send its
 * `connected` payload in the same event-loop burst as the open event, so
 * reading must not depend on when a listener attaches.
 */
function connect(url: string, path = "/ws"): Promise<SocketConnection> {
	const parsed = new URL(url);
	const wsUrl = `ws://${parsed.host}${path}${parsed.search}`;
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(wsUrl);
		const queue: Record<string, unknown>[] = [];
		const waiters: Array<(message: Record<string, unknown>) => void> = [];
		socket.on("message", (data: unknown) => {
			const parsedMessage = JSON.parse(String(data)) as Record<string, unknown>;
			const waiter = waiters.shift();
			if (waiter) {
				waiter(parsedMessage);
			} else {
				queue.push(parsedMessage);
			}
		});
		socket.once("open", () => {
			resolve({
				socket,
				next: () =>
					new Promise((resolveNext) => {
						const buffered = queue.shift();
						if (buffered) {
							resolveNext(buffered);
						} else {
							waiters.push(resolveNext);
						}
					}),
			});
		});
		socket.once("error", reject);
	});
}

function waitForClose(socket: WebSocket): Promise<void> {
	return new Promise((resolve) => {
		if (socket.readyState === WebSocket.CLOSED) {
			resolve();
			return;
		}
		socket.once("close", () => resolve());
	});
}

describe("web mode server", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		delete process.env.PI_WEB_DIST;
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	afterAll(() => {
		delete process.env.PI_WEB_DIST;
	});

	async function server(options?: { token?: boolean }): Promise<ServerFixture> {
		const fixture = await startTestServer(options);
		cleanups.push(async () => {
			await fixture.handle.shutdown("test complete");
			rmSync(fixture.tempDir, { recursive: true, force: true });
		});
		return fixture;
	}

	it("serves index.html with a valid token", async () => {
		const { handle } = await server();
		const response = await fetch(handle.url);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("pi web");
		expect(response.headers.get("content-type")).toContain("text/html");
	});

	it("rejects requests without a token with 404", async () => {
		const { handle } = await server();
		const base = handle.url.split("?")[0]!;
		expect(await fetchStatus(base)).toBe(404);
		expect(await fetchStatus(`${base}?token=wrong-token-value`)).toBe(404);
	});

	it("rejects path traversal", async () => {
		const { handle } = await server();
		const base = handle.url.split("?")[0]!;
		const response = await fetch(
			`${base}?token=${new URL(handle.url).searchParams.get("token")}/../../../etc/passwd`,
		);
		expect(response.status).toBe(404);
	});

	it("rejects bad Host headers", async () => {
		const { handle } = await server();
		const parsed = new URL(handle.url);
		const status = await new Promise<number>((resolve, reject) => {
			const request = requestWithHost(
				`http://${parsed.host}/`,
				parsed.searchParams.get("token") ?? "",
				"evil.example.com:1234",
			);
			request.end();
			request.on("response", (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			request.on("error", reject);
		});
		expect(status).toBe(404);
	});

	it("rejects cross-origin requests", async () => {
		const { handle } = await server();
		const response = await fetch(handle.url, {
			headers: { Origin: "http://evil.example.com" },
		});
		expect(response.status).toBe(404);
	});

	it("rejects WebSocket connections without a token", async () => {
		const { handle } = await server();
		const base = handle.url.split("?")[0]!;
		await expect(connect(base)).rejects.toThrow();
	});

	it("sends a connected payload and answers commands over WebSocket", async () => {
		const { handle } = await server();
		const connection = await connect(handle.url);
		cleanups.push(() => connection.socket.close());

		const connected = await connection.next();
		expect(connected.type).toBe("connected");
		expect(connected.version).toBeTypeOf("string");
		const state = connected.state as { model?: { id?: string } } | undefined;
		expect(state?.model).toMatchObject({ id: "faux-1" });
		expect(Array.isArray(connected.messages)).toBe(true);

		connection.socket.send(JSON.stringify({ id: "req-1", type: "get_state" }));
		const response = await connection.next();
		expect(response).toMatchObject({ id: "req-1", type: "response", command: "get_state", success: true });
	});

	it("responds to parse errors with a parse response", async () => {
		const { handle } = await server();
		const connection = await connect(handle.url);
		cleanups.push(() => connection.socket.close());
		await connection.next(); // connected

		connection.socket.send("not json");
		const response = await connection.next();
		expect(response).toMatchObject({ type: "response", command: "parse", success: false });
	});

	it("streams agent events to connected clients", async () => {
		const { handle } = await server();
		const connection = await connect(handle.url);
		cleanups.push(() => connection.socket.close());
		await connection.next(); // connected

		connection.socket.send(JSON.stringify({ id: "p1", type: "prompt", message: "hi" }));

		const types: string[] = [];
		for (let i = 0; i < 40; i++) {
			const message = await connection.next();
			types.push(String(message.type));
			if (message.type === "agent_settled") break;
		}
		expect(types).toContain("agent_start");
		expect(types).toContain("message_update");
		expect(types).toContain("agent_settled");
	});

	it("runs web parity commands over the socket", async () => {
		const { handle } = await server();
		const connection = await connect(handle.url);
		cleanups.push(() => connection.socket.close());
		await connection.next(); // connected

		connection.socket.send(JSON.stringify({ id: "c1", type: "search_files" }));
		const response = await connection.next();
		expect(response).toMatchObject({ id: "c1", type: "response", command: "search_files", success: true });
	});

	it("broadcasts server_shutdown on shutdown", async () => {
		const { handle } = await server();
		const connection = await connect(handle.url);
		await connection.next(); // connected

		await handle.shutdown("test shutdown");
		const message = await connection.next();
		expect(message).toMatchObject({ type: "server_shutdown", reason: "test shutdown" });
		await waitForClose(connection.socket);
	});

	it("serves without a token when disabled", async () => {
		const { handle } = await server({ token: false });
		expect(handle.url).not.toContain("token=");
		const response = await fetch(handle.url);
		expect(response.status).toBe(200);
	});
});
