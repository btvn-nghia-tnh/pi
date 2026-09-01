import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
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
import { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createWebCommandHandler } from "../../src/modes/web/web-commands.ts";

interface CoreFixture {
	core: RpcCore;
	sent: object[];
	tempDir: string;
}

async function createCoreFixture(withProjectFiles = false): Promise<CoreFixture> {
	const tempDir = join(tmpdir(), `pi-web-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	if (withProjectFiles) {
		writeFileSync(join(tempDir, "AGENTS.md"), "# Test project\n");
		writeFileSync(join(tempDir, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(tempDir, "ignored.txt"), "secret");
		writeFileSync(join(tempDir, "visible.txt"), "hello");
		mkdirSync(join(tempDir, ".pi"), { recursive: true });
		writeFileSync(join(tempDir, ".pi", "settings.json"), "{}\n");
	}

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
						models: faux.models.map((registeredModel) => ({
							id: registeredModel.id,
							name: registeredModel.name,
							api: registeredModel.api,
							reasoning: registeredModel.reasoning,
							input: registeredModel.input,
							cost: registeredModel.cost,
							contextWindow: registeredModel.contextWindow,
							maxTokens: registeredModel.maxTokens,
						})),
					});
				},
			],
			noSkills: !withProjectFiles,
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

	const sent: object[] = [];
	const core = new RpcCore({
		runtime,
		send: (message) => sent.push(message),
		extraCommandHandler: createWebCommandHandler(),
	});
	await core.init();
	return { core, sent, tempDir };
}

function responseData(response: RpcResponse | undefined): Record<string, unknown> | undefined {
	if (response?.success && "data" in response && response.data) {
		return response.data as Record<string, unknown>;
	}
	return undefined;
}

describe("web commands", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function fixture(withProjectFiles = false): Promise<CoreFixture> {
		const fixture = await createCoreFixture(withProjectFiles);
		cleanups.push(async () => {
			await fixture.core.dispose();
			rmSync(fixture.tempDir, { recursive: true, force: true });
		});
		return fixture;
	}

	describe("session management", () => {
		it("lists sessions for the current cwd", async () => {
			const { core, tempDir } = await fixture();
			await core.handleCommand({ type: "prompt", message: "one" });
			await core.getSession().waitForIdle();

			const response = await core.handleCommand({ type: "list_sessions" });
			const data = responseData(response);
			const sessions = (data?.sessions as Array<{ file: string; id: string; messageCount: number }>) ?? [];
			expect(sessions.length).toBeGreaterThanOrEqual(1);
			expect(sessions[0]!.file).toContain(tempDir.split("/").pop()!);
			expect(typeof sessions[0]!.id).toBe("string");
		});

		it("renames a session via appendSessionInfo", async () => {
			const { core } = await fixture();
			await core.handleCommand({ type: "prompt", message: "one" });
			await core.getSession().waitForIdle();
			const sessionFile = core.getSession().sessionFile!;

			const response = await core.handleCommand({
				type: "rename_session",
				sessionPath: sessionFile,
				name: "my renamed session",
			});
			expect(response?.success).toBe(true);

			const listing = await core.handleCommand({ type: "list_sessions" });
			const sessions = (responseData(listing)?.sessions as Array<{ file: string; name?: string }>) ?? [];
			const renamed = sessions.find((session) => session.file === sessionFile);
			expect(renamed?.name).toBe("my renamed session");
		});

		it("rejects empty rename", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "rename_session", sessionPath: "/nope", name: "  " });
			expect(response?.success).toBe(false);
		});

		it("deletes a session file (unlink fallback when trash is unavailable)", async () => {
			const { core, tempDir } = await fixture();
			const other = SessionManager.create(tempDir, tempDir);
			other.appendMessage({ role: "user", content: "bye", timestamp: Date.now() });
			other.appendMessage(fauxAssistantMessage("done"));
			const response = await core.handleCommand({ type: "delete_session", sessionPath: other.getSessionFile()! });
			const data = responseData(response);
			expect(data?.method).toBe("unlink");
			expect(existsSync(other.getSessionFile()!)).toBe(false);
		});

		it("errors when deleting a missing session", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({
				type: "delete_session",
				sessionPath: join(core.getSession().sessionManager.getSessionDir(), "missing.jsonl"),
			});
			expect(response?.success).toBe(false);
		});

		it("navigates the session tree in place", async () => {
			const { core } = await fixture();
			await core.handleCommand({ type: "prompt", message: "first prompt" });
			await core.getSession().waitForIdle();
			await core.handleCommand({ type: "prompt", message: "second prompt" });
			await core.getSession().waitForIdle();
			for (let i = 0; i < 100 && core.getSession().isStreaming; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			const entries = await core.handleCommand({ type: "get_entries" });
			const entryList = (responseData(entries)?.entries as Array<{ id: string; type: string }>) ?? [];
			const firstUserEntry = entryList.find(
				(entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user",
			);
			expect(firstUserEntry).toBeDefined();

			const response = await core.handleCommand({ type: "navigate_tree", targetId: firstUserEntry!.id });
			const data = responseData(response);
			expect(data?.cancelled).toBe(false);
			expect(data?.editorText).toBe("first prompt");
		});

		it("imports a jsonl session", async () => {
			const { core, tempDir } = await fixture();
			const source = SessionManager.create(tempDir, tempDir);
			source.appendMessage({ role: "user", content: "hello from import", timestamp: Date.now() });
			source.appendMessage(fauxAssistantMessage("imported"));

			const response = await core.handleCommand({ type: "import_session", path: source.getSessionFile()! });
			const data = responseData(response);
			expect(data?.cancelled).toBe(false);
			const texts = core
				.getSession()
				.messages.filter((message) => message.role === "user")
				.map((message) => (typeof message.content === "string" ? message.content : ""));
			expect(texts).toContain("hello from import");
		});
	});

	describe("context and info", () => {
		it("returns context info with files and version", async () => {
			const { core, tempDir } = await fixture(true);
			const response = await core.handleCommand({ type: "get_context_info" });
			const data = responseData(response);
			expect(typeof data?.version).toBe("string");
			expect(data?.cwd).toBe(tempDir);
			const contextFiles = data?.contextFiles as Array<{ path: string }>;
			expect(contextFiles.some((file) => file.path.endsWith("AGENTS.md"))).toBe(true);
			const commands = data?.commands as Array<{ name: string }>;
			expect(Array.isArray(commands)).toBe(true);
			expect(data?.themeNames).toContain("dark");
		});

		it("lists project files for search_files, honoring gitignore", async () => {
			const { core } = await fixture(true);
			const response = await core.handleCommand({ type: "search_files" });
			const files = (responseData(response)?.files as string[]) ?? [];
			expect(files).toContain("visible.txt");
			expect(files).toContain("AGENTS.md");
			expect(files).not.toContain("ignored.txt");
		});

		it("filters search_files by query", async () => {
			const { core } = await fixture(true);
			const response = await core.handleCommand({ type: "search_files", query: "vis" });
			const files = (responseData(response)?.files as string[]) ?? [];
			expect(files).toEqual(["visible.txt"]);
		});

		it("returns the session dir", async () => {
			const { core, tempDir } = await fixture();
			const response = await core.handleCommand({ type: "get_session_dir" });
			expect(responseData(response)?.dir).toBe(tempDir);
		});

		it("returns changelog markdown", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "get_changelog" });
			expect(typeof responseData(response)?.markdown).toBe("string");
		});

		it("returns keybindings including app.interrupt", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "get_keybindings" });
			const bindings = (responseData(response)?.bindings as Array<{ id: string; keys: string[] }>) ?? [];
			const interrupt = bindings.find((binding) => binding.id === "app.interrupt");
			expect(interrupt?.keys).toContain("escape");
		});

		it("exports the session to jsonl", async () => {
			const { core, tempDir } = await fixture();
			const outPath = join(tempDir, "export.jsonl");
			const response = await core.handleCommand({ type: "export_session", path: outPath });
			expect(responseData(response)?.path).toBe(outPath);
		});
	});

	describe("settings and themes", () => {
		it("returns settings snapshots", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "get_settings" });
			const data = responseData(response);
			expect(data).toHaveProperty("global");
			expect(data).toHaveProperty("project");
			expect(data).toHaveProperty("effective");
			expect(data).toHaveProperty("paths");
			expect(Array.isArray(data?.errors)).toBe(true);
		});

		it("persists settings changes", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({
				type: "set_settings",
				scope: "global",
				values: { quietStartup: true },
			});
			expect(response?.success).toBe(true);
			const settings = await core.handleCommand({ type: "get_settings" });
			const global = responseData(settings)?.global as { quietStartup?: boolean };
			expect(global.quietStartup).toBe(true);
		});

		it("rejects unknown settings keys", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({
				type: "set_settings",
				scope: "global",
				values: { notARealSetting: 1 },
			});
			expect(response?.success).toBe(false);
			if (response && !response.success) {
				expect(response.error).toContain("Unknown setting");
			}
		});

		it("applies steering mode to the session", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({
				type: "set_settings",
				scope: "global",
				values: { steeringMode: "all" },
			});
			expect(response?.success).toBe(true);
			expect(core.getSession().steeringMode).toBe("all");
		});

		it("lists themes with vars", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "get_themes" });
			const data = responseData(response);
			const themes = (data?.themes as Array<{ name: string; vars: Record<string, string> }>) ?? [];
			const dark = themes.find((theme) => theme.name === "dark");
			expect(dark?.vars).toHaveProperty("text");
		});

		it("switches themes and emits theme_changed", async () => {
			const { core, sent } = await fixture();
			const response = await core.handleCommand({ type: "set_theme", name: "light" });
			expect(response?.success).toBe(true);
			const themeChange = sent.find((message) => (message as { type?: string }).type === "theme_changed") as
				| { name?: string; vars?: Record<string, string> }
				| undefined;
			expect(themeChange?.name).toBe("light");
			expect(themeChange?.vars).toHaveProperty("text");
		});

		it("errors on unknown themes", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "set_theme", name: "nope" });
			expect(response?.success).toBe(false);
		});
	});

	describe("auth and trust", () => {
		it("reports provider auth status", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "auth_status" });
			const providers = (responseData(response)?.providers as Array<{ id: string; authenticated: boolean }>) ?? [];
			expect(providers.length).toBeGreaterThan(0);
			const fauxProvider = providers.find((provider) => provider.id === "faux");
			expect(fauxProvider?.authenticated).toBe(true);
		});

		it("reports trust state for untrusted cwd", async () => {
			const { core } = await fixture(true);
			const response = await core.handleCommand({ type: "get_trust" });
			const data = responseData(response);
			expect(data?.trusted).toBe(false);
			expect(Array.isArray(data?.options)).toBe(true);
		});

		it("saves trust decisions and reflects them", async () => {
			const { core } = await fixture(true);
			const initial = await core.handleCommand({ type: "get_trust" });
			const options = (responseData(initial)?.options as unknown[]) ?? [];
			expect(options.length).toBeGreaterThan(0);

			const response = await core.handleCommand({ type: "set_trust", trusted: true, optionIndex: 0 });
			expect(response?.success).toBe(true);

			const after = await core.handleCommand({ type: "get_trust" });
			const saved = responseData(after)?.savedDecision as { decision: boolean } | undefined;
			expect(saved?.decision).toBe(true);
		});

		it("rejects invalid trust options", async () => {
			const { core } = await fixture();
			const response = await core.handleCommand({ type: "set_trust", trusted: true, optionIndex: 99 });
			expect(response?.success).toBe(false);
		});
	});

	describe("stat_paths", () => {
		it("stats existing, relative, missing paths and directories", async () => {
			const { core, tempDir } = await fixture(true);
			const response = await core.handleCommand({
				type: "stat_paths",
				paths: [join(tempDir, "visible.txt"), "visible.txt", join(tempDir, "missing.txt"), tempDir],
			});
			const results =
				(responseData(response)?.results as Array<{
					input: string;
					path: string;
					exists: boolean;
					kind?: string;
					size?: number;
				}>) ?? [];
			expect(results.length).toBe(4);
			expect(results[0]!.input).toBe(join(tempDir, "visible.txt"));
			expect(results[0]!.exists).toBe(true);
			expect(results[0]!.kind).toBe("file");
			expect(results[0]!.size).toBe(5);
			expect(results[1]!.path).toBe(results[0]!.path);
			expect(results[1]!.exists).toBe(true);
			expect(results[2]!.exists).toBe(false);
			expect(results[3]!.kind).toBe("dir");
		});

		it("caps the batch at 64 paths", async () => {
			const { core } = await fixture();
			const paths = Array.from({ length: 70 }, (_, index) => `/nope-${index}`);
			const response = await core.handleCommand({ type: "stat_paths", paths });
			const results = (responseData(response)?.results as unknown[]) ?? [];
			expect(results.length).toBe(64);
		});
	});

	describe("read_file", () => {
		const TINY_PNG = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
			"base64",
		);

		it("reads a small text file completely", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "small.txt"), "hello\nworld");
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "small.txt") });
			const data = responseData(response) as {
				kind: string;
				text: string;
				totalLines: number;
				shownLines: number;
				truncated: boolean;
			};
			expect(data.kind).toBe("text");
			expect(data.text).toBe("hello\nworld");
			expect(data.totalLines).toBe(2);
			expect(data.shownLines).toBe(2);
			expect(data.truncated).toBe(false);
		});

		it("reads an empty file", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "empty.txt"), "");
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "empty.txt") });
			const data = responseData(response) as { kind: string; text: string; totalLines: number };
			expect(data.kind).toBe("text");
			expect(data.text).toBe("");
			expect(data.totalLines).toBe(0);
		});

		it("truncates long text files and pages with offset", async () => {
			const { core, tempDir } = await fixture();
			const lines = Array.from({ length: 2500 }, (_, index) => `line-${index}`);
			writeFileSync(join(tempDir, "big.txt"), `${lines.join("\n")}\n`);
			const first = await core.handleCommand({ type: "read_file", path: join(tempDir, "big.txt") });
			const firstData = responseData(first) as {
				text: string;
				totalLines: number;
				shownLines: number;
				truncated: boolean;
				truncatedBy: string;
			};
			expect(firstData.totalLines).toBe(2500);
			expect(firstData.shownLines).toBe(2000);
			expect(firstData.truncated).toBe(true);
			expect(firstData.truncatedBy).toBe("lines");
			expect(firstData.text.split("\n").length).toBe(2000);
			expect(firstData.text.startsWith("line-0\n")).toBe(true);

			const second = await core.handleCommand({
				type: "read_file",
				path: join(tempDir, "big.txt"),
				offset: 2001,
			});
			const secondData = responseData(second) as {
				text: string;
				shownLines: number;
				truncated: boolean;
			};
			expect(secondData.text.startsWith("line-2000\n")).toBe(true);
			expect(secondData.shownLines).toBe(2500);
			expect(secondData.truncated).toBe(false);
		});

		it("honors an explicit line limit and marks truncation", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "three.txt"), "a\nb\nc");
			const response = await core.handleCommand({
				type: "read_file",
				path: join(tempDir, "three.txt"),
				limit: 2,
			});
			const data = responseData(response) as { text: string; shownLines: number; truncated: boolean };
			expect(data.text).toBe("a\nb");
			expect(data.shownLines).toBe(2);
			expect(data.truncated).toBe(true);
		});

		it("returns images as base64 data", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "pixel.png"), TINY_PNG);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "pixel.png") });
			const data = responseData(response) as {
				kind: string;
				data: string;
				mimeType: string;
				size: number;
			};
			expect(data.kind).toBe("image");
			expect(data.mimeType).toBe("image/png");
			expect(data.size).toBe(TINY_PNG.length);
			expect(data.data).toBe(TINY_PNG.toString("base64"));
		});

		it("flags oversized images as unsupported", async () => {
			const { core, tempDir } = await fixture();
			const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00]), Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)]);
			writeFileSync(join(tempDir, "huge.jpg"), big);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "huge.jpg") });
			const data = responseData(response) as { kind: string; size: number; reason: string };
			expect(data.kind).toBe("unsupported");
			expect(data.size).toBe(big.length);
			expect(data.reason).toBe("too-large");
		});

		it("flags binary content as unsupported", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0x03]));
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "blob.bin") });
			const data = responseData(response) as { kind: string; size: number };
			expect(data.kind).toBe("unsupported");
			expect(data.size).toBe(4);
		});

		it("errors for missing files, directories, and out-of-range offsets", async () => {
			const { core, tempDir } = await fixture();
			const missing = await core.handleCommand({ type: "read_file", path: join(tempDir, "nope.txt") });
			expect(missing?.success).toBe(false);
			const directory = await core.handleCommand({ type: "read_file", path: tempDir });
			expect(directory?.success).toBe(false);
			writeFileSync(join(tempDir, "two.txt"), "a\nb");
			const beyond = await core.handleCommand({
				type: "read_file",
				path: join(tempDir, "two.txt"),
				offset: 99,
			});
			expect(beyond?.success).toBe(false);
		});
	});
});
