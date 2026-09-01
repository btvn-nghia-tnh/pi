/**
 * Web GUI parity commands for the RPC command core.
 *
 * These commands run over any RpcCore transport (stdio RPC mode and the
 * `pi web` WebSocket server). They expose the session-management, info,
 * settings, auth, and trust surfaces the interactive TUI provides through
 * its own dialogs.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import ignore from "ignore";
import { getAgentDir, getChangelogPath, VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import { areExperimentalFeaturesEnabled } from "../../core/experimental.ts";
import { type Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { resolveReadPath } from "../../core/tools/path-utils.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { getProjectTrustOptions, ProjectTrustStore } from "../../core/trust-manager.ts";
import { parseChangelog } from "../../utils/changelog.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { getAvailableThemesWithPaths, getResolvedThemeColors, getThemeByName } from "../interactive/theme/theme.ts";
import { type RpcCore, rpcError } from "../rpc/rpc-core.ts";
import type {
	RpcCommand,
	RpcContextInfo,
	RpcExtensionUIRequest,
	RpcResponse,
	RpcSlashCommand,
	RpcTrustState,
} from "../rpc/rpc-types.ts";
import { shareSessionHeadless } from "./web-share.ts";

export type WebCommandHandler = (command: RpcCommand, core: RpcCore) => Promise<RpcResponse | undefined>;

interface GitBranchCache {
	cwd: string;
	branch: string | null;
	expires: number;
}

const GIT_BRANCH_TTL_MS = 5000;
let gitBranchCache: GitBranchCache | undefined;

function getGitBranch(cwd: string): string | null {
	const now = Date.now();
	if (gitBranchCache && gitBranchCache.cwd === cwd && gitBranchCache.expires > now) {
		return gitBranchCache.branch;
	}
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() || null : null;
	gitBranchCache = { cwd, branch, expires: now + GIT_BRANCH_TTL_MS };
	return branch;
}

interface FileListCacheEntry {
	dir: string;
	mtimeMs: number;
	files: string[];
}

let fileListCache: FileListCacheEntry | undefined;

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".pi-cache"]);
const MAX_PROJECT_FILES = 20000;
const MAX_WALK_DEPTH = 12;
const MAX_PREVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

function collectProjectFiles(cwd: string): string[] {
	const files: string[] = [];
	const gitignore = ignore();
	const rootIgnorePath = join(cwd, ".gitignore");
	if (existsSync(rootIgnorePath)) {
		try {
			gitignore.add(readFileSync(rootIgnorePath, "utf-8"));
		} catch {
			// Ignore malformed .gitignore files
		}
	}
	const walk = (dir: string, depth: number): void => {
		if (files.length >= MAX_PROJECT_FILES || depth > MAX_WALK_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath, depth + 1);
			} else if (entry.isFile()) {
				const rel = relative(cwd, fullPath).replaceAll("\\", "/");
				if (!gitignore.ignores(rel)) {
					files.push(rel);
				}
			}
		}
	};
	walk(cwd, 0);
	return files;
}

function getProjectFiles(cwd: string): string[] {
	const rootMtime = statSync(cwd, { throwIfNoEntry: false })?.mtimeMs ?? 0;
	if (fileListCache && fileListCache.dir === cwd && fileListCache.mtimeMs === rootMtime) {
		return fileListCache.files;
	}
	const files = collectProjectFiles(cwd);
	fileListCache = { dir: cwd, mtimeMs: rootMtime, files };
	return files;
}

/** Compact extension label: package name for npm/git sources, otherwise the
 * directory name for index files (mirrors the TUI's compact labels). */
function extensionDisplayName(path: string, sourceInfo: { source?: string; scope?: string } | undefined): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:") || source.startsWith("git:")) {
		return source;
	}
	const base = basename(path);
	if (base === "index.ts" || base === "index.js") {
		const segments = path.split(/[\\/]/).filter(Boolean);
		const parentSegment = segments.length >= 2 ? segments[segments.length - 2] : undefined;
		if (parentSegment) {
			return `${parentSegment}/${base}`;
		}
	}
	return base;
}

