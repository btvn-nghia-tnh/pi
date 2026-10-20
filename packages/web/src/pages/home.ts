/**
 * Home dashboard page (spec §3.3, mockup 01-home.svg): welcome hero with a
 * quick-start prompt bar, active sessions / today's usage / MCP health cards,
 * and recent projects + sessions lists. The page owns markup + fetch
 * orchestration only — every action is a deps callback the app (integrator)
 * wires. Fetches start on mount; unmount drops in-flight results and the MCP
 * widget subscription.
 */

import { chipEl, iconEl, pillEl, sparklineEl } from "../components/kit.ts";
import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import type { McpWidgetData } from "../render/widget-data.ts";
import type { ShellPage } from "../shell.ts";
import type { RpcSessionSummary } from "../types.ts";
import { type UsageSummary, usageStatCards } from "../usage-client.ts";
import { formatCost, totalsLine } from "../usage-text.ts";

/** Sessions come from `list_sessions` summaries; app mirrors the rpc shape. */
export type SessionRow = RpcSessionSummary;

/** Everything the page needs from the app; the integrator (app.ts) wires it. */
export interface HomePageDeps {
	/** Reserved for direct command access if a section needs it later. */
	connection(): PiConnection | undefined;
	fetchSessions(): Promise<Array<SessionRow>>;
	fetchSummary: (rangeDays: number) => Promise<UsageSummary>;
	subscribeWidget(cb: (data: McpWidgetData | undefined) => void): () => void;
	openSessions(): Array<{ id: string; cwd: string; running: boolean }>;
	currentVersion(): string | undefined;
	primaryCwd(): string | undefined;
	onOpenSession(idOrFile: string): void;
	onNewSession(cwd: string | undefined): void;
	onNavigate(page: "chat" | "projects" | "mcp" | "usage" | "settings"): void;
	/** Submit a prompt through the app's normal pipeline (ensures a session). */
	runPrompt(text: string): void;
	/** Anchor for the model picker popover (the toolbar model chip). */
	modelPickerAnchor(): HTMLElement | undefined;
	onOpenModels: (anchor: HTMLElement) => void;
}

// ---------------------------------------------------------------------------
// Pure projections (tested in test/home-page.test.ts — no fetches in here)
// ---------------------------------------------------------------------------

export interface HeroCopy {
	heading: string;
	sub: string;
	versionChip: string | undefined;
}

/** Hero copy in the Phase-1 stubs tone; version becomes a small chip. */
export function heroPlaceholder(version?: string): HeroCopy {
	return {
		heading: "Welcome back",
		sub: "Pick a session, or start something new — pi is listening.",
		versionChip: version ? `pi v${version}` : undefined,
	};
}

export interface ProjectGroup {
	name: string;
	path: string;
	count: number;
	lastModified: string;
	running: number;
}

/** Group session summaries by cwd, newest project first. */
export function recentProjects(
	sessions: SessionRow[],
	open: Array<{ id: string; cwd: string; running: boolean }>,
): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	for (const session of sessions) {
		let group = groups.get(session.cwd);
		if (!group) {
			group = { name: dirLabel(session.cwd), path: session.cwd, count: 0, lastModified: "", running: 0 };
			groups.set(session.cwd, group);
		}
		group.count++;
		if (session.modified > group.lastModified) group.lastModified = session.modified;
	}
	for (const entry of open) {
		const group = groups.get(entry.cwd);
		if (group && entry.running) group.running++;
	}
	return [...groups.values()].sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
}

export interface SessionListItem {
	id: string;
	file: string;
	displayName: string;
	path: string;
	modified: string;
}

/** Top N sessions by modification; display name falls back name→firstMessage→id. */
export function recentSessions(sessions: SessionRow[], limit: number): SessionListItem[] {
	return [...sessions]
		.sort((a, b) => (a.modified < b.modified ? 1 : -1))
		.slice(0, Math.max(0, limit))
		.map((session) => ({
			id: session.id,
			file: session.file,
			displayName: session.name || session.firstMessage || session.id,
			path: session.cwd,
			modified: session.modified,
		}));
}

