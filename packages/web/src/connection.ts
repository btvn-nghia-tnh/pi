/**
 * WebSocket connection with request/response correlation and reconnect.
 */

import type { ClientCommand, ConnectedPayload, ExtensionUiResponseMessage, ServerMessage } from "./types.ts";

export interface ConnectionHandlers {
	onMessage: (message: ServerMessage) => void;
	onDisconnect: (reason: string) => void;
	onReconnect: () => void;
	/** Current session id; every outgoing command is tagged with it. */
	getSessionId?: () => string | undefined;
}

export interface PiConnection {
	send(command: ClientCommand): void;
	request<T = unknown>(command: ClientCommand): Promise<T>;
	sendRaw(message: unknown): void;
	close(): void;
	isConnected(): boolean;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

export function connect(handlers: ConnectionHandlers): PiConnection {
	/** Every outgoing command carries the active session tag. */
	const tagCommand = <T extends ClientCommand>(command: T): T => {
		const sessionId = handlers.getSessionId?.();
		if (sessionId === undefined || command.sessionId !== undefined) return command;
		return { ...command, sessionId };
	};
	let socket: WebSocket | undefined;
	let closedByUser = false;
	let reconnectAttempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	const wsUrl = (): string => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${window.location.host}/ws${window.location.search}`;
	};

	const open = (): void => {
		socket = new WebSocket(wsUrl());
		socket.addEventListener("message", (event) => {
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				return;
			}
			if (
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "response" &&
				"id" in message &&
				typeof (message as { id?: unknown }).id === "string"
			) {
				const id = (message as { id: string }).id;
				const waiter = pending.get(id);
				if (waiter) {
					pending.delete(id);
					if ((message as { success?: boolean }).success) {
						waiter.resolve((message as { data?: unknown }).data);
					} else {
						waiter.reject(new Error(String((message as { error?: string }).error ?? "Command failed")));
					}
					return;
				}
			}
			handlers.onMessage(message);
		});
		socket.addEventListener("open", () => {
			if (reconnectAttempt > 0) {
				reconnectAttempt = 0;
				handlers.onReconnect();
			}
		});
		socket.addEventListener("close", (event) => {
			socket = undefined;
			for (const waiter of pending.values()) {
				waiter.reject(new Error("Connection closed"));
			}
			pending.clear();
			if (closedByUser) return;
			handlers.onDisconnect(event.reason || "Connection closed");
			const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
			reconnectAttempt++;
			reconnectTimer = setTimeout(open, delay);
		});
		socket.addEventListener("error", () => {
			socket?.close();
		});
	};

	open();

	return {
		send(rawCommand) {
			const command = tagCommand(rawCommand);
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(command));
			}
		},
		request<T>(command: ClientCommand): Promise<T> {
			const id = generateRequestId();
			return new Promise<T>((resolve, reject) => {
				pending.set(id, {
					resolve: (value) => resolve(value as T),
					reject,
				});
				this.send({ ...command, id });
			});
		},
		sendRaw(message) {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			}
		},
		close() {
			closedByUser = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.close();
		},
		isConnected() {
			return socket?.readyState === WebSocket.OPEN;
		},
	};
}

let requestCounter = 0;

function generateRequestId(): string {
	requestCounter++;
	return `ui-${Date.now().toString(36)}-${requestCounter}`;
}

/** Build an extension UI response for dialogs. */
export function extensionUiResponse(response: {
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
	sessionId?: string;
}): ExtensionUiResponseMessage {
	return { type: "extension_ui_response", ...response };
}

/** Type guard helpers used by the app. */
export function isConnectedPayload(message: ServerMessage): message is ConnectedPayload {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		(message as { type: string }).type === "connected"
	);
}