function buildContextInfo(session: AgentSession): RpcContextInfo {
	const commands: RpcSlashCommand[] = [];
	for (const command of session.extensionRunner.getRegisteredCommands()) {
		commands.push({
			name: command.invocationName,
			description: command.description,
			source: "extension",
			sourceInfo: command.sourceInfo,
		});
	}
	for (const template of session.promptTemplates) {
		commands.push({
			name: template.name,
			description: template.description,
			source: "prompt",
			sourceInfo: template.sourceInfo,
		});
	}
	for (const skill of session.resourceLoader.getSkills().skills) {
		commands.push({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			sourceInfo: skill.sourceInfo,
		});
	}

	const contextFiles: RpcContextInfo["contextFiles"] = [];
	const systemPromptSource = session.resourceLoader.getSystemPromptSource();
	if (systemPromptSource) contextFiles.push({ path: systemPromptSource.path, source: "project" });
	for (const source of session.resourceLoader.getAppendSystemPromptSources()) {
		contextFiles.push({ path: source.path, source: "project" });
	}
	for (const agentsFile of session.resourceLoader.getAgentsFiles().agentsFiles) {
		contextFiles.push({ path: agentsFile.path, source: "project" });
	}

	const extensions: RpcContextInfo["extensions"] = [];
	const extensionResult = session.resourceLoader.getExtensions();
	for (const extension of extensionResult.extensions) {
		if (extension.hidden) continue;
		extensions.push({
			name: extensionDisplayName(extension.path, extension.sourceInfo),
			sourceInfo: extension.sourceInfo,
		});
	}

	const cwd = session.sessionManager.getCwd();
	const model = session.model;

	return {
		version: VERSION,
		cwd,
		gitBranch: getGitBranch(cwd) ?? undefined,
		contextFiles,
		skills: session.resourceLoader.getSkills().skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			sourceInfo: skill.sourceInfo,
		})),
		promptTemplates: session.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			sourceInfo: template.sourceInfo,
		})),
		extensions,
		commands,
		themeNames: getAvailableThemesWithPaths().map(({ name }) => name),
		experimental: areExperimentalFeaturesEnabled(),
		isUsingSubscription: model
			? model.provider === "kimi-coding" || session.modelRuntime.isUsingSubscription(model.provider)
			: false,
		agentDir: getAgentDir(),
		isTrusted: session.settingsManager.isProjectTrusted(),
	};
}

function buildTrustState(session: AgentSession): RpcTrustState {
	const cwd = session.sessionManager.getCwd();
	const store = new ProjectTrustStore(getAgentDir());
	const saved = store.getEntry(cwd);
	const options = getProjectTrustOptions(cwd);
	return {
		trusted: session.settingsManager.isProjectTrusted(),
		options: options.map((option) => ({
			label: option.label,
			trusted: option.trusted,
			savedPath: option.savedPath,
		})),
		savedDecision: saved ? { path: saved.path, decision: saved.decision } : undefined,
		trustPath: cwd,
	};
}

interface SettingsApplierContext {
	session: AgentSession;
	settingsManager: SettingsManager;
	scope: "global" | "project";
}

type SettingsApplier = (context: SettingsApplierContext, value: unknown) => void;

function expectBoolean(value: unknown): boolean {
	return value === true;
}

function expectNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

function expectString(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}

function expectStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map(expectString) : [];
}

/**
 * Editable settings surface: every SettingsManager setter the TUI /settings
 * dialog exposes. Keys with project-scope variants pick the variant by scope.
 */
