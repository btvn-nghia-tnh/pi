/**
 * Central store. Pure state transitions (testable in node without DOM);
 * the app subscribes and re-renders.
 */

import type {
	AgentEventMessage,
	AgentMessage,
	ConnectedPayload,
	RpcKeybindingsPayload,
	RpcSessionState,
	RpcSettingsSnapshot,
	RpcSlashCommandUi,
	RpcThemeInfo,
	RpcTrustState,
	UsageInfo,
} from "./types.ts";

export interface ToolCardState {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError: boolean;
	expanded: boolean;
}

export interface RetryState {
	attempt: number;
	maxAttempts: number;
	until: number;
	errorMessage: string;
}

export interface CompactionState {
	reason: string;
}

export type TranscriptItemKind =
	| "user"
	| "assistant"
	| "bashExecution"
	| "custom"
	| "compaction"
	| "branchSummary"
	| "notice"
	| "error";

export interface TranscriptItem {
	kind: TranscriptItemKind;
	id: string;
	message?: AgentMessage;
	streaming: boolean;
	toolCards: Map<string, ToolCardState>;
	notice?: { text: string; level: "info" | "warning" | "error" };
}

export interface QueueState {
	steering: string[];
	followUp: string[];
}

export interface WorkingIndicator {
	frames: string[];
	intervalMs: number;
}

export interface AppState {
	connected: boolean;
	version: string;
	sessionState: RpcSessionState | undefined;
	items: TranscriptItem[];
	itemIndex: Map<string, TranscriptItem>;
	queue: QueueState;
	toolsExpanded: boolean;
	thinkingVisible: boolean;
	hideThinkingBlock: boolean;
	footerUsage: UsageTotals;
	latestUsage: UsageInfo | undefined;
	contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	contextInfo: ConnectedPayload["contextInfo"];
	trust: RpcTrustState | undefined;
	themes: RpcThemeInfo[];
	currentTheme: string;
	settings: RpcSettingsSnapshot | undefined;
	commands: RpcSlashCommandUi[];
	extensionStatuses: Map<string, string>;
	widgets: Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor"; data?: Record<string, unknown> }>;
	notifications: Array<{ id: string; text: string; level: "info" | "warning" | "error" }>;
	workingIndicator: WorkingIndicator | undefined;
	retry: RetryState | undefined;
	compaction: CompactionState | undefined;
	settingsSnapshot: RpcSettingsSnapshot | undefined;
	keybindings: RpcKeybindingsPayload | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function createInitialState(): AppState {
	return {
		connected: false,
		version: "",
		sessionState: undefined,
		items: [],
		itemIndex: new Map(),
		queue: { steering: [], followUp: [] },
		toolsExpanded: false,
		thinkingVisible: true,
		hideThinkingBlock: false,
		footerUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		latestUsage: undefined,
		contextUsage: null,
		contextInfo: undefined,
		trust: undefined,
		themes: [],
		currentTheme: "dark",
		settings: undefined,
		commands: [],
		extensionStatuses: new Map(),
		widgets: new Map(),
		notifications: [],
		workingIndicator: undefined,
		retry: undefined,
		compaction: undefined,
		settingsSnapshot: undefined,
		keybindings: undefined,
	};
}

export type StoreListener = () => void;

export class Store {
	private state: AppState = createInitialState();
	private readonly listeners = new Set<StoreListener>();

	getState(): Readonly<AppState> {
		return this.state;
	}

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	update(mutator: (state: AppState) => void): void {
		// Mutate a shallow clone so listeners can compare references.
		const next: AppState = {
			...this.state,
			itemIndex: this.state.itemIndex,
			footerUsage: { ...this.state.footerUsage },
		};
		mutator(next);
		this.state = next;
		this.emit();
	}

	// ------------------------------------------------------------------
	// Connected payload
	// ------------------------------------------------------------------

