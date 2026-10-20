/** Leaf component factories: no state, no store subscriptions. */
import { h } from "../dom.ts";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "blue";

export function progressTone(pct: number): "ok" | "warn" | "danger" {
	if (pct > 90) return "danger";
	if (pct > 70) return "warn";
	return "ok";
}

export function barPoints(values: number[], width: number, height: number): string {
	if (values.length === 1) return `0,${height - values[0]! * height}`;
	const step = width / (values.length - 1);
	return values.map((v, i) => `${i * step},${height - Math.max(0, Math.min(1, v)) * height}`).join(" ");
}

type ChipOpts = {
	tone?: Tone;
	mono?: boolean;
	icon?: IconName;
	onClick?: () => void;
	title?: string;
};

export function chipEl(label: string, opts: ChipOpts = {}): HTMLElement {
	const tone = opts.tone ?? "neutral";
	const el = h("span", {
		class: `c-chip c-chip--${tone}${opts.mono ? " c-chip--mono" : ""}`,
		title: opts.title,
		onclick: opts.onClick,
	});
	el.textContent = label;
	if (opts.icon) el.prepend(iconEl(opts.icon));
	return el;
}

export function pillEl(text: string, tone: "ok" | "warn" | "danger" | "accent" | "neutral" = "neutral"): HTMLElement {
	const pill = h("span", { class: `c-pill c-pill--${tone}` }, h("span", { class: "c-pill-dot" }), text);
	return pill;
}

export function toggleEl(on: boolean, onChange: (next: boolean) => void): HTMLElement {
	const el = h("span", { class: `c-toggle${on ? " is-on" : ""}`, role: "switch", "data-on": String(on) });
	el.addEventListener("click", () => {
		const next = el.dataset.on !== "true";
		el.dataset.on = String(next);
		el.classList.toggle("is-on", next);
		onChange(next);
	});
	return el;
}

export interface ProgressHandle {
	el: HTMLElement;
	update(pct: number): void;
}

export function progressEl(pct: number, width = 220): ProgressHandle {
	const bar = h("span", { class: "c-bar-track" }, h("span", { class: "c-bar-fill" }));
	const root = h("span", { class: `c-progress tone-${progressTone(pct)}`, style: `width:${width}px` }, bar);
	const update = (next: number): void => {
		const clamped = Math.max(0, Math.min(100, next));
		root.className = `c-progress tone-${progressTone(clamped)}`;
		const fill = root.querySelector<HTMLElement>(".c-bar-fill");
		if (fill) fill.style.width = `${clamped}%`;
	};
	update(pct);
	return { el: root, update };
}

export function sparklineEl(values: number[], width: number, height: number): SVGElement {
	const pts = barPoints(values, width, height);
	const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
	path.setAttribute("points", pts);
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "1.6");
	path.setAttribute("class", "c-spark");
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("class", "c-spark-svg");
	svg.appendChild(path);
	return svg;
}

export type IconName =
	| "home"
	| "chat"
	| "folder"
	| "mcp"
	| "usage"
	| "gear"
	| "search"
	| "more"
	| "send"
	| "stop"
	| "plus"
	| "close"
	| "check"
	| "attach"
	| "branch"
	| "chev"
	| "arrowr"
	| "file"
	| "key"
	| "refresh"
	| "logo";

const ICON_PATHS: Record<
	"home" | "chat" | "send" | "stop" | "folder" | "check" | "chev" | "arrowr" | "attach" | "file" | "refresh",
	string
> = {
	home: "M2 7.4 L8 2.2 L14 7.4 V13.8 H9.4 V9.6 H6.6 V13.8 H2 Z",
	chat: "M4.6 11.2 L4.6 14.6 L7.8 11.6 H13.6 a1 1 0 0 0 1-1 V4 a1 1 0 0 0-1-1 H2.8 a1 1 0 0 0-1 1 v6.4 a1 1 0 0 0 1 1 Z",
	send: "M2.0 7.4 L13.8 2.4 L9.4 13.8 L7.6 8.2 Z",
	stop: "M3.4 3.4 h9.2 a2.2 2.2 0 0 1 2.2 2.2 v9.2 a2.2 2.2 0 0 1-2.2 2.2 h-9.2 a2.2 2.2 0 0 1-2.2-2.2 v-9.2 a2.2 2.2 0 0 1 2.2-2.2 Z",
	folder: "M1.8 12.8 V4.6 H5.6 L7.2 6.4 H14.2 V12.8 Z",
	check: "M2.6 8.4 L6.2 12 L13.4 3.6",
	attach: "M9.2 6.4 L5.4 10.2 A2.6 2.6 0 0 0 9.1 13.9 L12.9 10.1 A4.4 4.4 0 0 0 6.7 3.9 L3.2 7.4",
	chev: "M6 3.5 L10.5 8 L6 12.5",
	arrowr: "M3 8 H12.6 M9 4.4 L12.6 8 L9 11.6",
	file: "M3.4 1.8 H10 L12.8 4.6 V14.2 H3.4 Z M9.8 1.9 V4.8 H12.7",
	refresh: "M13.2 8 A5.2 5.2 0 1 1 9.6 3.0 M9.4 0.6 L12.6 3.0 L9.4 5.6",
};

