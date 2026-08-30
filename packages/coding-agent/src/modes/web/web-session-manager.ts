/**
 * Multi-session registry for the web host.
 *
 * The web GUI supports several open sessions side by side: every open session
 * owns its own `AgentSessionRuntime` + `RpcCore` pair (a *slot*), runs its
 * turns independently of the others, and streams its messages tagged with its
 * session id. The primary slot wraps the runtime the server was started
 * with; additional slots are created on demand from the sidebar.
 *
 * The active session is a purely client-side pointer — the server has no
 * notion of "which session the user is looking at"; it only routes tagged
 * commands to the owning slot.
 */

import { emitSessionShutdownEvent } from "../../core/extensions/runner.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { RpcCore } from "../rpc/rpc-core.ts";
import { createWebCommandHandler } from "./web-commands.ts";
import { applyExtensionUiMessage, type WidgetCache } from "./widget-cache.ts";

export interface WebSessionSlot {
	/** AgentSession.sessionId — the wire tag for everything this slot emits. */
	id: string;
	/** Session file on disk; undefined while the session is in-memory only. */
	sessionPath: string | undefined;
	/** Working directory of the session (project identity for the sidebar). */
	cwd: string;
	runtime: AgentSessionRuntime;
	rpcCore: RpcCore;
	/** Per-slot widget/status registrations (see widget-cache.ts). */
	widgets: WidgetCache;
}

export class WebSessionManager {
	private readonly slots = new Map<string, WebSessionSlot>();
	private primarySlot: WebSessionSlot | undefined;
	private readonly broadcast: (message: object) => void;
	private readonly primaryRuntime: AgentSessionRuntime;

	constructor(options: { primaryRuntime: AgentSessionRuntime; broadcast: (message: object) => void }) {
		this.broadcast = options.broadcast;
		this.primaryRuntime = options.primaryRuntime;
	}

	/** Bind the primary slot. Must be awaited before serving requests. */
	async init(): Promise<void> {
		if (!this.primarySlot) {
			this.primarySlot = await this.createSlot(this.primaryRuntime);
		}
	}

	/** The slot wrapping the runtime the server process was started with. */
	getPrimary(): WebSessionSlot {
		if (!this.primarySlot) throw new Error("WebSessionManager not initialized");
		return this.primarySlot;
	}

	getSlots(): WebSessionSlot[] {
		return [...this.slots.values()];
	}

	getSlot(id: string): WebSessionSlot | undefined {
		return this.slots.get(id);
	}

	findSlotByPath(sessionPath: string): WebSessionSlot | undefined {
		return this.getSlots().find((slot) => slot.sessionPath === sessionPath);
	}

	/** Whether the slot's session has an agent turn (or continuation) in flight. */
	isSlotRunning(slot: WebSessionSlot): boolean {
		return !slot.runtime.session.isIdle;
	}

	/**
	 * Open (or return the already-open slot for) a session file on disk.
	 * The session resumes with its own cwd — which may belong to another
	 * project than the server's.
	 */
	async openSession(sessionPath: string): Promise<WebSessionSlot> {
		const existing = this.findSlotByPath(sessionPath);
		if (existing) return existing;
		const sessionManager = SessionManager.open(sessionPath, undefined, undefined);
		const runtime = await this.getPrimary().runtime.createSibling(sessionManager, {
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		return await this.createSlot(runtime);
	}

	/** Create a fresh session in the primary slot's cwd and open it as a slot. */
	async newSession(): Promise<WebSessionSlot> {
		const primarySession = this.getPrimary().runtime.session;
		const sessionDir = primarySession.sessionManager.getSessionDir();
		const sessionManager = primarySession.sessionManager.isPersisted()
			? SessionManager.create(this.getPrimary().runtime.cwd, sessionDir)
			: SessionManager.inMemory(this.getPrimary().runtime.cwd);
		const runtime = await this.getPrimary().runtime.createSibling(sessionManager, {
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		return await this.createSlot(runtime);
	}

	/**
	 * Close an open slot: abort any in-flight turn (it is persisted as
	 * aborted), emit the session's shutdown events, dispose the runtime, and
	 * remove the slot. The primary slot cannot be closed — it belongs to the
	 * server process lifetime; returns false with a reason instead.
	 */
	async closeSession(id: string): Promise<{ closed: boolean; reason?: "not_found" | "primary" }> {
		const slot = this.slots.get(id);
		if (!slot) return { closed: false, reason: "not_found" };
		if (slot === this.getPrimary()) return { closed: false, reason: "primary" };

		this.slots.delete(id);
		try {
			// Settle and persist the aborted turn before disposal.
			await slot.runtime.session.abort();
			await emitSessionShutdownEvent(slot.runtime.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
			slot.runtime.session.dispose();
		} finally {
			slot.rpcCore.close();
		}
		this.broadcast({ type: "session_closed", sessionId: id });
		return { closed: true };
	}

	/** Wrap a runtime as a slot with a tagged RpcCore and its own widget cache. */
	private async createSlot(runtime: AgentSessionRuntime): Promise<WebSessionSlot> {
		const session = runtime.session;
		const slot: WebSessionSlot = {
			id: session.sessionId,
			sessionPath: session.sessionFile,
			cwd: runtime.cwd,
			runtime,
			rpcCore: undefined as never,
			widgets: { widgets: new Map(), statuses: new Map() },
		};
		slot.rpcCore = new RpcCore({
			runtime,
			send: (message) => {
				// Track this slot's own widget/status registrations, then tag
				// and broadcast to every connected client.
				applyExtensionUiMessage(slot.widgets, message);
				if ((message as { type?: string }).type === "session_start") {
					slot.widgets.widgets.clear();
					slot.widgets.statuses.clear();
				}
				this.broadcast({ ...message, sessionId: slot.id });
			},
			extraCommandHandler: createWebCommandHandler(),
		});
		await slot.rpcCore.init();
		this.slots.set(slot.id, slot);
		return slot;
	}
}