	applyConnected(payload: ConnectedPayload): void {
		this.update((state) => {
			state.connected = true;
			state.version = payload.version;
			state.sessionState = payload.state;
			state.contextInfo = payload.contextInfo;
			state.trust = payload.trust;
			state.items = [];
			state.itemIndex = new Map();
			for (const message of payload.messages ?? []) {
				if (isHiddenMessageRole(message.role)) continue;
				const item = messageToItem(message, false);
				state.items.push(item);
				state.itemIndex.set(item.id, item);
			}
			if (payload.contextInfo?.commands) {
				state.commands = payload.contextInfo.commands;
			}
			if (payload.keybindings) {
				state.keybindings = payload.keybindings;
			}
			state.widgets = new Map();
			for (const widget of payload.widgets ?? []) {
				state.widgets.set(widget.key, {
					lines: widget.lines ?? [],
					placement: widget.placement ?? "aboveEditor",
					data: widget.data,
				});
			}
			state.extensionStatuses = new Map();
			for (const status of payload.statuses ?? []) {
				state.extensionStatuses.set(status.key, status.text);
			}
		});
	}

	markDisconnected(): void {
		this.update((state) => {
			state.connected = false;
			state.retry = undefined;
			state.compaction = undefined;
		});
	}

	// ------------------------------------------------------------------
	// Session state
	// ------------------------------------------------------------------

	setSessionState(sessionState: RpcSessionState): void {
		this.update((state) => {
			state.sessionState = sessionState;
		});
	}

	setContextInfo(contextInfo: NonNullable<ConnectedPayload["contextInfo"]>): void {
		this.update((state) => {
			state.contextInfo = contextInfo;
			if (contextInfo.commands) state.commands = contextInfo.commands;
		});
	}

	setTrust(trust: RpcTrustState): void {
		this.update((state) => {
			state.trust = trust;
		});
	}

	setThemes(themes: RpcThemeInfo[], current: string): void {
		this.update((state) => {
			state.themes = themes;
			state.currentTheme = current;
		});
	}

	applyThemeChanged(name: string): void {
		this.update((state) => {
			state.currentTheme = name;
		});
	}

	setSettingsSnapshot(settings: RpcSettingsSnapshot): void {
		this.update((state) => {
			state.settings = settings;
			state.settingsSnapshot = settings;
			state.hideThinkingBlock = settings.effective.hideThinkingBlock === true;
		});
	}

	// ------------------------------------------------------------------
	// Events
	// ------------------------------------------------------------------

	applyAgentEvent(event: AgentEventMessage): void {
		switch (event.type) {
			case "agent_start":
				this.update((state) => {
					if (state.sessionState) state.sessionState = { ...state.sessionState, isStreaming: true };
					state.retry = undefined;
				});
				break;
			case "agent_settled":
				this.update((state) => {
					if (state.sessionState) state.sessionState = { ...state.sessionState, isStreaming: false };
					for (const item of state.items) {
						if (item.streaming) item.streaming = false;
					}
					state.retry = undefined;
				});
				break;
			case "message_start":
				this.handleMessageStart(event);
				break;
			case "message_update":
				this.handleMessageUpdate(event);
				break;
			case "message_end":
				this.handleMessageEnd(event);
				break;
			case "turn_end":
				this.handleTurnEnd(event);
				break;
			case "tool_execution_start":
				this.handleToolExecutionStart(event);
				break;
			case "tool_execution_update":
				this.handleToolExecutionUpdate(event);
				break;
			case "tool_execution_end":
				this.handleToolExecutionEnd(event);
				break;
			case "queue_update":
				this.update((state) => {
					state.queue = {
						steering: (event.steering as string[]) ?? [],
						followUp: (event.followUp as string[]) ?? [],
					};
				});
				break;
			case "compaction_start":
				this.update((state) => {
					state.compaction = { reason: String(event.reason ?? "manual") };
				});
				break;
			case "compaction_end":
				this.update((state) => {
					state.compaction = undefined;
					const result = event.result as { summary?: string } | null | undefined;
					if (result?.summary) {
						const item: TranscriptItem = {
							kind: "compaction",
							id: `compaction-${Date.now()}-${Math.random().toString(36).slice(2)}`,
							streaming: false,
							toolCards: new Map(),
							notice: { text: result.summary, level: "info" },
						};
						state.items.push(item);
						state.itemIndex.set(item.id, item);
					}
				});
				break;
			case "auto_retry_start":
				this.update((state) => {
					state.retry = {
						attempt: Number(event.attempt ?? 0),
						maxAttempts: Number(event.maxAttempts ?? 0),
						until: Date.now() + Number(event.delayMs ?? 0),
						errorMessage: String(event.errorMessage ?? ""),
					};
				});
				break;
			case "auto_retry_end":
				this.update((state) => {
					state.retry = undefined;
				});
				break;
			case "bash_execution_update":
				this.handleBashExecutionUpdate(event);
				break;
			case "extension_error":
				this.pushNotification(String(event.error ?? "Extension error"), "error");
				break;
			default:
				break;
		}
	}