const SETTINGS_APPLIERS: Record<string, SettingsApplier> = {
	defaultProvider: (c, value) => c.settingsManager.setDefaultProvider(expectString(value)),
	defaultModel: (c, value) => c.settingsManager.setDefaultModel(expectString(value)),
	defaultThinkingLevel: (c, value) => c.settingsManager.setDefaultThinkingLevel(expectString(value) as never),
	modelThinkingLevels: (c, value) => {
		if (!value || typeof value !== "object") return;
		for (const [modelKey, level] of Object.entries(value as Record<string, unknown>)) {
			const separator = modelKey.indexOf("/");
			if (separator <= 0 || level === null) continue;
			c.settingsManager.setModelThinkingLevel(
				modelKey.slice(0, separator),
				modelKey.slice(separator + 1),
				expectString(level) as never,
			);
		}
	},
	theme: (c, value) => c.settingsManager.setTheme(expectString(value)),
	steeringMode: (c, value) => c.session.setSteeringMode(value === "all" ? "all" : "one-at-a-time"),
	followUpMode: (c, value) => c.session.setFollowUpMode(value === "all" ? "all" : "one-at-a-time"),
	transport: (c, value) => c.settingsManager.setTransport(expectString(value) as never),
	httpIdleTimeoutMs: (c, value) => c.settingsManager.setHttpIdleTimeoutMs(expectNumber(value)),
	compactionEnabled: (c, value) => c.settingsManager.setCompactionEnabled(expectBoolean(value)),
	retryEnabled: (c, value) => c.settingsManager.setRetryEnabled(expectBoolean(value)),
	hideThinkingBlock: (c, value) => c.settingsManager.setHideThinkingBlock(expectBoolean(value)),
	showCacheMissNotices: (c, value) => c.settingsManager.setShowCacheMissNotices(expectBoolean(value)),
	quietStartup: (c, value) => c.settingsManager.setQuietStartup(expectBoolean(value)),
	collapseChangelog: (c, value) => c.settingsManager.setCollapseChangelog(expectBoolean(value)),
	enableInstallTelemetry: (c, value) => c.settingsManager.setEnableInstallTelemetry(expectBoolean(value)),
	enableAnalytics: (c, value) => c.settingsManager.setEnableAnalytics(expectBoolean(value)),
	defaultProjectTrust: (c, value) => c.settingsManager.setDefaultProjectTrust(expectString(value) as never),
	doubleEscapeAction: (c, value) => c.settingsManager.setDoubleEscapeAction(expectString(value) as never),
	treeFilterMode: (c, value) => c.settingsManager.setTreeFilterMode(expectString(value) as never),
	editorPaddingX: (c, value) => c.settingsManager.setEditorPaddingX(expectNumber(value)),
	outputPad: (c, value) => c.settingsManager.setOutputPad(expectNumber(value) as 0 | 1),
	autocompleteMaxVisible: (c, value) => c.settingsManager.setAutocompleteMaxVisible(expectNumber(value)),
	showImages: (c, value) => c.settingsManager.setShowImages(expectBoolean(value)),
	imageWidthCells: (c, value) => c.settingsManager.setImageWidthCells(expectNumber(value)),
	imageAutoResize: (c, value) => c.settingsManager.setImageAutoResize(expectBoolean(value)),
	blockImages: (c, value) => c.settingsManager.setBlockImages(expectBoolean(value)),
	shellPath: (c, value) => c.settingsManager.setShellPath(value ? expectString(value) : undefined),
	shellCommandPrefix: (c, value) => c.settingsManager.setShellCommandPrefix(value ? expectString(value) : undefined),
	npmCommand: (c, value) =>
		c.settingsManager.setNpmCommand(Array.isArray(value) ? expectStringArray(value) : undefined),
	enabledModels: (c, value) =>
		c.settingsManager.setEnabledModels(Array.isArray(value) ? expectStringArray(value) : undefined),
	mermaidRenderingMode: (c, value) => c.settingsManager.setMermaidRenderingMode(expectString(value) as never),
	warnings: (c, value) => c.settingsManager.setWarnings((value ?? {}) as never),
	clearOnShrink: (c, value) => c.settingsManager.setClearOnShrink(expectBoolean(value)),
	showTerminalProgress: (c, value) => c.settingsManager.setShowTerminalProgress(expectBoolean(value)),
	showHardwareCursor: (c, value) => c.settingsManager.setShowHardwareCursor(expectBoolean(value)),
	packages: (c, value) => {
		if (c.scope === "project") {
			c.settingsManager.setProjectPackages(Array.isArray(value) ? (value as never) : []);
		} else {
			c.settingsManager.setPackages(Array.isArray(value) ? (value as never) : []);
		}
	},
	extensionPaths: (c, value) => {
		if (c.scope === "project") {
			c.settingsManager.setProjectExtensionPaths(expectStringArray(value));
		} else {
			c.settingsManager.setExtensionPaths(expectStringArray(value));
		}
	},
	skillPaths: (c, value) => {
		if (c.scope === "project") {
			c.settingsManager.setProjectSkillPaths(expectStringArray(value));
		} else {
			c.settingsManager.setSkillPaths(expectStringArray(value));
		}
	},
	promptTemplatePaths: (c, value) => {
		if (c.scope === "project") {
			c.settingsManager.setProjectPromptTemplatePaths(expectStringArray(value));
		} else {
			c.settingsManager.setPromptTemplatePaths(expectStringArray(value));
		}
	},
	themePaths: (c, value) => {
		if (c.scope === "project") {
			c.settingsManager.setProjectThemePaths(expectStringArray(value));
		} else {
			c.settingsManager.setThemePaths(expectStringArray(value));
		}
	},
	enableSkillCommands: (c, value) => c.settingsManager.setEnableSkillCommands(expectBoolean(value)),
};

