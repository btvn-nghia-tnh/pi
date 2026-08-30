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
import { WebSessionManager } from "../../src/modes/web/web-session-manager.ts";

describe("WebSessionManager", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createManager(): Promise<{ manager: WebSessionManager; broadcast: object[]; tempDir: string }> {
		const tempDir = join(tmpdir(), `pi-web-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

		const sessionDir = join(tempDir, "sessions");
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, sessionDir),
		});

		const broadcast: object[] = [];
		const manager = new WebSessionManager({
			primaryRuntime: runtime,
			broadcast: (message) => broadcast.push(message),
		});
		await manager.init();
		return { manager, broadcast, tempDir };
	}

	it("wraps the primary runtime as the first slot", async () => {
		const { manager } = await createManager();
		const primary = manager.getPrimary();
		expect(manager.getSlots()).toHaveLength(1);
		expect(manager.getSlot(primary.id)).toBe(primary);
		expect(primary.cwd).toBe(manager.getPrimary().runtime.cwd);
		expect(manager.isSlotRunning(primary)).toBe(false);
	});

	it("newSession opens an independent slot; the primary is untouched", async () => {
		const { manager } = await createManager();
		const primary = manager.getPrimary();
		const slot = await manager.newSession();
		expect(manager.getSlots()).toHaveLength(2);
		expect(slot.id).not.toBe(primary.id);
		expect(slot.sessionPath).not.toBe(manager.getPrimary().sessionPath);
		// The client learns about new slots from the open_session/new_session
		// command response — session_start fires during slot construction,
		// before any RpcCore subscriber attaches.
	});

	it("openSession reuses the slot for the same path", async () => {
		const { manager } = await createManager();
		const created = await manager.newSession();
		expect(created.sessionPath).toBeDefined();
		const opened = await manager.openSession(created.sessionPath!);
		expect(opened.id).toBe(created.id);
		expect(manager.getSlots()).toHaveLength(2);
	});

	it("openSession opens a persisted session as a new slot with its own cwd", async () => {
		const { manager, tempDir } = await createManager();
		// Author a session in a different project: prompt it once so the
		// file lands on disk with its header (cwd = the other project).
		const otherDir = join(tempDir, "other-project");
		mkdirSync(otherDir, { recursive: true });
		const sessionManager = SessionManager.create(otherDir);
		const primary = manager.getPrimary();
		const authorRuntime = await primary.runtime.createSibling(sessionManager);
		const sent: object[] = [];
		const core = new (await import("../../src/modes/rpc/rpc-core.ts")).RpcCore({
			runtime: authorRuntime,
			send: (message) => sent.push(message),
		});
		await core.init();
		await core.handleCommand({ type: "prompt", message: "hi" });
		await authorRuntime.session.waitForIdle();
		const sessionFile = authorRuntime.session.sessionFile;
		expect(sessionFile).toBeDefined();
		await core.dispose();

		const slot = await manager.openSession(sessionFile!);
		expect(manager.getSlots()).toHaveLength(2);
		expect(slot.cwd).toBe(otherDir);
		expect(slot.sessionPath).toBe(sessionFile);
	});

	it("closeSession aborts, disposes and removes non-primary slots", async () => {
		const { manager, broadcast } = await createManager();
		const slot = await manager.newSession();
		const result = await manager.closeSession(slot.id);
		expect(result).toEqual({ closed: true });
		expect(manager.getSlots()).toHaveLength(1);
		expect(manager.getSlot(slot.id)).toBeUndefined();
		// Clients are told the session is gone.
		expect(broadcast).toContainEqual({ type: "session_closed", sessionId: slot.id });
	});

	it("the primary slot cannot be closed", async () => {
		const { manager } = await createManager();
		const result = await manager.closeSession(manager.getPrimary().id);
		expect(result).toEqual({ closed: false, reason: "primary" });
		expect(manager.getSlots()).toHaveLength(1);
	});

	it("closeSession reports unknown ids", async () => {
		const { manager } = await createManager();
		expect(await manager.closeSession("nope")).toEqual({ closed: false, reason: "not_found" });
	});

	it("slot output is tagged with the slot id and tracked in its own widget cache", async () => {
		const { manager, broadcast } = await createManager();
		const primary = manager.getPrimary();
		const slot = await manager.newSession();
		broadcast.length = 0;

		// Extension UI requests emitted by the slot's RpcCore carry the tag
		// and land in the slot's own widget cache.
		slot.rpcCore.sendExtensionUIRequest({
			type: "extension_ui_request",
			id: "w1",
			method: "setWidgetData",
			widgetKey: "ask",
			widgetData: { kind: "ask", display: "overlay" },
		} as never);
		const tagged = broadcast.find(
			(message) =>
				(message as { type?: string; widgetKey?: string }).type === "extension_ui_request" &&
				(message as { widgetKey?: string }).widgetKey === "ask",
		) as { sessionId?: string } | undefined;
		expect(tagged?.sessionId).toBe(slot.id);
		expect(slot.widgets.widgets.has("ask")).toBe(true);
		expect(primary.widgets.widgets.has("ask")).toBe(false);
	});
});
