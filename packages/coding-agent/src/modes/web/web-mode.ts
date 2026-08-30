/**
 * Web mode: serve the browser GUI for the coding agent.
 *
 * Runs an HTTP server (static assets + WebSocket) in front of one
 * AgentSessionRuntime. A random token gates every request; the CLI prints
 * (and optionally opens) the full URL including the token.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { VERSION } from "../../config.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { RpcCore } from "../rpc/rpc-core.ts";
import type { RpcExtensionUIResponse, RpcResponse } from "../rpc/rpc-types.ts";
import { resolveWebDistDir, serveStatic } from "./web-assets.ts";
import { createWebCommandHandler } from "./web-commands.ts";
import { applyExtensionUiMessage, createWidgetCache } from "./widget-cache.ts";

export interface WebModeOptions {
	/** TCP port; 0 picks an ephemeral port. */
	port: number;
	/** Bind address. Defaults to 127.0.0.1. */
	host: string;
	/** Require a per-run random token on every request. */
	token: boolean;
	/** Open the default browser after the server is ready. */
	open: boolean;
}

export interface WebModeHandle {
	/** URL including the token, when enabled. */
	url: string;
	/** Actual listening port (useful with ephemeral ports). */
	port: number;
	/** Shutdown the server and dispose the runtime. */
	shutdown: (reason?: string) => Promise<void>;
}

const TOKEN_HEADER_NAME = "x-pi-web-token";