function askAuthPrompt(core: RpcCore, prompt: AuthPrompt): Promise<string> {
	return core
		.requestDialog<string | undefined>(
			prompt.type === "select"
				? {
						method: "auth_prompt",
						promptType: "select",
						message: prompt.message,
						options: prompt.options.map((option) => ({
							id: option.id,
							label: option.label,
							description: option.description,
						})),
					}
				: {
						method: "auth_prompt",
						promptType: prompt.type,
						message: prompt.message,
						placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
					},
			(response) => {
				if ("cancelled" in response && response.cancelled) return undefined;
				if ("value" in response && typeof response.value === "string") return response.value;
				return undefined;
			},
			{ signal: prompt.signal },
		)
		.then((value) => {
			if (value === undefined) {
				throw new Error("Login cancelled");
			}
			return value;
		});
}

function notifyAuthEvent(core: RpcCore, event: AuthEvent): void {
	if (event.type === "auth_url") {
		core.sendExtensionUIRequest({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "auth_event",
			event: "auth_url",
			url: event.url,
			instructions: event.instructions,
		});
	} else if (event.type === "device_code") {
		core.sendExtensionUIRequest({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "auth_event",
			event: "device_code",
			userCode: event.userCode,
			verificationUri: event.verificationUri,
			intervalSeconds: event.intervalSeconds,
			expiresInSeconds: event.expiresInSeconds,
		});
	} else if (event.type === "info") {
		core.sendExtensionUIRequest({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "auth_event",
			event: "info",
			message: event.message,
			links: event.links ? event.links.map((link) => ({ url: link.url, label: link.label })) : undefined,
		});
	} else {
		core.sendExtensionUIRequest({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "auth_event",
			event: "progress",
			message: event.message,
		});
	}
}

