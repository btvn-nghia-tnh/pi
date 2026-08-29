/**
 * Minimal DOM helpers. Components are functions that build HTMLElement trees.
 */

export type Child = Node | string | null | undefined | false;

export function h(
	tag: string,
	attrs?: Record<string, string | number | boolean | EventListenerOrEventListenerObject | undefined | null> | null,
	...children: Child[]
): HTMLElement {
	const element = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) continue;
			if (key.startsWith("on") && typeof value === "function") {
				const eventName = key.slice(2).toLowerCase();
				const handler = value as EventListener;
				element.addEventListener(eventName, handler);
			} else if (value === true) {
				element.setAttribute(key, "");
			} else {
				element.setAttribute(key, String(value));
			}
		}
	}
	appendChildren(element, children);
	return element;
}

export function appendChildren(element: HTMLElement, children: Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		if (typeof child === "string") {
			element.appendChild(document.createTextNode(child));
		} else {
			element.appendChild(child);
		}
	}
}

export function clearElement(element: HTMLElement): void {
	while (element.firstChild) {
		element.removeChild(element.firstChild);
	}
}

export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Render an HTML fragment into a detached element (used by tests and helpers). */
export function fragmentToHtml(element: HTMLElement): string {
	return element.innerHTML;
}