	private handleMessageStart(event: AgentEventMessage): void {
		const message = event.message as AgentMessage | undefined;
		if (!message || isHiddenMessageRole(message.role)) return;
		this.update((state) => {
			const item = messageToItem(message, true);
			// Replace a streaming placeholder with the same id if present.
			const existing = state.itemIndex.get(item.id);
			if (existing) {
				existing.message = message;
				existing.streaming = true;
				return;
			}
			state.items.push(item);
			state.itemIndex.set(item.id, item);
		});
	}

	private handleMessageUpdate(event: AgentEventMessage): void {
		const delta = event.assistantMessageEvent as
			| {
					type: string;
					contentIndex?: number;
					delta?: string;
					id?: string;
					toolName?: string;
					toolCall?: AgentMessage;
			  }
			| undefined;
		const usage = event.usage as UsageInfo | undefined;
		if (usage) {
			this.update((state) => {
				state.latestUsage = usage;
			});
		}
		if (!delta) return;
		this.update((state) => {
			const streaming = findStreamingAssistant(state);
			if (!streaming?.message || streaming.message.role !== "assistant") return;
			const contentIndex = delta.contentIndex ?? 0;
			const content = streaming.message.content as unknown[];
			while (content.length <= contentIndex) {
				content.push({});
			}
			const block = content[contentIndex] as Record<string, unknown>;
			const ensureBlockType = (blockType: string): boolean => {
				if (block.type === undefined) {
					block.type = blockType;
				}
				return block.type === blockType;
			};
			if (delta.type === "text_delta") {
				if (ensureBlockType("text")) {
					block.text = String(block.text ?? "") + String(delta.delta ?? "");
				}
			} else if (delta.type === "thinking_delta") {
				if (ensureBlockType("thinking")) {
					block.thinking = String(block.thinking ?? "") + String(delta.delta ?? "");
				}
			} else if (delta.type === "toolcall_start") {
				content[contentIndex] = {
					type: "toolCall",
					id: String(delta.id ?? ""),
					name: String(delta.toolName ?? ""),
					arguments: "",
				};
			} else if (delta.type === "toolcall_delta") {
				if (block.type === "toolCall") {
					block.arguments = String(block.arguments ?? "") + String(delta.delta ?? "");
				}
			} else if (delta.type === "toolcall_end" && delta.toolCall) {
				content[contentIndex] = delta.toolCall;
				const toolCall = delta.toolCall as { id?: string };
				if (toolCall.id) {
					ensureToolCard(
						streaming,
						toolCall.id,
						String((toolCall as { name?: string }).name ?? ""),
						(toolCall as { arguments?: unknown }).arguments,
					);
				}
			}
		});
	}

	private handleMessageEnd(event: AgentEventMessage): void {
		const message = event.message as AgentMessage | undefined;
		if (!message) return;
		this.update((state) => {
			const existing = state.itemIndex.get(messageId(message));
			if (existing) {
				existing.message = message;
				existing.streaming = false;
				if (message.role === "assistant") {
					const usage = (message as { usage?: UsageInfo }).usage;
					if (usage) {
						state.footerUsage = addUsage(state.footerUsage, usage);
					}
				}
			} else if (!isHiddenMessageRole(message.role)) {
				const item = messageToItem(message, false);
				state.items.push(item);
				state.itemIndex.set(item.id, item);
			}
		});
	}