/** Create the handler for web parity commands. */
export function createWebCommandHandler(): WebCommandHandler {
	return async (command: RpcCommand, core: RpcCore): Promise<RpcResponse | undefined> => {
		const id = command.id;
		const session = core.getSession();
		const runtime = core.getRuntime();
		const notify = (message: string, level: "info" | "warning" | "error") => {
			core.sendExtensionUIRequest({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: level,
			} as RpcExtensionUIRequest);
		};

		switch (command.type) {
			// =================================================================
			// Interactive widget responses (setWidgetData overlays)
			// =================================================================
			case "widget_response": {
				const delivered = core.dispatchWidgetResponse(command.key, command.payload);
				return {
					id,
					type: "response",
					command: "widget_response",
					success: true,
					data: { delivered },
				};
			}

			// =================================================================
			// Session management
			// =================================================================

			case "list_sessions": {
				const cwd = session.sessionManager.getCwd();
				const infos = await (command.scope === "all"
					? SessionManager.listAll()
					: SessionManager.list(cwd, session.sessionManager.getSessionDir()));
				return {
					id,
					type: "response",
					command: "list_sessions",
					success: true,
					data: {
						sessions: infos.map((info) => ({
							file: info.path,
							id: info.id,
							name: info.name,
							cwd: info.cwd,
							parentSession: info.parentSessionPath,
							created: info.created.toISOString(),
							modified: info.modified.toISOString(),
							messageCount: info.messageCount,
							firstMessage: info.firstMessage,
						})),
					},
				};
			}

			case "delete_session": {
				const sessionPath = command.sessionPath;
				if (!existsSync(sessionPath)) {
					return rpcError(id, "delete_session", `Session file not found: ${sessionPath}`);
				}
				const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
				const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
				if (trashResult.status === 0) {
					return { id, type: "response", command: "delete_session", success: true, data: { method: "trash" } };
				}
				try {
					unlinkSync(sessionPath);
				} catch (error: unknown) {
					return rpcError(
						id,
						"delete_session",
						`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return { id, type: "response", command: "delete_session", success: true, data: { method: "unlink" } };
			}

			case "rename_session": {
				const name = command.name.trim();
				if (!name) {
					return rpcError(id, "rename_session", "Session name cannot be empty");
				}
				try {
					SessionManager.open(command.sessionPath).appendSessionInfo(name);
				} catch (error: unknown) {
					return rpcError(
						id,
						"rename_session",
						`Failed to rename session: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return { id, type: "response", command: "rename_session", success: true };
			}

			case "navigate_tree": {
				const result = await session.navigateTree(command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				});
				return {
					id,
					type: "response",
					command: "navigate_tree",
					success: true,
					data: { editorText: result.editorText, cancelled: result.cancelled },
				};
			}

			case "import_session": {
				try {
					const result = await runtime.importFromJsonl(command.path, command.cwd);
					return { id, type: "response", command: "import_session", success: true, data: result };
				} catch (error: unknown) {
					if (error instanceof MissingSessionCwdError) {
						return {
							id,
							type: "response",
							command: "import_session",
							success: false,
							error: error.message,
							missingCwd: true,
						} as RpcResponse;
					}
					if (error instanceof SessionImportFileNotFoundError) {
						return rpcError(id, "import_session", error.message);
					}
					throw error;
				}
			}

			// =================================================================
			// Context and info
			// =================================================================

			case "get_tools": {
				const definitions = session.getAllTools();
				const active = new Set(session.getActiveToolNames());
				return {
					id,
					type: "response",
					command: "get_tools",
					success: true,
					data: {
						tools: definitions.map((tool) => ({
							name: tool.name,
							active: active.has(tool.name),
							source: tool.sourceInfo?.source,
						})),
					},
				};
			}

			case "get_context_info": {
				return {
					id,
					type: "response",
					command: "get_context_info",
					success: true,
					data: buildContextInfo(session),
				};
			}

			case "get_changelog": {
				const entries = parseChangelog(getChangelogPath());
				const markdown = entries
					.map((entry) => `## ${entry.major}.${entry.minor}.${entry.patch}\n\n${entry.content.trim()}`)
					.join("\n\n");
				return { id, type: "response", command: "get_changelog", success: true, data: { markdown } };
			}

			case "get_keybindings": {
				const manager = KeybindingsManager.create(getAgentDir());
				const effective = manager.getEffectiveConfig();
				const bindings: Array<{ id: string; keys: string[]; description?: string }> = [];
				for (const [bindingId, keys] of Object.entries(effective) as Array<[string, string | string[]]>) {
					bindings.push({
						id: bindingId,
						keys: (Array.isArray(keys) ? keys : [keys]).filter((key) => key !== undefined),
						description: manager.getDefinition(bindingId as Keybinding).description,
					});
				}
				return { id, type: "response", command: "get_keybindings", success: true, data: { bindings } };
			}

			case "search_files": {
				const cwd = session.sessionManager.getCwd();
				const allFiles = getProjectFiles(cwd);
				const query = command.query?.toLowerCase();
				const limit = command.limit ?? 200;
				const files = query
					? allFiles.filter((file) => file.toLowerCase().includes(query)).slice(0, limit)
					: allFiles.slice(0, limit);
				return { id, type: "response", command: "search_files", success: true, data: { files } };
			}

			case "stat_paths": {
				const cwd = session.sessionManager.getCwd();
				const inputs = (Array.isArray(command.paths) ? command.paths : [])
					.filter((candidate) => typeof candidate === "string" && candidate.length > 0)
					.slice(0, 64);
				const results = inputs.map((input) => {
					const absolute = resolveReadPath(input, cwd);
					try {
						const stats = statSync(absolute);
						return {
							input,
							path: absolute,
							exists: true,
							kind: stats.isDirectory() ? ("dir" as const) : ("file" as const),
							size: stats.isFile() ? stats.size : undefined,
						};
					} catch {
						return { input, path: absolute, exists: false };
					}
				});
				return { id, type: "response", command: "stat_paths", success: true, data: { results } };
			}

			case "read_file": {
				const cwd = session.sessionManager.getCwd();
				const absolute = resolveReadPath(command.path, cwd);
				let stats: ReturnType<typeof statSync>;
				try {
					stats = statSync(absolute);
				} catch {
					return rpcError(id, "read_file", `File not found: ${command.path}`);
				}
				if (stats.isDirectory()) {
					return rpcError(id, "read_file", `Path is a directory: ${command.path}`);
				}
				let buffer: Buffer;
				try {
					buffer = await readFile(absolute);
				} catch (readError: unknown) {
					return rpcError(id, "read_file", readError instanceof Error ? readError.message : String(readError));
				}
				const imageMime = await detectSupportedImageMimeTypeFromFile(absolute).catch(() => null);
				if (imageMime) {
					if (stats.size > MAX_PREVIEW_IMAGE_BYTES) {
						return {
							id,
							type: "response",
							command: "read_file",
							success: true,
							data: { kind: "unsupported", size: stats.size, mimeType: imageMime, reason: "too-large" },
						};
					}
					return {
						id,
						type: "response",
						command: "read_file",
						success: true,
						data: {
							kind: "image",
							data: buffer.toString("base64"),
							mimeType: imageMime,
							size: stats.size,
						},
					};
				}
				if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
					return {
						id,
						type: "response",
						command: "read_file",
						success: true,
						data: { kind: "unsupported", size: stats.size },
					};
				}
				const allText = buffer.toString("utf-8");
				const splitLines = allText.split("\n");
				const allLines = allText === "" ? [] : allText.endsWith("\n") ? splitLines.slice(0, -1) : splitLines;
				const startLine = command.offset !== undefined ? Math.max(0, command.offset - 1) : 0;
				if (command.offset !== undefined && startLine >= allLines.length) {
					return rpcError(
						id,
						"read_file",
						`Offset ${command.offset} is beyond end of file (${allLines.length} lines total)`,
					);
				}
				const endLine =
					command.limit !== undefined ? Math.min(startLine + command.limit, allLines.length) : allLines.length;
				const selected = allLines.slice(startLine, endLine).join("\n");
				const truncation = truncateHead(selected);
				if (truncation.firstLineExceedsLimit) {
					return rpcError(id, "read_file", `Line ${startLine + 1} exceeds the preview size limit`);
				}
				// Count emitted lines in allLines space: truncateHead recounts the
				// re-joined string and drops trailing empty lines, which would
				// otherwise make paging loop forever on files ending with blanks.
				const emittedLines = truncation.truncated ? truncation.outputLines : endLine - startLine;
				const shownLines = startLine + emittedLines;
				const truncated = truncation.truncated || shownLines < allLines.length;
				return {
					id,
					type: "response",
					command: "read_file",
					success: true,
					data: {
						kind: "text",
						text: truncation.content,
						totalLines: allLines.length,
						shownLines,
						truncated,
						truncatedBy: truncation.truncatedBy,
						size: stats.size,
					},
				};
			}

			case "get_session_dir": {
				return {
					id,
					type: "response",
					command: "get_session_dir",
					success: true,
					data: { dir: session.sessionManager.getSessionDir() },
				};
			}

			case "reload": {
				await session.reload();
				return { id, type: "response", command: "reload", success: true };
			}

			case "export_session": {
				const outputPath = command.path;
				if (outputPath?.endsWith(".jsonl")) {
					const filePath = session.exportToJsonl(outputPath);
					return { id, type: "response", command: "export_session", success: true, data: { path: filePath } };
				}
				const htmlPath = await session.exportToHtml(outputPath);
				return { id, type: "response", command: "export_session", success: true, data: { path: htmlPath } };
			}

			case "share_session": {
				const result = await shareSessionHeadless(session, notify);
				if (result.error) {
					return rpcError(id, "share_session", result.error);
				}
				return {
					id,
					type: "response",
					command: "share_session",
					success: true,
					data: { url: result.url, gistUrl: result.gistUrl },
				};
			}

			// =================================================================
			// Settings and themes
			// =================================================================

			case "get_settings": {
				const settingsManager = session.settingsManager;
				const snapshot = {
					global: settingsManager.getGlobalSettings() as Record<string, unknown>,
					project: settingsManager.getProjectSettings() as Record<string, unknown>,
					effective: settingsManager.getEffectiveSettings() as Record<string, unknown>,
					paths: settingsManager.getSettingsFilePaths(),
					errors: settingsManager
						.getSettingsLoadErrors()
						.map((error) => `${error.scope}${error.path ? ` (${error.path})` : ""}: ${error.message}`),
				};
				return { id, type: "response", command: "get_settings", success: true, data: snapshot };
			}

			case "set_settings": {
				const context: SettingsApplierContext = {
					session,
					settingsManager: session.settingsManager,
					scope: command.scope,
				};
				const errors: string[] = [];
				for (const [key, value] of Object.entries(command.values)) {
					const applier = SETTINGS_APPLIERS[key];
					if (!applier) {
						errors.push(`Unknown setting: ${key}`);
						continue;
					}
					try {
						applier(context, value);
					} catch (error: unknown) {
						errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (errors.length > 0) {
					return rpcError(id, "set_settings", errors.join("; "));
				}
				return { id, type: "response", command: "set_settings", success: true };
			}

			case "get_themes": {
				const themes = getAvailableThemesWithPaths().map(({ name }) => {
					let vars: Record<string, string> = {};
					try {
						vars = getResolvedThemeColors(name);
					} catch {
						// Keep an empty var map; the UI falls back to its defaults
					}
					return { name, vars };
				});
				const current = session.settingsManager.getTheme() ?? "dark";
				return { id, type: "response", command: "get_themes", success: true, data: { themes, current } };
			}

			case "set_theme": {
				const name = command.name;
				const theme = getThemeByName(name);
				if (!theme) {
					return rpcError(id, "set_theme", `Theme not found: ${name}`);
				}
				session.settingsManager.setTheme(name);
				let vars: Record<string, string> = {};
				try {
					vars = getResolvedThemeColors(name);
				} catch {
					// Keep empty vars; the UI keeps its current colors
				}
				core.emit({ type: "theme_changed", name, vars });
				return { id, type: "response", command: "set_theme", success: true };
			}

			// =================================================================
			// Auth and trust
			// =================================================================

			case "auth_status": {
				const providers = core.getRuntime().services.modelRuntime;
				const providerIds = Array.from(new Set(providers.getProviders().map((provider) => provider.id)));
				const statuses = await Promise.all(
					providerIds.map(async (providerId) => {
						const check = await providers.checkAuth(providerId).catch(() => undefined);
						return {
							id: providerId,
							authenticated: check !== undefined,
							source: check?.source,
							kind: check?.type,
							subscription: session.modelRuntime.isUsingSubscription(providerId) || undefined,
						};
					}),
				);
				return { id, type: "response", command: "auth_status", success: true, data: { providers: statuses } };
			}

			case "auth_login": {
				const providerId = command.provider;
				try {
					await session.modelRuntime.login(providerId, command.method, {
						prompt: (prompt) => askAuthPrompt(core, prompt),
						notify: (event) => notifyAuthEvent(core, event),
					});
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					return rpcError(id, "auth_login", message);
				}
				core.emit({ type: "auth_changed", provider: providerId });
				return { id, type: "response", command: "auth_login", success: true };
			}

			case "auth_logout": {
				try {
					await session.modelRuntime.logout(command.provider);
				} catch (error: unknown) {
					return rpcError(
						id,
						"auth_logout",
						`Failed to log out of ${command.provider}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				core.emit({ type: "auth_changed", provider: command.provider });
				return { id, type: "response", command: "auth_logout", success: true };
			}

			case "get_trust": {
				return { id, type: "response", command: "get_trust", success: true, data: buildTrustState(session) };
			}

			case "set_trust": {
				const cwd = session.sessionManager.getCwd();
				const options = getProjectTrustOptions(cwd);
				const option = command.optionIndex !== undefined ? options[command.optionIndex] : undefined;
				if (!option) {
					return rpcError(id, "set_trust", "Invalid trust option");
				}
				new ProjectTrustStore(getAgentDir()).setMany(option.updates);
				return { id, type: "response", command: "set_trust", success: true };
			}

			default:
				return undefined;
		}
	};
}
