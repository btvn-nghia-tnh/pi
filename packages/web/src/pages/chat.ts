/**
 * Chat workbench page (spec §3.1/§3.2): session sidebar | transcript + control
 * dock + status bar | right session panel. The page owns only markup + hosts —
 * app.ts builds and binds the per-session views into the exposed hosts
 * (SessionPanel/StatusBarView/EditorToolbar included: they subscribe to the
 * ACTIVE session store, so app.rebuildSessionViews rebinds them together with
 * the transcript/status rows/queue). The app-level file preview column sits
 * between the main column and the right panel.
 */
import { iconEl } from "../components/kit.ts";
import { makePanelResizer, readStoredPanelWidth } from "../components/panel-resizer.ts";
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
	const isDesktopMedia = (): boolean => !window.matchMedia("(max-width: 767px)").matches;
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

	// Mobile drawer (spec §3.7): the sidebar column slides off-canvas below
	// 768px; a header hamburger toggles `drawer-open` on the page root and a
	// scrim closes it. The matchMedia gate keeps desktop clicks inert.
	const mobile = window.matchMedia("(max-width: 767px)");
	let drawerOpen = false;
	let drawerButton: HTMLButtonElement;
	const applyDrawer = (): void => {
		pageRoot.classList.toggle("drawer-open", drawerOpen);
		scrim.classList.toggle("is-open", drawerOpen);
		drawerButton.setAttribute("aria-expanded", String(drawerOpen));
	};
	drawerButton = h(
		"button",
		{
			class: "c-drawer-toggle",
			title: "Sessions",
			"aria-label": "Toggle sessions drawer",
			"aria-expanded": "false",
			onclick: () => {
				if (!mobile.matches) return;
				drawerOpen = !drawerOpen;
				applyDrawer();
			},
		},
		iconEl("chat"),
	) as HTMLButtonElement;
	const scrim = h("div", { class: "c-scrim", "aria-hidden": "true" });
	scrim.addEventListener("click", () => {
		drawerOpen = false;
		applyDrawer();
	});
	// Page header + main column.
	const header = h("div", { class: "c-page-header" }, drawerButton, h("span", { class: "c-page-title" }, "Chat"));
	const main = h("div", { class: "chat-main" }, header, transcriptWrap, dock, statusBarHost);

	// Left column: the app-owned sidebar (its own styles, stretched to fill).
	const sidebarHost = h("aside", { class: "chat-sidebar" });
	// Horizontal resizer (batch-4: unified on the shared panel-resizer module):
	// drives --chat-sidebar-w, persisted. The handle mounts inside the host it
	// resizes; the onWidth closure evaluates after `pageRoot` is created.
	const sidebarResizer = makePanelResizer({
		onWidth: (px) => pageRoot.style.setProperty("--chat-sidebar-w", `${px}px`),
		min: 200,
		max: 480,
		storageKey: "pi-web-sidebar-w",
		dragOn: () => isDesktopMedia(),
	});
	sidebarHost.appendChild(sidebarResizer.el);
	const sidebar = deps.sidebar();
	if (sidebar) sidebarHost.appendChild(sidebar.element);
	// Tapping a session row (inside the sidebar groups host) closes the drawer.
	sidebarHost.addEventListener("click", (event) => {
		if (drawerOpen && (event.target as HTMLElement).closest(".sidebar-groups")) {
			drawerOpen = false;
			applyDrawer();
		}
	});

	// Right column: widget cards only (is-empty hides the whole column until
	// a structured widget registers — SessionPanel flips the class). The
	// column owns a persisted collapse toggle (issue-batch): a thin vertical
	// tab on the panel's left edge; collapsed parks the panel off and keeps
	// the tab to restore (spec block: `.chat-right.is-collapsed{display:none}`).
	const RIGHT_COLLAPSE_KEY = "pi-web-right-collapsed";
	const rightCollapsed = window.localStorage.getItem(RIGHT_COLLAPSE_KEY) === "1";
	const right = h("aside", { class: `chat-right is-empty${rightCollapsed ? " is-collapsed" : ""}` }, panelHost);
	const applyRightCollapsed = (collapsed: boolean, persist = true): void => {
		right.classList.toggle("is-collapsed", collapsed);
		rightToggle.textContent = collapsed ? "‹" : "›";
		rightToggle.title = collapsed ? "Show panel" : "Hide panel";
		rightToggle.setAttribute("aria-expanded", String(!collapsed));
		if (persist) window.localStorage.setItem(RIGHT_COLLAPSE_KEY, collapsed ? "1" : "0");
	};
	const rightToggle = h(
		"button",
		{
			class: "chat-right-toggle",
			"aria-label": "Toggle right panel",
			"aria-expanded": String(!rightCollapsed),
			title: rightCollapsed ? "Show panel" : "Hide panel",
		},
		rightCollapsed ? "‹" : "›",
	) as HTMLButtonElement;
	rightToggle.addEventListener("click", () => {
		applyRightCollapsed(!right.classList.contains("is-collapsed"));
	});
	applyRightCollapsed(rightCollapsed, false);
	// The toggle tab stays outside the collapsible panel so it survives
	// display:none — the host carries the is-panel-empty flag (set by
	// SessionPanel) that hides the tab while the column is empty anyway.
	const rightHost = h("div", { class: "chat-right-host" }, rightToggle, right);
	// Drag-resize for the right column (batch-4 B7): the handle rides the
	// panel's LEFT edge and drives --chat-right-w (persisted, 260–560px).
	// The drag gate mirrors the CSS: under 1280px the column is hidden and a
	// collapsed panel has no visible edge to grab.
	const rightResizer = makePanelResizer({
		side: "right",
		onWidth: (px) => pageRoot.style.setProperty("--chat-right-w", `${px}px`),
		min: 260,
		max: 560,
		storageKey: "pi-web-right-w",
		// .chat-right clips via overflow-y:auto — keep the nub fully inside.
		edgeOffset: "0px",
		dragOn: () => window.matchMedia("(min-width: 1280px)").matches && !right.classList.contains("is-collapsed"),
	});
	right.appendChild(rightResizer.el);

	// `chat-console` scopes the Task-14 restyle layer (pages.css) to the chat page.
	const pageRoot = h(
		"section",
		{ class: "c-page chat-page chat-console", "aria-label": "Chat" },
		sidebarHost,
		main,
		scrim,
	);
	// Persisted panel widths (the resizers keep these fresh in localStorage —
	// batch-4 B7 adds the right column alongside the sidebar).
	const storedSidebarWidth = readStoredPanelWidth("pi-web-sidebar-w", 200, 480);
	if (storedSidebarWidth !== undefined) pageRoot.style.setProperty("--chat-sidebar-w", `${storedSidebarWidth}px`);
	const storedRightWidth = readStoredPanelWidth("pi-web-right-w", 260, 560);
	if (storedRightWidth !== undefined) pageRoot.style.setProperty("--chat-right-w", `${storedRightWidth}px`);

	// The preview column is a flex sibling of chat-main (opens/closes itself
	// via .is-open; existing CSS sizes it 320-640px).
	const preview = deps.previewElement();
	if (preview) pageRoot.appendChild(preview);
	pageRoot.appendChild(rightHost);

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
			// column (idempotent across page remounts). Resizers detach in
			// unmount (destroy keeps their listeners attached) — re-append here
			// restores the live handle on every remount.
			const current = deps.sidebar();
			if (current && current.element.parentElement !== sidebarHost) {
				sidebarHost.replaceChildren(current.element, sidebarResizer.el);
			} else if (sidebarResizer.el.parentElement !== sidebarHost) {
				sidebarHost.appendChild(sidebarResizer.el);
			}
			if (rightResizer.el.parentElement !== right) right.appendChild(rightResizer.el);
			document.addEventListener("keydown", onKeydown);
		},
		unmount(): void {
			document.removeEventListener("keydown", onKeydown);
			sidebarResizer.destroy();
			rightResizer.destroy();
		},
	};
	return page;
}