export function iconEl(name: IconName): SVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("class", `c-icon c-icon--${name}`);
	const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
	g.setAttribute("stroke", "currentColor");
	g.setAttribute("fill", "none");
	g.setAttribute("stroke-width", "1.6");
	g.setAttribute("stroke-linecap", "round");
	g.setAttribute("stroke-linejoin", "round");
	svg.appendChild(g);
	const mk = (tag: string, attrs: Record<string, string> = {}): SVGElement => {
		const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		g.appendChild(el);
		return el;
	};
	const fillPath = (d: string): void => {
		const p = mk("path", { d });
		p.setAttribute("fill", "currentColor");
		p.setAttribute("stroke", "none");
	};
	const strokedPath = (d: string): void => {
		mk("path", { d });
	};
	const dot = (cx: number, cy: number): void => {
		const c = mk("circle", { cx: String(cx), cy: String(cy), r: "1.9" });
		c.setAttribute("fill", "currentColor");
		c.setAttribute("stroke", "none");
	};
	switch (name) {
		case "home":
		case "chat":
		case "send":
		case "stop":
			fillPath(ICON_PATHS[name]);
			break;
		case "folder":
		case "check":
		case "chev":
		case "arrowr":
		case "attach":
		case "file":
		case "refresh":
			strokedPath(ICON_PATHS[name]);
			break;
		case "mcp":
			dot(3.1, 12.2);
			dot(12.9, 12.2);
			dot(8, 3.8);
			strokedPath("M6.6 5.1 L4.3 10.1 M9.4 5.1 L11.7 10.1 M5.1 12.2 H10.9");
			break;
		case "usage": {
			for (const [x, y, barHeight, opacity] of [
				[2, 8.6, 5.4, "0.55"],
				[6.4, 5.6, 8.4, "0.8"],
				[10.8, 2.6, 11.4, "1"],
			] as const) {
				const r = mk("rect", {
					x: String(x),
					y: String(y),
					width: "3.1",
					height: String(barHeight),
					rx: "0.8",
					opacity,
				});
				r.setAttribute("fill", "currentColor");
				r.setAttribute("stroke", "none");
			}
			break;
		}
		case "gear":
			mk("circle", { cx: "8", cy: "8", r: "2.5" });
			for (const [dx, dy] of [
				[0, -1],
				[0, 1],
				[-1, 0],
				[1, 0],
				[-0.72, -0.72],
				[0.72, -0.72],
				[-0.72, 0.72],
				[0.72, 0.72],
			]) {
				mk("line", {
					x1: String(8 + dx * 2.4),
					y1: String(8 + dy * 2.4),
					x2: String(8 + dx * 5.4),
					y2: String(8 + dy * 5.4),
				});
			}
			break;
		case "search":
			mk("circle", { cx: "7", cy: "7", r: "4.4" });
			mk("line", { x1: "10.4", y1: "10.4", x2: "13.8", y2: "13.8" });
			break;
		case "more":
			dot(3, 8);
			dot(8, 8);
			dot(13, 8);
			break;
		case "plus":
			mk("line", { x1: "8", y1: "2.6", x2: "8", y2: "13.4" });
			mk("line", { x1: "2.6", y1: "8", x2: "13.4", y2: "8" });
			break;
		case "close":
			mk("line", { x1: "3.2", y1: "3.2", x2: "12.8", y2: "12.8" });
			mk("line", { x1: "12.8", y1: "3.2", x2: "3.2", y2: "12.8" });
			break;
		case "branch":
			mk("circle", { cx: "4.5", cy: "3.5", r: "1.8" });
			mk("circle", { cx: "4.5", cy: "12.5", r: "1.8" });
			mk("circle", { cx: "11.5", cy: "3.5", r: "1.8" });
			mk("line", { x1: "4.5", y1: "5.3", x2: "4.5", y2: "10.7" });
			mk("line", { x1: "11.5", y1: "5.3", x2: "11.5", y2: "7.5" });
			mk("line", { x1: "11.5", y1: "7.5", x2: "4.5", y2: "7.5" });
			break;
		case "key":
			mk("circle", { cx: "5", cy: "11", r: "2.4" });
			mk("line", { x1: "6.8", y1: "9.2", x2: "11", y2: "5" });
			mk("line", { x1: "9.2", y1: "6.8", x2: "11.2", y2: "8.8" });
			mk("line", { x1: "11", y1: "5", x2: "13", y2: "7" });
			break;
		case "logo":
			mk("path", { d: "M8 11.5 L8 2.5 M3.5 6.5 Q8 1.5 12.5 6.5 M5.4 9 H10.6" });
			break;
	}
	return svg;
}
export function openAnchoredMenu(anchor: HTMLElement, build: (close: () => void) => HTMLElement): void {
	const host = document.createElement("div");
	host.className = "c-popover";
	const close = (): void => {
		host.remove();
		document.removeEventListener("pointerdown", onDown, true);
	};
	const onDown = (event: Event): void => {
		if (!host.contains(event.target as Node)) close();
	};
	document.addEventListener("pointerdown", onDown, true);
	host.appendChild(build(close));
	document.body.appendChild(host);
	const rect = anchor.getBoundingClientRect();
	host.style.left = `${Math.max(8, Math.min(window.innerWidth - host.offsetWidth - 8, rect.left))}px`;
	host.style.top = `${rect.bottom + 6}px`;
	host.tabIndex = -1;
	host.addEventListener("keydown", (event) => {
		if (event.key === "Escape") close();
	});
}
