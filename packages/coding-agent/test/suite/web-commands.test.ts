import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
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

		it("terminates paging on files ending with empty lines", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "blanky.txt"), "a\n\n");
			const first = await core.handleCommand({ type: "read_file", path: join(tempDir, "blanky.txt") });
			const firstData = responseData(first) as { shownLines: number; totalLines: number; truncated: boolean };
			expect(firstData.totalLines).toBe(2);
			expect(firstData.shownLines).toBe(2);
			expect(firstData.truncated).toBe(false);

			writeFileSync(join(tempDir, "middle.txt"), "a\n\nb");
			const page1 = await core.handleCommand({ type: "read_file", path: join(tempDir, "middle.txt"), limit: 1 });
			const page1Data = responseData(page1) as { shownLines: number; truncated: boolean };
			expect(page1Data.shownLines).toBe(1);
			expect(page1Data.truncated).toBe(true);
			const page2 = await core.handleCommand({
				type: "read_file",
				path: join(tempDir, "middle.txt"),
				offset: 2,
				limit: 1,
			});
			const page2Data = responseData(page2) as { shownLines: number; truncated: boolean };
			expect(page2Data.shownLines).toBe(2);
			expect(page2Data.truncated).toBe(true);
			const page3 = await core.handleCommand({
				type: "read_file",
				path: join(tempDir, "middle.txt"),
				offset: 3,
				limit: 1,
			});
			const page3Data = responseData(page3) as { shownLines: number; truncated: boolean };
			expect(page3Data.shownLines).toBe(3);
			expect(page3Data.truncated).toBe(false);
		});

		it("reports file size for text previews", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "sized.txt"), "hello\nworld");
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "sized.txt") });
			const data = responseData(response) as { kind: string; size?: number };
			expect(data.kind).toBe("text");
			expect(data.size).toBe(11);
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

		/** Build an in-memory ZIP with deflated entries (office fixtures). */
		const buildZip = (files: Record<string, string>): Buffer => {
			const locals: Buffer[] = [];
			const centrals: Buffer[] = [];
			let offset = 0;
			for (const [name, content] of Object.entries(files)) {
				const nameBuffer = Buffer.from(name, "utf-8");
				const data = Buffer.from(content, "utf-8");
				const compressed = deflateRawSync(data);
				const crc = crc32(data) >>> 0;
				const local = Buffer.alloc(30);
				local.writeUInt32LE(0x04034b50, 0);
				local.writeUInt16LE(8, 8);
				local.writeUInt32LE(crc, 14);
				local.writeUInt32LE(compressed.length, 18);
				local.writeUInt32LE(data.length, 22);
				local.writeUInt16LE(nameBuffer.length, 26);
				locals.push(local, nameBuffer, compressed);
				const central = Buffer.alloc(46);
				central.writeUInt32LE(0x02014b50, 0);
				central.writeUInt16LE(8, 10);
				central.writeUInt32LE(crc, 16);
				central.writeUInt32LE(compressed.length, 20);
				central.writeUInt32LE(data.length, 24);
				central.writeUInt16LE(nameBuffer.length, 28);
				central.writeUInt32LE(offset, 42);
				centrals.push(central, nameBuffer);
				offset += 30 + nameBuffer.length + compressed.length;
			}
			const centralDirectory = Buffer.concat(centrals);
			const eocd = Buffer.alloc(22);
			eocd.writeUInt32LE(0x06054b50, 0);
			eocd.writeUInt16LE(Object.keys(files).length, 8);
			eocd.writeUInt16LE(Object.keys(files).length, 10);
			eocd.writeUInt32LE(centralDirectory.length, 12);
			eocd.writeUInt32LE(offset, 16);
			return Buffer.concat([...locals, centralDirectory, eocd]);
		};

		it("previews xlsx files as a spreadsheet", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(
				join(tempDir, "data.xlsx"),
				buildZip({
					"xl/workbook.xml": '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
					"xl/_rels/workbook.xml.rels":
						'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
					"xl/sharedStrings.xml": "<sst><si><t>Name</t></si></sst>",
					"xl/worksheets/sheet1.xml":
						'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>',
				}),
			);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "data.xlsx") });
			const data = responseData(response) as { kind: string; sheets: { name: string; rows: string[][] }[] };
			expect(data.kind).toBe("spreadsheet");
			expect(data.sheets[0].name).toBe("Data");
			expect(data.sheets[0].rows).toEqual([["Name", "7"]]);
		});

		it("previews docx files as a document", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(
				join(tempDir, "doc.docx"),
				buildZip({
					"word/document.xml":
						'<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>',
				}),
			);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "doc.docx") });
			const data = responseData(response) as {
				kind: string;
				blocks: { type: string; text?: string; level?: number }[];
			};
			expect(data.kind).toBe("document");
			expect(data.blocks[0]).toEqual({ type: "heading", level: 1, text: "Hello" });
		});

		it("errors for corrupt office files instead of falling through to binary", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "bad.xlsx"), "not a zip at all");
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "bad.xlsx") });
			expect(response?.success).toBe(false);
		});
	});

	describe("read_file notebooks", () => {
		function notebook(cells: unknown[], extra: Record<string, unknown> = {}): string {
			return JSON.stringify({
				cells,
				metadata: { kernelspec: { language: "python" } },
				nbformat: 4,
				nbformat_minor: 5,
				...extra,
			});
		}

		it("renders markdown and code cells with compacted outputs", async () => {
			const { core, tempDir } = await fixture();
			const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
			writeFileSync(
				join(tempDir, "demo.ipynb"),
				notebook([
					{ cell_type: "markdown", source: ["# Title\n", "plain text"], metadata: {} },
					{
						cell_type: "code",
						execution_count: 7,
						source: "print('hi')",
						metadata: {},
						outputs: [
							{ output_type: "stream", name: "stdout", text: ["hi\n"] },
							{ output_type: "stream", name: "stderr", text: ["warning\n"] },
							{
								output_type: "error",
								ename: "NameError",
								evalue: "name 'x' is not defined",
								traceback: ["Traceback (most recent call last):", "NameError: name 'x' is not defined"],
							},
							{
								output_type: "execute_result",
								execution_count: 7,
								data: { "text/plain": ["42"] },
								metadata: {},
							},
							{ output_type: "display_data", data: { "image/png": png }, metadata: {} },
						],
					},
					{ cell_type: "raw", source: "just raw text" },
				]),
			);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "demo.ipynb") });
			const data = responseData(response) as {
				kind: string;
				size?: number;
				cells?: Array<Record<string, unknown>>;
			};
			expect(data.kind).toBe("notebook");
			expect(data.cells?.length).toBe(3);
			expect(data.cells?.[0]).toMatchObject({ type: "markdown", source: "# Title\nplain text" });
			const code = data.cells?.[1] as Record<string, unknown> & { outputs?: Array<Record<string, unknown>> };
			expect(code.type).toBe("code");
			expect(code.language).toBe("python");
			expect(code.executionCount).toBe(7);
			expect(code.outputs?.[0]).toMatchObject({ type: "stream", name: "stdout", text: "hi\n" });
			expect(code.outputs?.[1]).toMatchObject({ type: "stream", name: "stderr", text: "warning\n" });
			expect(code.outputs?.[2]).toMatchObject({
				type: "error",
				name: "NameError",
				message: "name 'x' is not defined",
				traceback: "Traceback (most recent call last):\nNameError: name 'x' is not defined",
			});
			expect(code.outputs?.[3]).toMatchObject({ type: "text", text: "42" });
			expect(code.outputs?.[4]).toMatchObject({ type: "image", mimeType: "image/png" });
			expect(data.cells?.[2]).toMatchObject({ type: "raw", source: "just raw text" });
			expect(typeof data.size).toBe("number");
		});

		it("defaults the code language to python without kernelspec metadata", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(
				join(tempDir, "nolang.ipynb"),
				JSON.stringify({
					cells: [{ cell_type: "code", source: "x = 1", outputs: [], metadata: {} }],
					metadata: {},
					nbformat: 4,
					nbformat_minor: 5,
				}),
			);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "nolang.ipynb") });
			const cells = (responseData(response)?.cells as Array<Record<string, unknown>>) ?? [];
			expect(cells[0]?.language).toBe("python");
		});

		it("marks truncated text outputs and oversized images", async () => {
			const { core, tempDir } = await fixture();
			const longText = `${"x".repeat(60 * 1024)}`;
			writeFileSync(
				join(tempDir, "big-out.ipynb"),
				notebook([
					{
						cell_type: "code",
						source: "pass",
						outputs: [
							{ output_type: "stream", name: "stdout", text: longText },
							{
								output_type: "display_data",
								data: { "image/png": "A".repeat(5 * 1024 * 1024 + 1) },
								metadata: {},
							},
						],
						metadata: {},
					},
				]),
			);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "big-out.ipynb") });
			const cells = (responseData(response)?.cells as Array<{ outputs?: Array<Record<string, unknown>> }>) ?? [];
			const stream = cells[0]?.outputs?.[0];
			expect(stream?.type).toBe("stream");
			expect(String(stream?.text).length).toBeLessThan(60 * 1024);
			expect(String(stream?.text)).toContain("[output truncated]");
			const image = cells[0]?.outputs?.[1];
			expect(image?.type).toBe("text");
			expect(String(image?.text)).toContain("exceeds the preview size cap");
		});

		it("returns unsupported for non-image, non-text mimes", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(
				join(tempDir, "mime.ipynb"),
				notebook([
					{
						cell_type: "code",
						source: "pass",
						outputs: [{ output_type: "display_data", data: { "text/html": ["<b>hi</b>"] }, metadata: {} }],
						metadata: {},
					},
				]),
			);
			const response = await core.handleCommand({ type: "read_file", path: join(tempDir, "mime.ipynb") });
			const cells = (responseData(response)?.cells as Array<{ outputs?: Array<Record<string, unknown>> }>) ?? [];
			expect(cells[0]?.outputs?.[0]).toMatchObject({ type: "unsupported", mimeType: "text/html" });
		});

		it("rejects invalid JSON and pre-nbformat-4 notebooks", async () => {
			const { core, tempDir } = await fixture();
			writeFileSync(join(tempDir, "broken.ipynb"), "{not json");
			const broken = await core.handleCommand({ type: "read_file", path: join(tempDir, "broken.ipynb") });
			expect(broken?.success).toBe(false);

			writeFileSync(join(tempDir, "v3.ipynb"), JSON.stringify({ worksheets: [], nbformat: 3, cells: [] }));
			const v3 = await core.handleCommand({ type: "read_file", path: join(tempDir, "v3.ipynb") });
			expect(v3?.success).toBe(false);
		});
	});
});
