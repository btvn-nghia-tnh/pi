/**
 * Server-side cache of the latest extension widget and status registrations.
 *
 * Widgets are fire-and-forget messages tied to session events
 * (tool_execution_end, session_start), so a browser connecting later would
 * otherwise miss them. The cache is replayed in the connected payload and
 * cleared when the underlying session changes (session_start of a new
 * session).
 *
 * Extracted from web-mode.ts as a pure reducer so the entry lifecycle —
 * including the ghost-box rule (a cleared payload leaves no empty entry) —
 * is unit-testable without a WebSocket server.
 */

export interface CachedWidget {
	lines?: string[];
	placement?: "aboveEditor" | "belowEditor";
	data?: Record<string, unknown>;
}

export interface WidgetCache {
	widgets: Map<string, CachedWidget>;
	statuses: Map<string, string>;
}

export function createWidgetCache(): WidgetCache {
	return { widgets: new Map(), statuses: new Map() };
}

/**
 * Fold one outbound extension UI request into the cache. Messages other
 * than setWidget/setWidgetData/setStatus are ignored.
 */
export function applyExtensionUiMessage(cache: WidgetCache, message: object): void {
	const request = message as {
		type?: string;
		method?: string;
		widgetKey?: string;
		widgetLines?: string[] | undefined;
		widgetPlacement?: "aboveEditor" | "belowEditor";
		widgetData?: Record<string, unknown> | undefined;
		statusKey?: string;
		statusText?: string | undefined;
	};
	if (request.type !== "extension_ui_request") return;
	if (request.method === "setWidget") {
		const key = request.widgetKey ?? "";
		if (request.widgetLines === undefined || request.widgetLines === null) {
			cache.widgets.delete(key);
		} else {
			const existing = cache.widgets.get(key) ?? {};
			cache.widgets.set(key, {
				...existing,
				lines: request.widgetLines,
				placement: request.widgetPlacement ?? existing.placement ?? "aboveEditor",
			});
		}
	} else if (request.method === "setWidgetData") {
		const key = request.widgetKey ?? "";
		if (request.widgetData === undefined || request.widgetData === null) {
			const existing = cache.widgets.get(key);
			if (existing) {
				// Clearing the payload drops the entry entirely unless the
				// plain-lines fallback still has content — a lingering
				// {lines: [], data: undefined} entry would replay to
				// clients as an empty ghost box above the editor.
				if (existing.lines !== undefined && existing.lines.length > 0) {
					cache.widgets.set(key, { ...existing, data: undefined });
				} else {
					cache.widgets.delete(key);
				}
			}
		} else {
			// Docked widgets and interactive overlays alike are cached and
			// replayed: overlays carry live state the extension owns (an open
			// panel, a pending questionnaire) — losing them on reload would
			// hang the tool call or drop the open panel.
			const existing = cache.widgets.get(key) ?? {};
			cache.widgets.set(key, {
				lines: existing.lines ?? [],
				placement: existing.placement ?? "aboveEditor",
				data: request.widgetData,
			});
		}
	} else if (request.method === "setStatus") {
		const key = request.statusKey ?? "";
		if (request.statusText === undefined || request.statusText === null || request.statusText === "") {
			cache.statuses.delete(key);
		} else {
			cache.statuses.set(key, request.statusText);
		}
	}
}
