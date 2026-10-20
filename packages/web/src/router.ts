/** Hash router: #/page/<arg>?section — deep links drive the console. */

export type PageId = "home" | "chat" | "projects" | "mcp" | "usage" | "settings";

export interface Route {
	page: PageId;
	/** Chat: active session id. */
	sessionId?: string;
	/** Settings: section slug. */
	section?: string;
	/** Projects: project cwd. */
	pathArg?: string;
}

const PAGES: readonly PageId[] = ["home", "chat", "projects", "mcp", "usage", "settings"];

export function parseRoute(hash: string): Route {
	const path = hash.replace(/^#\/?/, "").replace(/\?.*$/, "");
	const [head, ...rest] = path.split("/");
	if (!PAGES.includes(head as PageId)) return { page: "home" };
	const page = head as PageId;
	const arg = rest.length > 0 ? rest.map(decodeURIComponent).join("/") : undefined;
	switch (page) {
		case "chat":
			return arg ? { page, sessionId: arg } : { page };
		case "projects":
			return arg ? { page, pathArg: arg } : { page };
		case "settings":
			return { page, section: arg || "general" };
		default:
			return { page };
	}
}

export function routeToHash(route: Route): string {
	switch (route.page) {
		case "chat":
			return route.sessionId ? `#/chat/${encodeURIComponent(route.sessionId)}` : "#/chat";
		case "projects":
			return route.pathArg ? `#/projects/${encodeURIComponent(route.pathArg)}` : "#/projects";
		case "settings":
			return `#/settings/${route.section ?? "general"}`;
		default:
			return `#/${route.page}`;
	}
}

export class Router {
	private listener: (() => void) | undefined;
	private readonly onRoute: (route: Route) => void;

	constructor(onRoute: (route: Route) => void) {
		this.onRoute = onRoute;
	}

	start(): void {
		const handler = () => this.onRoute(parseRoute(window.location.hash));
		window.addEventListener("hashchange", handler);
		this.listener = () => window.removeEventListener("hashchange", handler);
		handler();
	}

	stop(): void {
		this.listener?.();
		this.listener = undefined;
	}

	navigate(route: Route, replace = false): void {
		const hash = routeToHash(route);
		if (window.location.hash === hash) return;
		if (replace) {
			window.history.replaceState(null, "", hash);
			this.onRoute(parseRoute(hash));
		} else {
			window.location.hash = hash;
		}
	}

	current(): Route {
		return parseRoute(window.location.hash);
	}
}
