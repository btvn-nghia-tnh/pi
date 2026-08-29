/**
 * Transport-agnostic RPC command core.
 *
 * Owns command handling, the extension UI bridge, and event forwarding for a
 * single AgentSessionRuntime. Transports (stdio JSONL in rpc-mode, WebSocket
 * in web-mode) supply a `send` sink plus optional backpressure and shutdown
 * hooks.
 */

import * as crypto from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import type {
	RpcAuthUIRequest,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

export type RpcMessageSink = (message: RpcResponse | RpcExtensionUIRequest | object) => void;

export interface RpcCoreOptions {
	/** Runtime whose active session the core operates on. */
	runtime: AgentSessionRuntime;
	/** Sends one JSON message to the client. */
	send: RpcMessageSink;
	/** Optional backpressure hook invoked after emitted messages. */
	applyBackpressure?: () => void | Promise<void>;
	/** Called when the agent settles while an extension requested shutdown. */
	onShutdownRequested?: () => void;
	/**
	 * Handles commands this core does not know. Return undefined when the
	 * command is not recognized either; the core then answers with an
	 * unknown-command error.
	 */
	extraCommandHandler?: (command: RpcCommand, core: RpcCore) => Promise<RpcResponse | undefined>;
}

export function rpcSuccess<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function rpcError(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

/**
 * Shared command core for RPC-like transports.
 */
export class RpcCore {
	private readonly runtime: AgentSessionRuntime;
	private readonly send: RpcMessageSink;
	private readonly applyBackpressure: () => void | Promise<void>;
	private readonly onShutdownRequested: (() => void) | undefined;
	private readonly extraCommandHandler:
		| ((command: RpcCommand, core: RpcCore) => Promise<RpcResponse | undefined>)
		| undefined;
	private readonly pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	private session: AgentSession;
	private unsubscribe: (() => void) | undefined;
	private unsubscribeBackpressure: (() => void) | undefined;
	private shutdownRequested = false;

	constructor(options: RpcCoreOptions) {
		this.runtime = options.runtime;
		this.send = options.send;
		this.applyBackpressure = options.applyBackpressure ?? (() => {});
		this.onShutdownRequested = options.onShutdownRequested;
		this.extraCommandHandler = options.extraCommandHandler;
		this.session = options.runtime.session;
	}

	get isShutdownRequested(): boolean {
		return this.shutdownRequested;
	}

	getSession(): AgentSession {
		return this.session;
	}

	getRuntime(): AgentSessionRuntime {
		return this.runtime;
	}

	sendExtensionUIRequest(request: RpcExtensionUIRequest | RpcAuthUIRequest): void {
		this.output(request);
	}

	/** Send an arbitrary protocol message (theme_changed, auth_changed, ...) to the client. */
	emit(message: object): void {
		this.output(message);
	}

	/**
	 * Request a dialog from the client through the extension UI mechanism.
	 * Used by command handlers (for example auth prompts) that need input.
	 * Resolves with undefined when the dialog is cancelled or times out.
	 */
	requestDialog<T>(
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
		options?: { signal?: AbortSignal; timeout?: number },
	): Promise<T | undefined> {
		return this.createDialogPromise(options, undefined, request, parseResponse);
	}

	private readonly output = (obj: RpcResponse | RpcExtensionUIRequest | object): void => {
		this.send(obj);
	};

	/** Helper for dialog methods with signal/timeout support */
	private createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		const output = (obj: RpcResponse | RpcExtensionUIRequest | object): void => {
			this.output(obj);
		};
		const createDialogPromise = this.createDialogPromise.bind(this);
		const pendingExtensionRequests = this.pendingExtensionRequests;
		const uiContext: ExtensionUIContext = {
			select: (title, options, opts) =>
				createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
				),

			confirm: (title, message, opts) =>
				createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
				),

			input: (title, placeholder, opts) =>
				createDialogPromise(
					opts,
					undefined,
					{ method: "input", title, placeholder, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			notify(message: string, type?: "info" | "warning" | "error"): void {
				// Fire and forget - no response needed
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				} as RpcExtensionUIRequest);
			},

			onTerminalInput(): () => void {
				// Raw terminal input not supported in RPC-like modes
				return () => {};
			},

			setStatus(key: string, text: string | undefined): void {
				// Fire and forget - no response needed
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setStatus",
					statusKey: key,
					statusText: text,
				} as RpcExtensionUIRequest);
			},

			setWorkingMessage(_message?: string): void {
				// Working message not supported in RPC-like modes - requires TUI loader access
			},

			setWorkingVisible(_visible: boolean): void {
				// Working visibility not supported in RPC-like modes - requires TUI loader access
			},

			setWorkingIndicator(options?: WorkingIndicatorOptions): void {
				// Fire and forget - clients that support custom frames honor them,
				// others ignore the request.
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWorkingIndicator",
					frames: options?.frames,
					intervalMs: options?.intervalMs,
				} satisfies RpcExtensionUIRequest);
			},

			setHiddenThinkingLabel(_label?: string): void {
				// Hidden thinking label not supported in RPC-like modes - requires TUI message rendering access
			},

			setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
				// Only support string arrays in RPC-like modes - factory functions are ignored
				if (content === undefined || Array.isArray(content)) {
					output({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "setWidget",
						widgetKey: key,
						widgetLines: content as string[] | undefined,
						widgetPlacement: options?.placement,
					} as RpcExtensionUIRequest);
				}
				// Component factories are not supported in RPC-like modes - would need TUI access
			},

			setFooter(_factory: unknown): void {
				// Custom footer not supported in RPC-like modes - requires TUI access
			},

			setHeader(_factory: unknown): void {
				// Custom header not supported in RPC-like modes - requires TUI access
			},

			setTitle(title: string): void {
				// Fire and forget - host can implement title control
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setTitle",
					title,
				} as RpcExtensionUIRequest);
			},

			async custom() {
				// Custom UI not supported in RPC-like modes
				return undefined as never;
			},

			pasteToEditor(text: string): void {
				// Paste handling not supported in RPC-like modes - falls back to setEditorText
				uiContext.setEditorText(text);
			},

			setEditorText(text: string): void {
				// Fire and forget - host can implement editor control
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "set_editor_text",
					text,
				} as RpcExtensionUIRequest);
			},

			getEditorText(): string {
				// Synchronous method can't wait for a response
				// Host should track editor state locally if needed
				return "";
			},

			async editor(title: string, prefill?: string): Promise<string | undefined> {
				const id = crypto.randomUUID();
				return new Promise((resolve, reject) => {
					pendingExtensionRequests.set(id, {
						resolve: (response: RpcExtensionUIResponse) => {
							if ("cancelled" in response && response.cancelled) {
								resolve(undefined);
							} else if ("value" in response) {
								resolve(response.value);
							} else {
								resolve(undefined);
							}
						},
						reject,
					});
					output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
				});
			},

			addAutocompleteProvider(): void {
				// Autocomplete provider composition is not supported in RPC-like modes
			},

			setEditorComponent(): void {
				// Custom editor components are not supported in RPC-like modes
			},

			getEditorComponent() {
				// Custom editor components are not supported in RPC-like modes
				return undefined;
			},

			get theme() {
				return theme;
			},

			getAllThemes() {
				return [];
			},

			getTheme(_name: string) {
				return undefined;
			},

			setTheme(_theme: string | Theme) {
				// Theme switching not supported in RPC-like modes
				return { success: false, error: "Theme switching not supported in RPC mode" };
			},

			getToolsExpanded() {
				// Tool expansion not supported in RPC-like modes - no TUI
				return false;
			},

			setToolsExpanded(_expanded: boolean) {
				// Tool expansion not supported in RPC-like modes - no TUI
			},
		};
		return uiContext;
	}

	async init(): Promise<void> {
		this.runtime.setRebindSession(async () => {
			await this.rebindSession();
		});
		await this.rebindSession();
	}

	private async rebindSession(): Promise<void> {
		this.session = this.runtime.session;
		await this.session.bindExtensions({
			uiContext: this.createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => this.runtime.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await this.runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return this.runtime.switchSession(sessionPath, options);
				},
				reload: async () => {
					await this.session.reload();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
			},
			onError: (err) => {
				this.output({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
		});

		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.unsubscribe = this.session.subscribe((event) => {
			this.output(toJsonEvent(event));
			if (event.type === "agent_settled" && this.shutdownRequested) {
				this.onShutdownRequested?.();
			}
		});
		this.unsubscribeBackpressure = this.session.agent.subscribe(async () => {
			await this.applyBackpressure();
		});
	}

	/** Stop forwarding events without disposing the runtime. */
	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeBackpressure?.();
		this.unsubscribeBackpressure = undefined;
	}

	/** Dispose the underlying runtime. */
	async dispose(): Promise<void> {
		this.close();
		await this.runtime.dispose();
	}

	handleExtensionUIResponse(response: RpcExtensionUIResponse): void {
		const pending = this.pendingExtensionRequests.get(response.id);
		if (pending) {
			this.pendingExtensionRequests.delete(response.id);
			pending.resolve(response);
		}
	}

	// Handle a single command
	async handleCommand(command: RpcCommand): Promise<RpcResponse | undefined> {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void this.session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								this.output(rpcSuccess(id, "prompt"));
								void this.applyBackpressure();
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							this.output(rpcError(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await this.session.steer(command.message, command.images);
				return rpcSuccess(id, "steer");
			}

			case "follow_up": {
				await this.session.followUp(command.message, command.images);
				return rpcSuccess(id, "follow_up");
			}

			case "abort": {
				await this.session.abort();
				return rpcSuccess(id, "abort");
			}

			case "clear_queue": {
				return rpcSuccess(id, "clear_queue", this.session.clearQueue());
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await this.runtime.newSession(options);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return rpcSuccess(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: this.session.model,
					thinkingLevel: this.session.thinkingLevel,
					isStreaming: this.session.isStreaming,
					isCompacting: this.session.isCompacting,
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					sessionFile: this.session.sessionFile,
					sessionId: this.session.sessionId,
					sessionName: this.session.sessionName,
					autoCompactionEnabled: this.session.autoCompactionEnabled,
					messageCount: this.session.messages.length,
					pendingMessageCount: this.session.pendingMessageCount,
				};
				return rpcSuccess(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = this.session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return rpcError(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await this.session.setModel(model);
				return rpcSuccess(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await this.session.cycleModel();
				if (!result) {
					return rpcSuccess(id, "cycle_model", null);
				}
				return rpcSuccess(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = this.session.modelRuntime.getAvailableSnapshot();
				return rpcSuccess(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				this.session.setThinkingLevel(command.level);
				return rpcSuccess(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = this.session.cycleThinkingLevel();
				if (!level) {
					return rpcSuccess(id, "cycle_thinking_level", null);
				}
				return rpcSuccess(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = this.session.getAvailableThinkingLevels();
				return rpcSuccess(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				this.session.setSteeringMode(command.mode);
				return rpcSuccess(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				this.session.setFollowUpMode(command.mode);
				return rpcSuccess(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await this.session.compact(command.customInstructions);
				return rpcSuccess(id, "compact", result);
			}

			case "set_auto_compaction": {
				this.session.setAutoCompactionEnabled(command.enabled);
				return rpcSuccess(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				this.session.setAutoRetryEnabled(command.enabled);
				return rpcSuccess(id, "set_auto_retry");
			}

			case "abort_retry": {
				this.session.abortRetry();
				return rpcSuccess(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await this.session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: this.session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					this.session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return rpcSuccess(id, "bash", eventResult.result);
				}

				const result = await this.session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return rpcSuccess(id, "bash", result);
			}

			case "abort_bash": {
				this.session.abortBash();
				return rpcSuccess(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = this.session.getSessionStats();
				return rpcSuccess(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await this.session.exportToHtml(command.outputPath);
				return rpcSuccess(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await this.runtime.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return rpcSuccess(id, "switch_session", result);
			}

			case "fork": {
				const result = await this.runtime.fork(command.entryId);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return rpcSuccess(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = this.session.sessionManager.getLeafId();
				if (!leafId) {
					return rpcError(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await this.runtime.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return rpcSuccess(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = this.session.getUserMessagesForForking();
				return rpcSuccess(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = this.session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return rpcError(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return rpcSuccess(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = this.session.sessionManager;
				return rpcSuccess(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = this.session.getLastAssistantText();
				return rpcSuccess(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return rpcError(id, "set_session_name", "Session name cannot be empty");
				}
				this.session.setSessionName(name);
				return rpcSuccess(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return rpcSuccess(id, "get_messages", { messages: this.session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of this.session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of this.session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of this.session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return rpcSuccess(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				if (this.extraCommandHandler) {
					const response = await this.extraCommandHandler(command, this);
					if (response !== undefined) {
						return response;
					}
				}
				return rpcError(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	}
}