/**
 * Normalize per-day costs to 0..1 fractions of the max for the sparkline.
 * Single-point series gain a leading 0 (kit's barPoints single-value path is
 * unclamped); empty input yields no series.
 */
export function sparklineSeries(costs: number[]): number[] {
	if (costs.length === 0) return [];
	let max = 0;
	for (const cost of costs) max = Math.max(max, cost);
	const normalized = max > 0 ? costs.map((cost) => cost / max) : costs.map(() => 0);
	return normalized.length === 1 ? [0, normalized[0]!] : normalized;
}

/** Coarse relative time ("just now" / "30m ago" / "10h ago" / "4d ago"). */
export function relativeTime(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "—";
	const deltaSeconds = Math.max(0, Math.floor((now - then) / 1000));
	if (deltaSeconds < 60) return "just now";
	if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
	if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
	return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function dirLabel(cwd: string): string {
	const base = cwd.split("/").filter(Boolean).pop();
	return base ?? "/";
}

/** Section card wrapper hosting a caller-owned body element. */
function sectionCard(title: string, body: HTMLElement, linkLabel?: string, onLink?: () => void): HTMLElement {
	const titleElement =
		linkLabel && onLink
			? h(
					"div",
					{ class: "c-card-title c-card-link", onclick: onLink },
					title,
					h("span", { class: "c-card-title-arrow" }, linkLabel),
				)
			: h("div", { class: "c-card-title" }, title);
	return h("div", { class: "c-card home-card" }, titleElement, body);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export class HomePage implements ShellPage {
	readonly id = "home" as const;
	readonly title = "Home";
	readonly element: HTMLElement;

	private readonly deps: HomePageDeps;
	private disposed = false;
	private unsubscribeWidget: (() => void) | undefined;

	// Dynamic hosts (populated by the renderers below).
	private readonly quickHost: HTMLElement;
	private readonly activeHost: HTMLElement;
	private readonly todayHost: HTMLElement;
	private readonly mcpHost: HTMLElement;
	private readonly projectsHost: HTMLElement;
	private readonly sessionsHost: HTMLElement;

	constructor(deps: HomePageDeps) {
		this.deps = deps;

		const hero = heroPlaceholder(deps.currentVersion());
		const headingRow = h("div", { class: "home-heading-row" }, h("span", { class: "home-heading" }, hero.heading));
		if (hero.versionChip) {
			headingRow.appendChild(chipEl(hero.versionChip, { mono: true }));
		}

		const input = h("input", {
			class: "home-hero-input c-popover-search",
			placeholder: "What should we build today?",
			"aria-label": "New prompt",
		}) as HTMLInputElement;
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			const text = input.value.trim();
			if (!text) return;
			input.value = "";
			this.deps.runPrompt(text);
		});

		const projectChip = chipEl(dirLabel(deps.primaryCwd() ?? "~"), {
			icon: "folder",
			mono: true,
			title: "Primary project",
		});
		const modelChip = chipEl("model ▾", { icon: "gear", title: "Switch model" });
		modelChip.addEventListener("click", () => {
			this.deps.onOpenModels(this.deps.modelPickerAnchor() ?? modelChip);
		});

		this.quickHost = h("div", { class: "home-quick" });
		this.activeHost = h("div", {});
		this.todayHost = h("div", {});
		this.mcpHost = h("div", {});
		this.projectsHost = h("div", {});
		this.sessionsHost = h("div", {});

		const active = sectionCard("Active sessions", this.activeHost, "View all →", () => this.deps.onNavigate("chat"));
		const today = sectionCard("Today", this.todayHost, "Usage →", () => this.deps.onNavigate("usage"));
		const mcp = sectionCard("MCP", this.mcpHost, "Manage →", () => this.deps.onNavigate("mcp"));
		const projects = sectionCard("Recent projects", this.projectsHost);
		const sessions = sectionCard("Recent sessions", this.sessionsHost);

		const body = h(
			"div",
			{ class: "home-body" },
			h(
				"div",
				{ class: "home-hero" },
				headingRow,
				h("p", { class: "home-sub" }, hero.sub),
				h(
					"div",
					{ class: "home-hero-card" },
					input,
					h("div", { class: "home-hero-chips" }, projectChip, modelChip),
				),
				h("div", { class: "home-quick-row" }, h("span", { class: "home-label" }, "Recent"), this.quickHost),
			),
			h(
				"div",
				{ class: "home-cards" },
				h("div", { class: "home-card-slot" }, active),
				h("div", { class: "home-card-slot" }, today),
				h("div", { class: "home-card-slot" }, mcp),
			),
			h(
				"div",
				{ class: "home-two-col" },
				h("div", { class: "home-card-slot home-tall" }, projects),
				h("div", { class: "home-card-slot home-tall" }, sessions),
			),
		);
		this.element = h(
			"div",
			{ class: "c-page home-page" },
			h("div", { class: "c-page-header" }, h("span", { class: "c-page-title" }, this.title)),
			body,
		);
	}

	mount(): void {
		this.disposed = false;
		this.renderActiveSessions();
		this.renderMcp(undefined);

		this.unsubscribeWidget = this.deps.subscribeWidget((data) => this.renderMcp(data));

		this.deps
			.fetchSessions()
			.then((sessions) => {
				if (!this.disposed) this.renderSessions(sessions);
			})
			.catch(() => {
				if (!this.disposed) {
					clearElement(this.projectsHost);
					this.projectsHost.appendChild(h("p", { class: "home-dim" }, "Sessions unavailable — reconnecting?"));
				}
			});

		this.deps
			.fetchSummary(1)
			.then((summary) => {
				if (!this.disposed) this.renderToday(summary);
			})
			.catch(() => {
				if (!this.disposed) this.todayHost.appendChild(h("p", { class: "home-dim" }, "Usage unavailable"));
			});
	}

	unmount(): void {
		this.disposed = true;
		this.unsubscribeWidget?.();
		this.unsubscribeWidget = undefined;
	}

	// -- Renders -----------------------------------------------------------

	private renderActiveSessions(): void {
		clearElement(this.activeHost);
		const open = this.deps.openSessions();
		if (open.length === 0) {
			this.activeHost.appendChild(h("p", { class: "home-dim" }, "No open sessions"));
			return;
		}
		for (const entry of open) {
			const pill = pillEl(entry.running ? "running" : "open", entry.running ? "accent" : "neutral");
			const row = h(
				"div",
				{ class: "home-row", onclick: () => this.deps.onOpenSession(entry.id) },
				pill,
				h("span", { class: "home-row-main" }, dirLabel(entry.cwd)),
				h("span", { class: "home-row-meta mono" }, entry.id.slice(0, 8)),
			);
			this.activeHost.appendChild(row);
		}
	}

	private renderToday(summary: UsageSummary): void {
		clearElement(this.todayHost);
		if (summary.totals.sessions === 0) {
			this.todayHost.appendChild(h("p", { class: "home-dim" }, "no usage yet today"));
			return;
		}
		const cards = usageStatCards(summary, null);
		const costs = summary.perDay.map((day) => day.cost);
		const models = summary.perModel.length > 0 ? summary.perModel.map((model) => model.model).join(" · ") : "—";
		this.todayHost.append(
			h("div", { class: "c-usage-hero mono" }, formatCost(summary.totals.cost)),
			h(
				"div",
				{ class: "home-row-meta mono" },
				totalsLine(
					{ input: summary.totals.input, output: summary.totals.output, cost: summary.totals.cost },
					cards.hitPct,
				),
			),
			sparklineEl(sparklineSeries(costs), 220, 44),
			h("div", { class: "home-dim home-nowrap" }, `models: ${models}`),
		);
	}

	private renderMcp(data: McpWidgetData | undefined): void {
		clearElement(this.mcpHost);
		const servers = data?.servers ?? [];
		if (servers.length === 0) {
			this.mcpHost.appendChild(h("p", { class: "home-dim" }, "no servers reporting"));
			return;
		}
		const totals = data?.totals;
		const connected = totals?.connected ?? servers.filter((server) => server.status === "connected").length;
		const total = totals?.servers ?? servers.length;
		this.mcpHost.appendChild(h("div", { class: "c-usage-hero mono" }, `${connected}/${total} connected`));
		const attention = servers.filter((server) => server.status === "needs-auth" || server.status === "failed");
		for (const server of attention) {
			const label = server.status === "needs-auth" ? `${server.name} needs sign-in` : `${server.name} failing`;
			this.mcpHost.appendChild(h("div", { class: "home-warn-line" }, pillEl(label, "warn")));
		}
		const roster = servers.map((server) => (server.disabled ? `${server.name} (disabled)` : server.name)).join(" · ");
		this.mcpHost.appendChild(h("div", { class: "home-dim home-ellipsis" }, roster));
		if (totals?.tools !== undefined) {
			this.mcpHost.appendChild(h("div", { class: "home-row-meta mono" }, `${totals.tools} tools`));
		}
	}

	private renderSessions(sessions: SessionRow[]): void {
		clearElement(this.quickHost);
		for (const row of recentSessions(sessions, 4)) {
			this.quickHost.appendChild(
				chipEl(row.displayName, {
					tone: "accent",
					title: row.path,
					onClick: () => this.deps.onOpenSession(row.id),
				}),
			);
		}

		clearElement(this.projectsHost);
		const groups = recentProjects(sessions, this.deps.openSessions());
		if (groups.length === 0) {
			this.projectsHost.appendChild(h("p", { class: "home-dim" }, "No projects yet"));
		}
		for (const group of groups) {
			const meta = `${group.count} sessions · last ${relativeTime(group.lastModified, Date.now())}`;
			const runningChip = group.running > 0 ? pillEl(`${group.running} running`, "accent") : undefined;
			const row = h(
				"div",
				{ class: "home-row", onclick: () => this.deps.onNavigate("projects") },
				iconEl("folder"),
				h("span", { class: "home-row-main" }, group.name),
				h("span", { class: "home-row-meta mono" }, group.path),
				h("span", { class: "home-row-meta" }, meta),
				...(runningChip ? [runningChip] : []),
			);
			this.projectsHost.appendChild(row);
		}
		this.projectsHost.appendChild(
			h(
				"p",
				{ class: "home-new-line", onclick: () => this.deps.onNewSession(undefined) },
				"New project → start a session in any folder",
			),
		);

		clearElement(this.sessionsHost);
		const openById = new Map(this.deps.openSessions().map((entry) => [entry.id, entry]));
		for (const row of recentSessions(sessions, 5)) {
			const open = openById.get(row.id);
			const pill = open ? pillEl(open.running ? "running" : "open", open.running ? "accent" : "neutral") : undefined;
			const rowEl = h(
				"div",
				{ class: "home-row", onclick: () => this.deps.onOpenSession(row.id) },
				...(pill ? [pill] : []),
				h("span", { class: "home-row-main" }, row.displayName),
				h("span", { class: "home-row-meta mono" }, row.path),
				h("span", { class: "home-row-meta" }, relativeTime(row.modified, Date.now())),
			);
			this.sessionsHost.appendChild(rowEl);
		}
	}
}

export function createHomePage(deps: HomePageDeps): ShellPage {
	return new HomePage(deps);
}