function tokensMatch(candidate: string | undefined, expected: string | undefined): boolean {
	if (!expected) return true;
	if (typeof candidate !== "string" || candidate.length === 0) return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function extractToken(request: IncomingMessage): string | undefined {
	const url = new URL(request.url ?? "/", "http://localhost");
	const queryToken = url.searchParams.get("token");
	if (queryToken) return queryToken;
	const auth = request.headers.authorization;
	if (auth?.startsWith("Bearer ")) {
		return auth.slice("Bearer ".length);
	}
	const headerToken = request.headers[TOKEN_HEADER_NAME];
	if (typeof headerToken === "string") return headerToken;
	const cookieHeader = request.headers.cookie;
	if (typeof cookieHeader === "string") {
		for (const part of cookieHeader.split(";")) {
			const [name, ...value] = part.trim().split("=");
			if (name === "pi-web-token" && value.length > 0) {
				return value.join("=");
			}
		}
	}
	return undefined;
}

const TOKEN_COOKIE_NAME = "pi-web-token";

/** Whether the request authenticated through the URL query token. */
function hasQueryToken(request: IncomingMessage): boolean {
	const url = new URL(request.url ?? "/", "http://localhost");
	return url.searchParams.has("token");
}

function tokenCookieHeader(token: string): string {
	return `${TOKEN_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Start the web server for an already-created runtime.
 *
 * The RpcCore is shared across connections: every connected client receives
 * all events and may issue commands. Extension UI requests are broadcast;
 * the first client to answer a dialog wins.
 */
export async function startWebServer(runtime: AgentSessionRuntime, options: WebModeOptions): Promise<WebModeHandle> {
	const distDir = resolveWebDistDir();
	const token = options.token ? randomBytes(24).toString("base64url") : undefined;
	const sockets = new Set<WebSocket>();
	let shuttingDown = false;

	// Latest extension widget and status registrations — see widget-cache.ts
	// for the entry lifecycle (replay in the connected payload, clear on
	// session change, no ghost entries after a payload clear).
	const cache = createWidgetCache();

	const trackExtensionState = (message: object): void => {
		applyExtensionUiMessage(cache, message);
	};

	const broadcast = (message: object): void => {
		trackExtensionState(message);
		const event = message as { type?: string };
		if (event.type === "session_start") {
			cache.widgets.clear();
			cache.statuses.clear();
		}
		const data = JSON.stringify(message);
		for (const socket of sockets) {
			if (socket.readyState === socket.OPEN) {
				socket.send(data);
			}
		}
	};

	const core = new RpcCore({
		runtime,
		send: broadcast,
		extraCommandHandler: createWebCommandHandler(),
	});

	const sendConnected = (socket: WebSocket): void => {
		void core
			.handleCommand({ type: "get_state" })
			.then(async (stateResponse) => {
				const messagesResponse = await core.handleCommand({ type: "get_messages" });
				const contextResponse = await core.handleCommand({ type: "get_context_info" });
				const trustResponse = await core.handleCommand({ type: "get_trust" });
				const keybindingsResponse = await core.handleCommand({ type: "get_keybindings" });
				const themesResponse = await core.handleCommand({ type: "get_themes" });
				const themeData =
					themesResponse?.success && "data" in themesResponse
						? (themesResponse.data as {
								themes?: Array<{ name: string; vars: Record<string, string> }>;
								current?: string;
							})
						: undefined;
				const currentTheme = themeData?.themes?.find((theme) => theme.name === themeData.current);
				socket.send(
					JSON.stringify({
						type: "connected",
						version: VERSION,
						widgets: [...cache.widgets.entries()].map(([key, widget]) => ({ key, ...widget })),
						statuses: [...cache.statuses.entries()].map(([key, text]) => ({ key, text })),
						// Extension dialogs (select/input/confirm/editor) that are
						// still awaiting an answer — replayed so a page reload
						// reopens them instead of hanging the tool call.
						pendingUiRequests: core.getPendingExtensionRequests(),
						themes: themeData?.themes ?? [],
						theme: currentTheme ? { name: currentTheme.name, vars: currentTheme.vars } : undefined,
						state: stateResponse?.success && "data" in stateResponse ? stateResponse.data : undefined,
						messages:
							messagesResponse?.success && "data" in messagesResponse
								? (messagesResponse.data as { messages: unknown }).messages
								: [],
						contextInfo: contextResponse?.success && "data" in contextResponse ? contextResponse.data : undefined,
						trust: trustResponse?.success && "data" in trustResponse ? trustResponse.data : undefined,
						keybindings:
							keybindingsResponse?.success && "data" in keybindingsResponse
								? keybindingsResponse.data
								: undefined,
					}),
				);
			})
			.catch(() => {
				socket.send(JSON.stringify({ type: "connected", version: VERSION, messages: [] }));
			});
	};

	const validateRequest = (request: IncomingMessage, url: URL): boolean => {
		if (!tokensMatch(extractToken(request), token)) {
			return false;
		}
		const host = request.headers.host;
		if (typeof host !== "string" || host.length === 0) {
			return false;
		}
		const hostName = host.replace(/:\d+$/, "");
		const allowedHostNames = new Set([options.host]);
		if (isLoopback(options.host)) {
			allowedHostNames.add("127.0.0.1");
			allowedHostNames.add("localhost");
			allowedHostNames.add("[::1]");
		}
		if (!allowedHostNames.has(hostName)) {
			return false;
		}
		const origin = request.headers.origin;
		if (origin !== undefined && origin !== "null") {
			try {
				const originUrl = new URL(origin);
				const originHost = originUrl.hostname;
				const originAllowed = originHost === options.host || (isLoopback(options.host) && isLoopback(originHost));
				if (!originAllowed || originUrl.port !== url.port) {
					return false;
				}
			} catch {
				return false;
			}
		}
		return true;
	};

	const httpServer: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (!validateRequest(request, url)) {
			// 404 instead of 403 to avoid confirming valid paths to unauthenticated callers
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("Not found");
			return;
		}
		// Relative asset requests do not carry the query token; hand the
		// authenticated browser a cookie so they pass validation.
		if (token && hasQueryToken(request)) {
			response.setHeader("Set-Cookie", tokenCookieHeader(token));
		}
		serveStatic(request, response, distDir);
	});

	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		let accepted = false;
		try {
			accepted = request.url?.startsWith("/ws") === true && validateRequest(request, url);
		} catch {
			accepted = false;
		}
		if (!accepted) {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
			wss.emit("connection", ws, request);
		});
	});

	wss.on("connection", (socket: WebSocket) => {
		sockets.add(socket);
		sendConnected(socket);

		socket.on("message", (data: unknown) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(data));
			} catch (parseError: unknown) {
				broadcast({
					type: "response",
					command: "parse",
					success: false,
					error: `Failed to parse command: ${
						parseError instanceof Error ? parseError.message : String(parseError)
					}`,
				} satisfies RpcResponse);
				return;
			}

			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"type" in parsed &&
				parsed.type === "extension_ui_response"
			) {
				core.handleExtensionUIResponse(parsed as RpcExtensionUIResponse);
				return;
			}

			void core
				.handleCommand(parsed as never)
				.then(async (response) => {
					if (response) {
						broadcast(response);
					}
					if (core.isShutdownRequested) {
						await shutdown("Extension requested shutdown");
					}
				})
				.catch((commandError: unknown) => {
					const command = (parsed as { id?: string; type?: string }) ?? {};
					broadcast({
						id: command.id,
						type: "response",
						command: command.type ?? "unknown",
						success: false,
						error: commandError instanceof Error ? commandError.message : String(commandError),
					} satisfies RpcResponse);
				});
		});

		socket.on("close", () => {
			sockets.delete(socket);
		});
		socket.on("error", () => {
			sockets.delete(socket);
		});
	});

	const shutdown = async (reason?: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		broadcast({ type: "server_shutdown", reason: reason ?? "Server shutting down" });
		for (const socket of sockets) {
			socket.close(1001, reason ?? "Server shutting down");
		}
		await new Promise<void>((resolve) => {
			wss.close(() => resolve());
		});
		await new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
		});
		await core.dispose();
	};

	await core.init();
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port, options.host, () => resolve());
	});

	const address = httpServer.address() as AddressInfo;
	const actualPort = typeof address === "object" && address !== null ? address.port : options.port;
	const displayHost = isLoopback(options.host) ? "127.0.0.1" : options.host;
	const query = token ? `?token=${token}` : "";
	const url = `http://${displayHost}:${actualPort}/${query}`;

	return {
		url,
		port: actualPort,
		shutdown,
	};
}

/**
 * Run in web mode. Starts the server, prints the URL, optionally opens the
 * browser, and blocks forever.
 */
export async function runWebMode(runtime: AgentSessionRuntime, options: WebModeOptions): Promise<never> {
	if (!isLoopback(options.host)) {
		console.warn(`Warning: binding to ${options.host} exposes pi to the network. Only do this on a trusted network.`);
		if (options.token) {
			console.warn("Warning: the session token will travel in the URL query string.");
		}
	}

	const handle = await startWebServer(runtime, options);
	console.log(`pi web GUI: ${handle.url}`);

	if (options.open) {
		openBrowser(handle.url);
	}

	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
	for (const signal of signals) {
		process.on(signal, () => {
			killTrackedDetachedChildren();
			void handle.shutdown(`Received ${signal}`).finally(() => {
				process.exit(0);
			});
		});
	}

	// Keep the process alive until shutdown.
	return new Promise(() => {});
}
