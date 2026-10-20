/** App shell: icon rail + page host (spec §3.1). */
import { type IconName, iconEl } from "./components/kit.ts";
import { clearElement, h } from "./dom.ts";
import type { PageId } from "./router.ts";

export interface ShellPage {
	id: PageId;
	title: string;
	element: HTMLElement;
	mount(): void;
	unmount(): void;
}

const PAGE_ICONS: Record<PageId, IconName> = {
	home: "home",
	chat: "chat",
	projects: "folder",
	mcp: "mcp",
	usage: "usage",
	settings: "gear",
};

const PAGE_TITLES: Record<PageId, string> = {
	home: "Home",
	chat: "Chats",
	projects: "Projects",
	mcp: "MCP",
	usage: "Usage",
	settings: "Settings",
};

export interface ShellOpts {
	onNavigate: (page: PageId) => void;
}

export class AppShell {
	readonly element: HTMLElement;
	private readonly railButtons = new Map<PageId, HTMLButtonElement>();
	private readonly tabButtons = new Map<PageId, HTMLButtonElement>();
	private host!: HTMLElement;
	private readonly onNavigate: (page: PageId) => void;
	/** Currently mounted page; unmounted on the next setPage swap. */
	private mounted: ShellPage | undefined;

	constructor(opts: ShellOpts) {
		this.onNavigate = opts.onNavigate;
		this.element = h("div", { class: "c-shell" });
		const rail = h("nav", { class: "c-rail", "aria-label": "pages" });
		rail.appendChild(h("span", { class: "c-rail-logo" }, "π"));
		for (const page of Object.keys(PAGE_ICONS) as PageId[]) {
			const icon = iconEl(PAGE_ICONS[page]);
			const badge = h("span", { class: "c-rail-badge" }, "0");
			const button = h(
				"button",
				{ class: "c-rail-btn", title: page, onclick: () => this.onNavigate(page) },
				icon,
				badge,
			) as HTMLButtonElement;
			this.railButtons.set(page, button);
			rail.appendChild(button);
		}
		// Mobile tab bar (07-mobile.svg): rendered unconditionally, CSS hides it
		// on widths >= 768 where the icon rail owns navigation.
		const tabbar = h("nav", { class: "c-tabbar", "aria-label": "pages" });
		for (const page of Object.keys(PAGE_ICONS) as PageId[]) {
			const icon = iconEl(PAGE_ICONS[page]);
			const badge = h("span", { class: "c-tabbar-badge" }, "0");
			const label = h("span", { class: "c-tabbar-label" }, PAGE_TITLES[page]);
			const button = h(
				"button",
				{ class: "c-tabbar-btn", title: PAGE_TITLES[page], onclick: () => this.onNavigate(page) },
				icon,
				badge,
				label,
			) as HTMLButtonElement;
			this.tabButtons.set(page, button);
			tabbar.appendChild(button);
		}
		this.host = h("div", { class: "c-page-host" });
		this.element.append(rail, this.host, tabbar);
	}

	setActive(page: PageId): void {
		for (const [id, button] of this.railButtons) button.classList.toggle("is-active", id === page);
		for (const [id, button] of this.tabButtons) button.classList.toggle("is-active", id === page);
	}

	setRunningBadge(count: number): void {
		this.updateBadge(this.railButtons.get("chat"), count);
		this.updateBadge(this.tabButtons.get("chat"), count);
	}

	private updateBadge(button: HTMLButtonElement | undefined, count: number): void {
		if (!button) return;
		button.classList.toggle("has-running", count > 0);
		const badge = button.querySelector<HTMLElement>(".c-rail-badge, .c-tabbar-badge");
		if (badge) badge.textContent = count > 9 ? "9+" : String(count);
	}

	/** Swap the mounted page. Unmounts the previous ShellPage first. */
	setPage(page: ShellPage | undefined): void {
		if (this.mounted) this.mounted.unmount();
		clearElement(this.host);
		this.mounted = page;
		if (!page) return;
		this.host.appendChild(page.element);
		page.mount();
	}
}
