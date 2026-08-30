/**
 * Client-side protocol types (mirror of the coding-agent RPC types).
 * Only the subset the UI sends or renders.
 */

/**
 * Local structural mirrors of the agent message shapes. The UI consumes
 * them as plain JSON over the WebSocket; keeping them local avoids pulling
 * Node-typed workspace sources into the browser typecheck.
 */
export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export type AgentMessageRole = "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | string;

export interface AgentMessage {
	role: AgentMessageRole;
	content: unknown;
	timestamp?: number;
	usage?: UsageInfo;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	data?: unknown;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	fullOutputPath?: string | null;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface RpcCommandBase {
	id?: string;
}

export type ClientCommand =
	| (RpcCommandBase & {
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  })
	| (RpcCommandBase & { type: "steer"; message: string; images?: ImageContent[] })
	| (RpcCommandBase & { type: "follow_up"; message: string; images?: ImageContent[] })
	| (RpcCommandBase & { type: "abort" })
	| (RpcCommandBase & { type: "clear_queue" })
	| (RpcCommandBase & { type: "new_session"; parentSession?: string })
	| (RpcCommandBase & { type: "get_state" })
	| (RpcCommandBase & { type: "set_model"; provider: string; modelId: string })
	| (RpcCommandBase & { type: "cycle_model" })
	| (RpcCommandBase & { type: "get_available_models" })
	| (RpcCommandBase & { type: "set_thinking_level"; level: ThinkingLevel })
	| (RpcCommandBase & { type: "cycle_thinking_level" })
	| (RpcCommandBase & { type: "get_available_thinking_levels" })
	| (RpcCommandBase & { type: "set_steering_mode"; mode: "all" | "one-at-a-time" })
	| (RpcCommandBase & { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" })
	| (RpcCommandBase & { type: "compact"; customInstructions?: string })
	| (RpcCommandBase & { type: "set_auto_compaction"; enabled: boolean })
	| (RpcCommandBase & { type: "set_auto_retry"; enabled: boolean })
	| (RpcCommandBase & { type: "abort_retry" })
	| (RpcCommandBase & { type: "bash"; command: string; excludeFromContext?: boolean })
	| (RpcCommandBase & { type: "abort_bash" })
	| (RpcCommandBase & { type: "get_session_stats" })
	| (RpcCommandBase & { type: "export_html"; outputPath?: string })
	| (RpcCommandBase & { type: "switch_session"; sessionPath: string })
	| (RpcCommandBase & { type: "fork"; entryId: string })
	| (RpcCommandBase & { type: "clone" })
	| (RpcCommandBase & { type: "get_fork_messages" })
	| (RpcCommandBase & { type: "get_entries"; since?: string })
	| (RpcCommandBase & { type: "get_tree" })
	| (RpcCommandBase & { type: "get_last_assistant_text" })
	| (RpcCommandBase & { type: "set_session_name"; name: string })
	| (RpcCommandBase & { type: "get_messages" })
	| (RpcCommandBase & { type: "get_commands" })
	| (RpcCommandBase & { type: "list_sessions"; scope?: "cwd" | "all" })
	| (RpcCommandBase & { type: "delete_session"; sessionPath: string })
	| (RpcCommandBase & { type: "rename_session"; sessionPath: string; name: string })
	| (RpcCommandBase & {
			type: "navigate_tree";
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  })
	| (RpcCommandBase & { type: "import_session"; path: string; cwd?: string })
	| (RpcCommandBase & { type: "get_context_info" })
	| (RpcCommandBase & { type: "get_changelog" })
	| (RpcCommandBase & { type: "get_keybindings" })
	| (RpcCommandBase & { type: "search_files"; query?: string; limit?: number })
	| (RpcCommandBase & { type: "get_session_dir" })
	| (RpcCommandBase & { type: "reload" })
	| (RpcCommandBase & { type: "export_session"; path?: string })
	| (RpcCommandBase & { type: "share_session" })
	| (RpcCommandBase & { type: "get_settings" })
	| (RpcCommandBase & { type: "set_settings"; scope: "global" | "project"; values: Record<string, unknown> })
	| (RpcCommandBase & { type: "get_themes" })
	| (RpcCommandBase & { type: "set_theme"; name: string })
	| (RpcCommandBase & { type: "auth_status" })
	| (RpcCommandBase & { type: "auth_login"; provider: string; method: "api_key" | "oauth" })
	| (RpcCommandBase & { type: "auth_logout"; provider: string })
	| (RpcCommandBase & { type: "get_trust" })
	| (RpcCommandBase & { type: "set_trust"; trusted: boolean; optionIndex?: number });

export interface RpcResponseMessage {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	missingCwd?: boolean;
}

export interface RpcSessionState {
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface SourceInfo {
	path?: string;
	location?: "user" | "project" | "path";
}

export interface RpcSlashCommandUi {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo?: SourceInfo;
}

export interface RpcSessionSummary {
	file: string;
	id: string;
	name?: string;
	cwd: string;
	parentSession?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface RpcContextInfo {
	version: string;
	cwd: string;
	gitBranch?: string;
	contextFiles: Array<{ path: string; source: string }>;
	skills: Array<{ name: string; description: string; sourceInfo?: SourceInfo }>;
	promptTemplates: Array<{ name: string; description: string; sourceInfo?: SourceInfo }>;
	extensions: Array<{ name: string; sourceInfo?: SourceInfo }>;
	commands: RpcSlashCommandUi[];
	themeNames: string[];
	experimental: boolean;
	isUsingSubscription: boolean;
	agentDir: string;
	isTrusted: boolean;
}

export interface RpcTrustState {
	trusted: boolean;
	options: Array<{ label: string; trusted: boolean; savedPath?: string }>;
	savedDecision?: { path: string; decision: boolean };
	trustPath?: string;
}

export interface RpcKeybindingsPayload {
	bindings: Array<{ id: string; keys: string[]; description?: string }>;
}

export interface RpcSettingsSnapshot {
	global: Record<string, unknown>;
	project: Record<string, unknown>;
	effective: Record<string, unknown>;
	paths: { global?: string; project?: string };
	errors: string[];
}

export interface RpcThemeInfo {
	name: string;
	vars: Record<string, string>;
}

export interface ConnectedWidgetState {
	key: string;
	lines?: string[];
	placement?: "aboveEditor" | "belowEditor";
	data?: Record<string, unknown>;
}

export interface ConnectedPayload {
	type: "connected";
	version: string;
	widgets?: ConnectedWidgetState[];
	statuses?: Array<{ key: string; text: string }>;
	themes?: RpcThemeInfo[];
	theme?: { name: string; vars: Record<string, string> };
	state?: RpcSessionState;
	messages: AgentMessage[];
	contextInfo?: RpcContextInfo;
	trust?: RpcTrustState;
	keybindings?: RpcKeybindingsPayload;
}

export interface ServerShutdownMessage {
	type: "server_shutdown";
	reason?: string;
}

export interface ThemeChangedMessage {
	type: "theme_changed";
	name: string;
	vars: Record<string, string>;
}

export interface AuthChangedMessage {
	type: "auth_changed";
	provider: string;
}

export type ExtensionUiRequestMethod =
	| "setWidgetData"
	| "select"
	| "confirm"
	| "input"
	| "editor"
	| "notify"
	| "setStatus"
	| "setWidget"
	| "setTitle"
	| "set_editor_text"
	| "setWorkingIndicator"
	| "auth_prompt"
	| "auth_event";

export interface ExtensionUiRequestMessage {
	type: "extension_ui_request";
	id: string;
	method: ExtensionUiRequestMethod;
	title?: string;
	message?: string;
	options?: Array<{ id: string; label: string; description?: string }>;
	timeout?: number;
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string | undefined;
	widgetKey?: string;
	widgetLines?: string[] | undefined;
	widgetPlacement?: "aboveEditor" | "belowEditor";
	widgetData?: Record<string, unknown> | undefined;
	title2?: string;
	text?: string;
	frames?: string[] | undefined;
	intervalMs?: number;
	promptType?: string;
	event?: string;
	url?: string;
	instructions?: string;
	userCode?: string;
	verificationUri?: string;
	links?: Array<{ url: string; label?: string }>;
}

export interface ExtensionUiResponseMessage {
	type: "extension_ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

/** Agent session events, as serialized by the RPC core (json-event.ts). */
export interface AgentEventMessage {
	type: string;
	[key: string]: unknown;
}

export type ServerMessage =
	| RpcResponseMessage
	| ConnectedPayload
	| ServerShutdownMessage
	| ThemeChangedMessage
	| AuthChangedMessage
	| ExtensionUiRequestMessage
	| AgentEventMessage;

export interface UsageInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface AssistantMessageEvent {
	type: string;
	contentIndex?: number;
	delta?: string;
	id?: string;
	toolName?: string;
	toolCall?: unknown;
	content?: string;
}
