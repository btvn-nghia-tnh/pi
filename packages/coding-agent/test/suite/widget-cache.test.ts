import { describe, expect, it } from "vitest";
import { applyExtensionUiMessage, createWidgetCache } from "../../src/modes/web/widget-cache.ts";

const widgetRequest = (method: string, fields: Record<string, unknown>): object => ({
	type: "extension_ui_request",
	id: "test",
	method,
	...fields,
});

describe("widget cache", () => {
	it("ignores non-extension and non-widget messages", () => {
		const cache = createWidgetCache();
		applyExtensionUiMessage(cache, { type: "message_end" });
		applyExtensionUiMessage(cache, { type: "extension_ui_request", method: "notify", message: "hi" });
		expect(cache.widgets.size).toBe(0);
		expect(cache.statuses.size).toBe(0);
	});

	it("caches setWidget lines and setWidgetData payloads", () => {
		const cache = createWidgetCache();
		applyExtensionUiMessage(cache, widgetRequest("setWidget", { widgetKey: "todo", widgetLines: ["a", "b"] }));
		applyExtensionUiMessage(
			cache,
			widgetRequest("setWidgetData", { widgetKey: "ask", widgetData: { kind: "x", display: "overlay" } }),
		);
		expect(cache.widgets.get("todo")).toEqual({ lines: ["a", "b"], placement: "aboveEditor" });
		expect(cache.widgets.get("ask")).toEqual({
			lines: [],
			placement: "aboveEditor",
			data: { kind: "x", display: "overlay" },
		});
	});

	it("setWidget clear deletes the entry; setWidgetData clear keeps fallback lines", () => {
		const cache = createWidgetCache();
		applyExtensionUiMessage(cache, widgetRequest("setWidget", { widgetKey: "todo", widgetLines: ["a"] }));
		applyExtensionUiMessage(
			cache,
			widgetRequest("setWidgetData", { widgetKey: "todo", widgetData: { kind: "todo" } }),
		);
		applyExtensionUiMessage(cache, widgetRequest("setWidgetData", { widgetKey: "todo", widgetData: undefined }));
		// Lines survive a payload clear — the plain-text fallback still renders.
		expect(cache.widgets.get("todo")).toEqual({ lines: ["a"], placement: "aboveEditor", data: undefined });
		applyExtensionUiMessage(cache, widgetRequest("setWidget", { widgetKey: "todo", widgetLines: undefined }));
		expect(cache.widgets.has("todo")).toBe(false);
	});

	it("clearing a payload-only widget removes the entry entirely (no ghost box)", () => {
		const cache = createWidgetCache();
		// A questionnaire overlay: registered via setWidgetData only.
		applyExtensionUiMessage(
			cache,
			widgetRequest("setWidgetData", { widgetKey: "ask", widgetData: { kind: "ask", display: "overlay" } }),
		);
		expect(cache.widgets.has("ask")).toBe(true);
		// Tool call settles — extension clears the widget.
		applyExtensionUiMessage(cache, widgetRequest("setWidgetData", { widgetKey: "ask", widgetData: undefined }));
		expect(cache.widgets.has("ask")).toBe(false);
	});

	it("setWidgetData after a clear re-registers with the same defaults", () => {
		const cache = createWidgetCache();
		applyExtensionUiMessage(cache, widgetRequest("setWidgetData", { widgetKey: "k", widgetData: { a: 1 } }));
		applyExtensionUiMessage(cache, widgetRequest("setWidgetData", { widgetKey: "k", widgetData: undefined }));
		applyExtensionUiMessage(cache, widgetRequest("setWidgetData", { widgetKey: "k", widgetData: { b: 2 } }));
		expect(cache.widgets.get("k")).toEqual({ lines: [], placement: "aboveEditor", data: { b: 2 } });
	});

	it("tracks statuses and deletes on empty or undefined text", () => {
		const cache = createWidgetCache();
		applyExtensionUiMessage(cache, widgetRequest("setStatus", { statusKey: "mcp", statusText: "2 servers" }));
		expect(cache.statuses.get("mcp")).toBe("2 servers");
		applyExtensionUiMessage(cache, widgetRequest("setStatus", { statusKey: "mcp", statusText: undefined }));
		expect(cache.statuses.has("mcp")).toBe(false);
		applyExtensionUiMessage(cache, widgetRequest("setStatus", { statusKey: "mcp", statusText: "back" }));
		applyExtensionUiMessage(cache, widgetRequest("setStatus", { statusKey: "mcp", statusText: "" }));
		expect(cache.statuses.has("mcp")).toBe(false);
	});
});