	private handleTurnEnd(event: AgentEventMessage): void {
		// Tool results arrive here; attach to tool cards.
		const toolResults = (event.toolResults as AgentMessage[] | undefined) ?? [];
		this.update((state) => {
			for (const result of toolResults) {
				if (result.role !== "toolResult") continue;
				const toolCallId = (result as { toolCallId?: string }).toolCallId;
				if (!toolCallId) continue;
				for (const item of state.items) {
					const card = item.toolCards.get(toolCallId);
					if (card) {
						card.result = result;
						card.isError = (result as { isError?: boolean }).isError === true;
					}
				}
			}
		});
	}

	private handleToolExecutionStart(event: AgentEventMessage): void {
		const toolCallId = String(event.toolCallId ?? "");
		if (!toolCallId) return;
		this.update((state) => {
			const streaming = findStreamingAssistant(state);
			const card: ToolCardState = {
				toolCallId,
				toolName: String(event.toolName ?? ""),
				args: event.args,
				partialResult: undefined,
				result: undefined,
				isError: false,
				expanded: state.toolsExpanded,
			};
			if (streaming) {
				streaming.toolCards.set(toolCallId, card);
			} else {
				const last = state.items[state.items.length - 1];
				if (last) last.toolCards.set(toolCallId, card);
			}
		});
	}

	private handleToolExecutionUpdate(event: AgentEventMessage): void {
		const toolCallId = String(event.toolCallId ?? "");
		if (!toolCallId) return;
		this.update((state) => {
			const card = findToolCard(state, toolCallId);
			if (card) card.partialResult = event.partialResult;
		});
	}

	private handleToolExecutionEnd(event: AgentEventMessage): void {
		const toolCallId = String(event.toolCallId ?? "");
		if (!toolCallId) return;
		this.update((state) => {
			const card = findToolCard(state, toolCallId);
			if (card) {
				card.result = event.result;
				card.isError = event.isError === true;
				card.partialResult = undefined;
				const usage = (event.result as { usage?: UsageInfo } | undefined)?.usage;
				if (usage) {
					state.footerUsage = addUsage(state.footerUsage, usage);
				}
			}
		});
	}

	private handleBashExecutionUpdate(event: AgentEventMessage): void {
		const id = `bash-exec-${String(event.id ?? "live")}`;
		const delta = String(event.delta ?? "");
		this.update((state) => {
			let item = state.itemIndex.get(id);
			if (!item) {
				item = {
					kind: "bashExecution",
					id,
					streaming: true,
					toolCards: new Map(),
					message: undefined,
				};
				state.items.push(item);
				state.itemIndex.set(id, item);
			}
			item.notice = {
				text: `${(item.notice?.text ?? "") + delta}`,
				level: "info",
			};
		});
	}

	// ------------------------------------------------------------------
	// UI state
	// ------------------------------------------------------------------

	toggleToolCard(toolCallId: string): void {
		this.update((state) => {
			const card = findToolCard(state, toolCallId);
			if (card) card.expanded = !card.expanded;
		});
	}

	setToolsExpanded(expanded: boolean): void {
		this.update((state) => {
			state.toolsExpanded = expanded;
			for (const item of state.items) {
				for (const card of item.toolCards.values()) {
					card.expanded = expanded;
				}
			}
		});
	}

	toggleThinkingVisible(): void {
		this.update((state) => {
			state.thinkingVisible = !state.thinkingVisible;
		});
	}

	pushNotification(text: string, level: "info" | "warning" | "error"): void {
		this.update((state) => {
			state.notifications = [
				...state.notifications,
				{ id: `n-${Date.now()}-${Math.random().toString(36).slice(2)}`, text, level },
			];
		});
	}

	dismissNotification(id: string): void {
		this.update((state) => {
			state.notifications = state.notifications.filter((notification) => notification.id !== id);
		});
	}

