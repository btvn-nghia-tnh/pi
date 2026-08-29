/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 *
 * Command handling and event forwarding live in RpcCore (rpc-core.ts); this file
 * is the stdio transport.
 */

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { RpcCore } from "./rpc-core.ts";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses as JSON on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();

	// Shutdown request flag
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const core = new RpcCore({
		runtime: runtimeHost,
		send: (obj) => {
			writeRawStdout(serializeJsonLine(obj));
		},
		applyBackpressure: () => waitForRawStdoutBackpressure(),
		onShutdownRequested: () => {
			void shutdown();
		},
	});

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await core.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (core.isShutdownRequested) {
			await shutdown();
		}
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			writeRawStdout(
				serializeJsonLine({
					type: "response",
					command: "parse",
					success: false,
					error: `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				} satisfies RpcResponse),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			core.handleExtensionUIResponse(parsed as RpcExtensionUIResponse);
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await core.handleCommand(command);
			if (response) {
				writeRawStdout(serializeJsonLine(response));
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			writeRawStdout(
				serializeJsonLine({
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					error: commandError instanceof Error ? commandError.message : String(commandError),
				} satisfies RpcResponse),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	await core.init();
	registerSignalHandlers();

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
