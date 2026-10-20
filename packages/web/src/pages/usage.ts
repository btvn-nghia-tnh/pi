/**
 * Usage dashboard page (spec §3.5, mockup 05-usage.svg): range chips +
 * model/project client-side selects, 4 stat cards, per-day stacked bar chart,
 * model breakdown with progress bars, sessions table. Data comes from the
 * `get_usage_summary` command via usage-client projections. Styles live in
 * pages.css under the `.cp-usage` prefix.
 */

import { chipEl, iconEl, progressEl } from "../components/kit.ts";
import { modelShortName } from "../components/session-panel.ts";
import type { PiConnection } from "../connection.ts";
import { clearElement, h } from "../dom.ts";
import { formatTokens } from "../footer-format.ts";
import type { ShellPage } from "../shell.ts";
import {
	modelRows,
	type StackedBarDay,
	stackedBarSeries,
	type UsageSessionRow,
	type UsageSummary,
	usageStatCards,
} from "../usage-client.ts";
import { formatCost } from "../usage-text.ts";

// ---------------------------------------------------------------------------
// Pure projections (tested)
// ---------------------------------------------------------------------------

export interface RangeChip {
	label: string;
	/** rangeDays value sent to get_usage_summary (0 = all time). */
	days: number;
	active: boolean;
}

const RANGE_DEFS: Array<{ label: string; days: number }> = [
	{ label: "Today", days: 1 },
	{ label: "7 days", days: 7 },
	{ label: "30 days", days: 30 },
	{ label: "All time", days: 0 },
];

export function rangeChips(rangeDays: number): RangeChip[] {
	return RANGE_DEFS.map((def) => ({ ...def, active: def.days === rangeDays }));
}

export interface ChartRect {
	x: number;
	y: number;
	w: number;
	h: number;
	fill: string;
}

export interface ChartBar {
	day: string;
	/** Short day label ("MM-DD"). */
	label: string;
	/** Formatted cost ("$1.50"). */
	costLabel: string;
	/** Bottom-up stack: input (bottom) → output → cache (top). */
	rects: ChartRect[];
}

const FILL_INPUT = "var(--c-accent)";
const FILL_OUTPUT = "var(--c-blue)";
const FILL_CACHE = "var(--c-dim)";

export function chartGeometry(
	series: StackedBarDay[],
	opts: { width?: number; height?: number; barWidth?: number } = {},
): ChartBar[] {
	if (series.length === 0) return [];
	const width = opts.width ?? 680;
	const height = opts.height ?? 140;
	const n = series.length;
	// R20: scale bars so long ranges (30+ days) never overlap — the requested
	// width is an upper bound; n bars plus n-1 minimum gaps must fit in width.
	const minGap = 2;
	const barWidth = Math.max(1, Math.min(opts.barWidth ?? 28, Math.floor((width - (n - 1) * minGap) / n)));
	const gap = n > 1 ? (width - n * barWidth) / (n - 1) : 0;
	return series.map((entry, i) => {
		const x = n > 1 ? Math.round(i * (barWidth + gap)) : Math.round((width - barWidth) / 2);
		const inH = Math.round(entry.h.input * height);
		const outH = Math.round(entry.h.output * height);
		const cacheH = Math.round(entry.h.cache * height);
		const yIn = height - inH;
		const yOut = yIn - outH;
		const yCache = yOut - cacheH;
		return {
			day: entry.day,
			label: entry.day.slice(5),
			costLabel: entry.label,
			rects: [
				{ x, y: yIn, w: barWidth, h: inH, fill: FILL_INPUT },
				{ x, y: yOut, w: barWidth, h: outH, fill: FILL_OUTPUT },
				{ x, y: yCache, w: barWidth, h: cacheH, fill: FILL_CACHE },
			],
		};
	});
}

export interface UsageFilter {
	/** Exact model id match; empty/undefined = no filter. */
	model?: string;
	/** Exact cwd match; empty/undefined = no filter. */
	project?: string;
}