	setExtensionStatus(key: string, text: string | undefined): void {
		this.update((state) => {
			if (text === undefined || text === null || text === "") {
				state.extensionStatuses.delete(key);
			} else {
				state.extensionStatuses = new Map(state.extensionStatuses);
				state.extensionStatuses.set(key, text);
			}
		});
	}

	setWidget(key: string, lines: string[] | undefined, placement: "aboveEditor" | "belowEditor"): void {
		this.update((state) => {
			state.widgets = new Map(state.widgets);
			if (lines === undefined || lines === null) {
				state.widgets.delete(key);
			} else {
				const existing = state.widgets.get(key);
				state.widgets.set(key, { lines, placement, data: existing?.data });
			}
		});
	}

	setWidgetData(key: string, data: Record<string, unknown> | undefined): void {
		this.update((state) => {
			state.widgets = new Map(state.widgets);
			if (data === undefined || data === null) {
				const existing = state.widgets.get(key);
				if (existing) {
					state.widgets.set(key, { ...existing, data: undefined });
				}
			} else {
				const existing = state.widgets.get(key);
				state.widgets.set(key, {
					lines: existing?.lines ?? [],
					placement: existing?.placement ?? "aboveEditor",
					data,
				});
			}
		});
	}

	setWorkingIndicator(frames: string[] | undefined, intervalMs: number | undefined): void {
		this.update((state) => {
			state.workingIndicator =
				frames === undefined || frames === null ? undefined : { frames, intervalMs: intervalMs ?? 120 };
		});
	}

	setContextUsage(tokens: number | null, contextWindow: number, percent: number | null): void {
		this.update((state) => {
			state.contextUsage = { tokens, contextWindow, percent };
		});
	}
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function messageId(message: AgentMessage): string {
	return `${message.role}-${(message as { timestamp?: number }).timestamp ?? "0"}`;
}

/** Roles that render inside other components (tool cards) or not at all. */
function isHiddenMessageRole(role: string): boolean {
	// Tool results render inside their tool cards; thinking-level and model
	// change entries are metadata the UI reads from state instead.
	return role === "toolResult";
}

function messageToItem(message: AgentMessage, streaming: boolean): TranscriptItem {
	const item: TranscriptItem = {
		kind:
			message.role === "user"
				? "user"
				: message.role === "assistant"
					? "assistant"
					: message.role === "bashExecution"
						? "bashExecution"
						: message.role === "custom"
							? "custom"
							: "notice",
		id: messageId(message),
		message,
		streaming,
		toolCards: new Map(),
	};
	if (message.role === "assistant") {
		const content = (message as { content?: unknown[] }).content ?? [];
		for (const block of content) {
			const toolCall = block as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (toolCall?.type === "toolCall" && toolCall.id) {
				ensureToolCard(item, toolCall.id, String(toolCall.name ?? ""), toolCall.arguments);
			}
		}
	}
	return item;
}

function ensureToolCard(item: TranscriptItem, toolCallId: string, toolName: string, args: unknown): void {
	if (!item.toolCards.has(toolCallId)) {
		item.toolCards.set(toolCallId, {
			toolCallId,
			toolName,
			args,
			partialResult: undefined,
			result: undefined,
			isError: false,
			expanded: false,
		});
	}
}

function findStreamingAssistant(state: AppState): TranscriptItem | undefined {
	for (let i = state.items.length - 1; i >= 0; i--) {
		const item = state.items[i]!;
		if (item.kind === "assistant" && item.streaming) return item;
	}
	return undefined;
}

function findToolCard(state: AppState, toolCallId: string): ToolCardState | undefined {
	for (let i = state.items.length - 1; i >= 0; i--) {
		const card = state.items[i]!.toolCards.get(toolCallId);
		if (card) return card;
	}
	return undefined;
}

function addUsage(totals: UsageTotals, usage: UsageInfo): UsageTotals {
	return {
		input: totals.input + (usage.input ?? 0),
		output: totals.output + (usage.output ?? 0),
		cacheRead: totals.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: totals.cacheWrite + (usage.cacheWrite ?? 0),
		cost: totals.cost + (usage.cost?.total ?? 0),
	};
}
