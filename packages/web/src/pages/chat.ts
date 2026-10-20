/**
 * Chat workbench page (spec §3.1/§3.2): session sidebar | transcript + control
 * dock + status bar | right session panel. The page owns only markup + hosts —
 * app.ts builds and binds the per-session views into the exposed hosts
 * (SessionPanel/StatusBarView/EditorToolbar included: they subscribe to the
 * ACTIVE session store, so app.rebuildSessionViews rebinds them together with
 * the transcript/status rows/queue). The app-level file preview column sits
 * between the main column and the right panel.
 */
import { h } from "../dom.ts";
import type { SidebarView } from "../render/sidebar.ts";
import type { ShellPage } from "../shell.ts";

/** Hosts the app binds per-session and page-scoped views into. */
export interface ChatHosts {
	/** Scrolling transcript container (.transcript-wrap for scroll pinning). */
	transcriptWrap: HTMLElement;
	/** Per-session transcript content (old header + transcript list). */
	transcriptHost: HTMLElement;
	statusRowsHost: HTMLElement;
	queueHost: HTMLElement;
	widgetsAboveHost: HTMLElement;
	askHost: HTMLElement;
	editorHost: HTMLElement;
	widgetsBelowHost: HTMLElement;
	toolbarHost: HTMLElement;
	statusBarHost: HTMLElement;
	panelHost: HTMLElement;
}

/** What the chat page itself needs from the app (markup-level contract). */
export interface ChatAppDeps {
	/** Multi-session sidebar; hosted into the left column when present. */
	sidebar(): SidebarView | undefined;
	/** App-owned file preview panel element; slotted beside the right panel. */
	previewElement(): HTMLElement | undefined;
	/** Ctrl+K: open the model picker anchored at the toolbar's model chip. */
	openModelPicker(): void;
}

/** A chat ShellPage that also exposes its bind hosts to the app. */
export interface ChatPage extends ShellPage {
	readonly hosts: ChatHosts;
}

export function createChatPage(deps: ChatAppDeps): ChatPage {
	const transcriptWrap = h("div", { class: "chat-transcript transcript-wrap" });
	const transcriptHost = h("div", { class: "transcript-host" });
	transcriptWrap.appendChild(transcriptHost);

	const statusRowsHost = h("div", {});
	const queueHost = h("div", {});
	const widgetsAboveHost = h("div", {});
	const askHost = h("div", { class: "inline-asks" });
	const editorHost = h("div", {});
	const widgetsBelowHost = h("div", {});
	const toolbarHost = h("div", {});
	const statusBarHost = h("div", {});
	const panelHost = h("div", {});

	const hosts: ChatHosts = {
		transcriptWrap,
		transcriptHost,
		statusRowsHost,
		queueHost,
		widgetsAboveHost,
		askHost,
		editorHost,
		widgetsBelowHost,
		toolbarHost,
		statusBarHost,
		panelHost,
	};

	// Dock column: banners → widgets → ask cards → editor → toolbar → widgets.
	const editorInner = h(
		"div",
		{ class: "editor-inner" },
		statusRowsHost,
		queueHost,
		widgetsAboveHost,
		askHost,
		editorHost,
		toolbarHost,
		widgetsBelowHost,
	);
	const dock = h("div", { class: "chat-dock" }, editorInner);

	// Page header + main column.
	const header = h("div", { class: "c-page-header" }, h("span", { class: "c-page-title" }, "Chat"));
	const main = h("div", { class: "chat-main" }, header, transcriptWrap, dock, statusBarHost);

	// Left column: the app-owned sidebar (its own styles, stretched to fill).
	const sidebarHost = h("aside", { class: "chat-sidebar" });
	const sidebar = deps.sidebar();
	if (sidebar) sidebarHost.appendChild(sidebar.element);

	// Right column: session panel host.
	const right = h("aside", { class: "chat-right" }, panelHost);

	// `chat-console` scopes the Task-14 restyle layer (pages.css) to the chat page.
	const pageRoot = h("section", { class: "c-page chat-page chat-console" }, sidebarHost, main);

	// The preview column is a flex sibling of chat-main (opens/closes itself
	// via .is-open; existing CSS sizes it 320-640px).
	const preview = deps.previewElement();
	if (preview) pageRoot.appendChild(preview);
	pageRoot.appendChild(right);

	// Ctrl+K / ⌘K opens the model picker anchored at the toolbar's model chip.
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.defaultPrevented) return;
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== "k") return;
		event.preventDefault();
		deps.openModelPicker();
	};

	const page: ChatPage = {
		id: "chat",
		title: "Chat",
		element: pageRoot,
		hosts,
		mount(): void {
			// The sidebar is app-owned; mount it when it first lands in the
			// column (idempotent across page remounts).
			const current = deps.sidebar();
			if (current && current.element.parentElement !== sidebarHost) {
				sidebarHost.replaceChildren(current.element);
			}
			document.addEventListener("keydown", onKeydown);
		},
		unmount(): void {
			document.removeEventListener("keydown", onKeydown);
		},
	};
	return page;
}