export function applyFilters(rows: UsageSessionRow[], filter: UsageFilter): UsageSessionRow[] {
	return rows.filter((row) => {
		if (filter.model !== undefined && filter.model !== "" && row.model !== filter.model) return false;
		if (filter.project !== undefined && filter.project !== "" && row.cwd !== filter.project) return false;
		return true;
	});
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface UsagePageDeps {
	connection(): PiConnection | undefined;
	/** Resolves to the get_usage_summary payload (rangeDays: 0 = all time). */
	fetchSummary(rangeDays: number): Promise<UsageSummary>;
	/** Sessions-table row click: id-or-file the integrator routes to a slot. */
	openSession(idOrFile: string): void;
	onNavigate(page: "chat" | "home" | "projects" | "mcp" | "settings"): void;
}

function cellName(row: { name: string; id: string; file: string }): string {
	if (row.name) return row.name;
	return row.file.split(/[\\/]/).pop() ?? row.id;
}

function shortWhen(iso: string): string {
	return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

export function createUsagePage(deps: UsagePageDeps): ShellPage {
	let rangeDays = 7;
	let modelFilter = "";
	let projectFilter = "";
	let summary: UsageSummary | null = null;
	let lastError = "";
	let mounted = false;
	/** In-flight request guard: stale responses (range switch, unmount) drop. */
	let generation = 0;

	const bodyHost = h("div", { class: "cp-usage-body" });

	const element = h(
		"div",
		{ class: "c-page cp-usage" },
		h(
			"div",
			{ class: "c-page-header" },
			h("span", { class: "c-page-title" }, "Usage"),
			h("span", { class: "c-crumb" }, "cost · tokens · sessions"),
			h("button", { class: "c-btn", title: "Reload usage data", onclick: () => void load() }, iconEl("refresh")),
		),
		bodyHost,
	);

	const focusRefetch = (): void => {
		if (mounted && rangeDays > 0) void load();
	};

	async function load(): Promise<void> {
		if (!mounted) return;
		if (!deps.connection()) {
			lastError = "Not connected — usage data needs the agent server.";
			summary = null;
			render();
			return;
		}
		const gen = ++generation;
		let data: UsageSummary;
		try {
			data = await deps.fetchSummary(rangeDays);
		} catch (error) {
			if (gen !== generation) return;
			lastError = error instanceof Error ? error.message : String(error);
			summary = null;
			render();
			return;
		}
		if (gen !== generation) return;
		lastError = "";
		summary = data;
		render();
	}

	function selectEl(
		label: string,
		options: Array<{ value: string; title?: string }>,
		current: string,
		onChange: (value: string) => void,
	): HTMLElement {
		const select = h("select", { class: "cp-select", title: `Filter by ${label}` }) as HTMLSelectElement;
		for (const option of options) {
			const el = h("option", { value: option.value }, option.value === "" ? `all ${label}s` : option.value);
			if (option.title) el.setAttribute("title", option.title);
			select.appendChild(el);
		}
		select.value = current;
		select.addEventListener("change", () => {
			onChange(select.value);
			renderSessionsColumn();
		});
		return select;
	}

	function renderFilters(): HTMLElement {
		const row = h("div", { class: "cp-usage-filters" });
		for (const chip of rangeChips(rangeDays)) {
			row.appendChild(
				chipEl(chip.label, {
					tone: chip.active ? "accent" : "neutral",
					onClick: () => {
						if (rangeDays === chip.days) return;
						rangeDays = chip.days;
						void load();
					},
				}),
			);
		}
		row.appendChild(h("span", { class: "cp-usage-sep" }, ""));
		if (summary) {
			const models = summary.perModel.map((m) => ({ value: m.model }));
			if (!modelFilter || !models.some((m) => m.value === modelFilter)) modelFilter = "";
			row.appendChild(
				selectEl("model", [{ value: "" }, ...models], modelFilter, (v) => {
					modelFilter = v;
				}),
			);
			const cwds: string[] = [];
			for (const row_ of summary.sessions) {
				if (row_.cwd && !cwds.includes(row_.cwd)) cwds.push(row_.cwd);
			}
			if (!projectFilter || !cwds.includes(projectFilter)) projectFilter = "";
			row.appendChild(
				selectEl("project", [{ value: "" }, ...cwds.map((c) => ({ value: c, title: c }))], projectFilter, (v) => {
					projectFilter = v;
				}),
			);
		}
		return row;
	}

	function renderStatCards(): HTMLElement {
		const stats = usageStatCards(summary!, null);
		const cards = h("div", { class: "cp-stat-grid" });
		const mk = (label: string, value: string, sub: string): void => {
			cards.appendChild(
				h(
					"div",
					{ class: "c-card" },
					h("div", { class: "c-card-title" }, label),
					h("div", { class: "cp-stat-value" }, value),
					h("div", { class: "cp-stat-sub" }, sub),
				),
			);
		};
		mk("Cost", stats.cost, `${stats.costDelta} vs previous`);
		mk("Sessions", stats.sessions, "sessions using the range");
		mk(
			"Tokens ↑",
			stats.tokensIn,
			stats.skipped > 0 ? `in + cache-read · ${stats.skipped} skipped` : "in + cache-read",
		);
		mk("Tokens ↓", stats.tokensOut, `out · W ${stats.cacheWrite} · hit ${stats.hitPct ?? "—"}%`);
		return cards;
	}

	function renderChartCard(): HTMLElement {
		const series = stackedBarSeries(summary!);
		const bars = chartGeometry(series, { width: 680, height: 140, barWidth: 28 });
		const card = h(
			"div",
			{ class: "c-card" },
			h("div", { class: "c-card-title" }, "Cost per day"),
			h(
				"div",
				{ class: "cp-legend" },
				h("span", {}, h("span", { class: "cp-legend-dot", style: `background:${FILL_INPUT}` }), "input"),
				h("span", {}, h("span", { class: "cp-legend-dot", style: `background:${FILL_OUTPUT}` }), "output"),
				h("span", {}, h("span", { class: "cp-legend-dot", style: `background:${FILL_CACHE}` }), "cache R/W"),
			),
		);
		const wrap = h("div", { class: "cp-chart-wrap" });
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 680 140");
		svg.setAttribute("preserveAspectRatio", "none");
		svg.setAttribute("class", "cp-chart-svg");
		for (const bar of bars) {
			for (const rect of bar.rects) {
				if (rect.h <= 0) continue;
				const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
				el.setAttribute("x", String(rect.x));
				el.setAttribute("y", String(rect.y));
				el.setAttribute("width", String(rect.w));
				el.setAttribute("height", String(rect.h));
				el.setAttribute("rx", "2");
				el.setAttribute("fill", rect.fill);
				const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
				title.textContent = `${bar.day} · ${bar.costLabel}`;
				el.appendChild(title);
				svg.appendChild(el);
			}
		}
		wrap.appendChild(svg);
		card.appendChild(wrap);
		if (bars.length > 0) {
			const labels = h("div", { class: "cp-stat-sub" });
			for (const bar of bars) {
				labels.appendChild(h("span", { class: "cp-secondary" }, `${bar.label} `));
			}
			card.appendChild(labels);
		}
		return card;
	}

	function renderModelsCard(): HTMLElement {
		const card = h("div", { class: "c-card" }, h("div", { class: "c-card-title" }, "By model"));
		const rows = modelRows(summary!);
		if (rows.length === 0) {
			card.appendChild(h("div", { class: "cp-muted" }, "No models used in this range."));
			return card;
		}
		for (const row of rows) {
			const head = h(
				"div",
				{ class: "cp-model-head" },
				h("span", { class: "cp-model-name", title: row.model }, modelShortName({ id: row.model })),
				h("span", { class: "cp-model-meta" }, `${row.costText} · ${row.tokensText}`),
			);
			card.appendChild(h("div", { class: "cp-model-row" }, head, progressEl(row.pctBar, 250).el));
		}
		return card;
	}

	let sessionsRows: UsageSessionRow[] = [];
	let sessionsHost: HTMLElement | undefined;

	/** Re-render just the sessions table after a filter select change. */
	function renderSessionsColumn(): void {
		if (!sessionsHost || !summary) return;
		sessionsHost.replaceChildren(renderSessionsTable());
	}

	function renderSessionsTable(): HTMLElement {
		const table = h("table", { class: "cp-table" });
		const headRow = h("tr", {});
		for (const label of ["SESSION", "PROJECT", "MODEL", "TOKENS", "COST", "LAST ACTIVE"]) {
			headRow.appendChild(h("th", {}, label));
		}
		table.appendChild(h("thead", {}, headRow));
		const tbody = h("tbody", {});
		for (const row of sessionsRows) {
			const tr = h("tr", {});
			tr.append(
				h("td", {}, cellName(row)),
				h("td", { class: "mono cp-secondary", title: row.cwd }, row.cwd),
				h("td", { class: "mono", title: row.model }, modelShortName({ id: row.model })),
				h("td", { class: "mono" }, rowTokensText(row)),
				h("td", { class: "mono" }, formatCost(row.cost)),
				h("td", { class: "cp-secondary" }, shortWhen(row.modified)),
			);
			tr.addEventListener("click", () => deps.openSession(row.file || row.id));
			tbody.appendChild(tr);
		}
		if (sessionsRows.length === 0) {
			tbody.appendChild(
				h("tr", {}, h("td", { colspan: "6", class: "cp-muted" }, "No sessions match the current filters.")),
			);
		}
		table.appendChild(tbody);
		return table;
	}

	function rowTokensText(row: UsageSessionRow): string {
		return `↑${formatTokens(row.input)} ↓${formatTokens(row.output)}`;
	}

	function renderSessionsCard(): HTMLElement {
		const stats = usageStatCards(summary!, null);
		sessionsRows = applyFilters(summary!.sessions.slice(), { model: modelFilter, project: projectFilter });
		const card = h(
			"div",
			{ class: "c-card" },
			h("div", { class: "c-card-title" }, "Sessions"),
			h(
				"span",
				{},
				chipEl(summary!.totals.sessions > 0 ? `${sessionsRows.length} in view` : "no sessions", {
					mono: true,
				}),
			),
		);
		sessionsHost = h("div", {});
		sessionsHost.appendChild(renderSessionsTable());
		card.appendChild(sessionsHost);
		const totals = summary!.totals;
		card.appendChild(
			h(
				"div",
				{ class: "cp-totals" },
				`Totals — ${totals.sessions} sessions · ${stats.cost} · ↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)} · cache hit ${stats.hitPct ?? "—"}%`,
			),
		);
		return card;
	}

	function render(): void {
		clearElement(bodyHost);
		if (lastError) {
			bodyHost.appendChild(
				h(
					"div",
					{ class: "c-card" },
					h("div", { class: "c-card-title" }, "Usage unavailable"),
					h("div", { class: "cp-muted" }, lastError),
					h("div", {}, h("button", { class: "c-btn", onclick: () => void load() }, "Retry")),
				),
			);
			return;
		}
		if (!summary) {
			bodyHost.appendChild(h("div", { class: "c-card" }, h("div", { class: "cp-muted" }, "Loading usage…")));
			return;
		}
		if (summary.totals.sessions === 0 && summary.sessions.length === 0) {
			bodyHost.appendChild(
				h(
					"div",
					{ class: "c-card" },
					h("div", { class: "c-card-title" }, "Usage"),
					h("div", { class: "cp-muted" }, "No usage in this range."),
					h("div", {}, chipEl("Open chat →", { tone: "accent", onClick: () => deps.onNavigate("chat") })),
				),
			);
			return;
		}
		bodyHost.appendChild(renderFilters());
		bodyHost.appendChild(renderStatCards());
		bodyHost.appendChild(h("div", { class: "cp-usage-grid2" }, renderChartCard(), renderModelsCard()));
		bodyHost.appendChild(renderSessionsCard());
	}

	return {
		id: "usage",
		title: "Usage",
		element,
		mount(): void {
			mounted = true;
			window.addEventListener("focus", focusRefetch);
			void load();
		},
		unmount(): void {
			generation++;
			mounted = false;
			window.removeEventListener("focus", focusRefetch);
		},
	};
}
