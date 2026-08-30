/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Web GUI parity: interactive widget responses (setWidgetData overlays
	// that collect user input, e.g. questionnaires)
	| { id?: string; type: "widget_response"; key: string; payload: unknown }

	// Web GUI parity: session management
	| { id?: string; type: "list_sessions"; scope?: "cwd" | "all" }
	| { id?: string; type: "delete_session"; sessionPath: string }
	| { id?: string; type: "rename_session"; sessionPath: string; name: string }
	| {
			id?: string;
			type: "navigate_tree";
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }
	| { id?: string; type: "import_session"; path: string; cwd?: string }

	// Web GUI parity: context and info
	| { id?: string; type: "get_tools" }
	| { id?: string; type: "get_context_info" }
	| { id?: string; type: "get_changelog" }
	| { id?: string; type: "get_keybindings" }
	| { id?: string; type: "search_files"; query?: string; limit?: number }
	| { id?: string; type: "get_session_dir" }
	| { id?: string; type: "reload" }
	| { id?: string; type: "export_session"; path?: string }
	| { id?: string; type: "share_session" }

	// Web GUI parity: settings and themes
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_settings"; scope: "global" | "project"; values: Record<string, unknown> }
	| { id?: string; type: "get_themes" }
	| { id?: string; type: "set_theme"; name: string }

	// Web GUI parity: auth and trust
	| { id?: string; type: "auth_status" }
	| { id?: string; type: "auth_login"; provider: string; method: "api_key" | "oauth" }
	| { id?: string; type: "auth_logout"; provider: string }
	| { id?: string; type: "get_trust" }
	| {
			id?: string;
			type: "set_trust";
			trusted: boolean;
			optionIndex?: number;
	  };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
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

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: { steering: string[]; followUp: string[] };
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "widget_response"; success: true; data: { delivered: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Web GUI parity: session management
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: RpcSessionSummary[] } }
	| { id?: string; type: "response"; command: "delete_session"; success: true; data: { method: "trash" | "unlink" } }
	| { id?: string; type: "response"; command: "rename_session"; success: true }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			data: { editorText?: string; cancelled: boolean };
	  }
	| { id?: string; type: "response"; command: "import_session"; success: true; data: { cancelled: boolean } }

	// Web GUI parity: context and info
	| {
			id?: string;
			type: "response";
			command: "get_tools";
			success: true;
			data: { tools: Array<{ name: string; active: boolean; source?: string }> };
	  }
	| { id?: string; type: "response"; command: "get_context_info"; success: true; data: RpcContextInfo }
	| { id?: string; type: "response"; command: "get_changelog"; success: true; data: { markdown: string } }
	| {
			id?: string;
			type: "response";
			command: "get_keybindings";
			success: true;
			data: { bindings: RpcKeybindingInfo[] };
	  }
	| { id?: string; type: "response"; command: "search_files"; success: true; data: { files: string[] } }
	| { id?: string; type: "response"; command: "get_session_dir"; success: true; data: { dir: string } }
	| { id?: string; type: "response"; command: "reload"; success: true }
	| { id?: string; type: "response"; command: "export_session"; success: true; data: { path: string } }
	| {
			id?: string;
			type: "response";
			command: "share_session";
			success: true;
			data: { url?: string; gistUrl?: string };
	  }

	// Web GUI parity: settings and themes
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: RpcSettingsSnapshot }
	| { id?: string; type: "response"; command: "set_settings"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_themes";
			success: true;
			data: { themes: RpcThemeInfo[]; current: string };
	  }
	| { id?: string; type: "response"; command: "set_theme"; success: true }

	// Web GUI parity: auth and trust
	| {
			id?: string;
			type: "response";
			command: "auth_status";
			success: true;
			data: { providers: RpcAuthProviderStatus[] };
	  }
	| { id?: string; type: "response"; command: "auth_login"; success: true }
	| { id?: string; type: "response"; command: "auth_logout"; success: true }
	| { id?: string; type: "response"; command: "get_trust"; success: true; data: RpcTrustState }
	| { id?: string; type: "response"; command: "set_trust"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidgetData";
			widgetKey: string;
			widgetData: Record<string, unknown> | undefined;
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWorkingIndicator";
			frames: string[] | undefined;
			intervalMs?: number;
	  };

// Auth prompt bridging (web GUI): dialogs answer via extension_ui_response,
// notify kinds are fire and forget.
export type RpcAuthUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "auth_prompt";
			promptType: "text" | "secret" | "manual_code";
			message: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "auth_prompt";
			promptType: "select";
			message: string;
			options: Array<{ id: string; label: string; description?: string }>;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "auth_event";
			event: "auth_url";
			url: string;
			instructions?: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "auth_event";
			event: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "auth_event";
			event: "info";
			message: string;
			links?: Array<{ url: string; label?: string }>;
	  }
	| { type: "extension_ui_request"; id: string; method: "auth_event"; event: "progress"; message: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Web GUI parity payload types
// ============================================================================

/** Session listing entry for list_sessions. */
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

/** Startup context for the web GUI header. */
export interface RpcContextInfo {
	version: string;
	cwd: string;
	gitBranch?: string;
	contextFiles: Array<{ path: string; source: "global" | "parent" | "project" | "override" }>;
	skills: Array<{ name: string; description: string; sourceInfo: SourceInfo }>;
	promptTemplates: Array<{ name: string; description: string; sourceInfo: SourceInfo }>;
	extensions: Array<{ name: string; sourceInfo: SourceInfo }>;
	commands: RpcSlashCommand[];
	themeNames: string[];
	experimental: boolean;
	isUsingSubscription: boolean;
	agentDir: string;
	isTrusted: boolean;
}

/** One effective keybinding for get_keybindings. */
export interface RpcKeybindingInfo {
	id: string;
	keys: string[];
	description?: string;
}

/** Settings snapshot for get_settings. */
export interface RpcSettingsSnapshot {
	global: Record<string, unknown>;
	project: Record<string, unknown>;
	effective: Record<string, unknown>;
	paths: { global?: string; project?: string };
	errors: string[];
}

/** Theme listing entry for get_themes. */
export interface RpcThemeInfo {
	name: string;
	vars: Record<string, string>;
}

/** Provider auth status for auth_status. */
export interface RpcAuthProviderStatus {
	id: string;
	authenticated: boolean;
	source?: string;
	kind?: "api_key" | "oauth";
	subscription?: boolean;
}

/** Project trust state for get_trust. */
export interface RpcTrustState {
	trusted: boolean;
	options: Array<{ label: string; trusted: boolean; savedPath?: string }>;
	savedDecision?: { path: string; decision: boolean };
	trustPath?: string;
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
