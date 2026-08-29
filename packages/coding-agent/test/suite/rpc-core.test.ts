import { mkdirSync, rmSync } from "node:fs";
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
import type { ExtensionAPI } from "../../src/index.ts";
import { RpcCore } from "../../src/modes/rpc/rpc-core.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";

describe("RpcCore", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createCore(): Promise<{ core: RpcCore; sent: object[] }> {
		const tempDir = join(tmpdir(), `pi-rpc-core-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
		faux.setResponses([fauxAssistantMessage("hello world")]);
		cleanups.push(() => faux.unregister());

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
				noSkills: true,
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
			sessionManager: SessionManager.inMemory(tempDir),
		});

		const sent: object[] = [];
		const core = new RpcCore({ runtime, send: (message) => sent.push(message) });
		await core.init();
		cleanups.push(async () => {
			await core.dispose();
		});
		return { core, sent };
	}

	it("answers get_state with session state", async () => {
		const { core } = await createCore();
		const response = await core.handleCommand({ type: "get_state" });
		expect(response?.success).toBe(true);
		const data = response && "data" in response ? (response.data as object | null) : null;
		expect(data).not.toBeNull();
		if (data) {
			const state = data as { model?: { id?: string }; sessionId?: string };
			expect(state.model).toMatchObject({ id: "faux-1" });
			expect(typeof state.sessionId).toBe("string");
		}
	});

	it("returns an error response for unknown commands", async () => {
		const { core } = await createCore();
		const response = await core.handleCommand({ type: "does_not_exist" } as never);
		expect(response?.success).toBe(false);
		if (response && !response.success) {
			expect(response.error).toContain("Unknown command");
		}
	});

	it("streams agent events through send", async () => {
		const { core, sent } = await createCore();
		await core.handleCommand({ type: "prompt", message: "hi" });
		await core.getSession().waitForIdle();
		const types = sent.map((m) => (m as { type?: string }).type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_update");
		expect(types).toContain("agent_end");
		expect(types).toContain("agent_settled");
	});

	it("routes extension ui responses to pending requests", async () => {
		const { core } = await createCore();
		const pending = core.handleCommand({ type: "get_state" });
		expect(pending).toBeDefined();
		// extension UI responses for unknown ids are ignored
		core.handleExtensionUIResponse({ type: "extension_ui_response", id: "missing", cancelled: true });
	});

	it("delegates unknown commands to the extra command handler", async () => {
		const { core } = await createCore();
		const seen: object[] = [];
		const coreWithExtra = new RpcCore({
			runtime: core.getRuntime(),
			send: (message) => seen.push(message),
			extraCommandHandler: async (command) =>
				(command as { type: string }).type === "custom_thing"
					? ({ type: "response", command: "custom_thing", success: true } as RpcResponse)
					: undefined,
		});
		await coreWithExtra.init();
		cleanups.push(() => coreWithExtra.close());

		const handled = await coreWithExtra.handleCommand({ type: "custom_thing" } as never);
		expect(handled).toMatchObject({ success: true, command: "custom_thing" });

		const unhandled = await coreWithExtra.handleCommand({ type: "other_thing" } as never);
		expect(unhandled && !unhandled.success).toBe(true);
	});
});
