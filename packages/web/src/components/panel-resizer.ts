/**
 * Reusable horizontal panel-resizer handle (issue batch 3).
 * Modeled on the chat page's sidebar resizer, generalized so any left/right
 * panel can drive a persisted px width through a CSS variable of its owner's
 * choosing. The handle must be appended INSIDE the panel it resizes; it
 * rides the panel's inner edge (right edge for side:"left", left edge for
 * side:"right" — batch-4 B7) and width is measured from the panel's fixed
 * far edge.
 */
import { h } from "../dom.ts";

export interface PanelResizerOpts {
	/** Called with the clamped width during drags and on boot restore. */
	onWidth(px: number): void;
	/** Minimum width in px (default 200). */
	min?: number;
	/** Maximum width in px (default 480). */
	max?: number;
	/** localStorage key for persistence; omit for session-only resizing. */
	storageKey?: string;
	/** Whether dragging is allowed right now (default: viewport >= 768px). */
	dragOn?(): boolean;
	/**
	 * Inline `right` offset for the handle. The shared CSS positions it at
	 * `-3px` (stylized overhang) — pass `"0px"` for panels that clip
	 * overflow horizontally (e.g. scrollable list columns).
	 */
	edgeOffset?: string;
	/**
	 * Which edge of the host panel the handle rides — "left" panels sit left
	 * (handle on their right edge), "right" panels sit right (handle on their
	 * left edge). Right mode mirrors the width math: the panel's far edge is
	 * fixed at the viewport side, so width = hostRect.right - pointerX
	 * (batch-4 B7: the chat right panel resizes toward the transcript).
	 * Default "left".
	 */
	side?: "left" | "right";
}

export interface PanelResizerHandle {
	readonly el: HTMLElement;
	/**
	 * Detaches the handle from the DOM while keeping its event listeners — the
	 * same handle can be re-appended later (pages unmount/remount across route
	 * switches and re-append this element). Review wave: the previous version
	 * removed the listeners here, which silently killed every resizer after the
	 * first page remount (chat sidebar + right panel both froze).
	 */
	destroy(): void;
}

/** Clamp a pointer-derived width to the panel's min/max (pure, R10-safe). */
export function clampPanelWidth(width: number, min: number, max: number): number {
	if (Number.isNaN(width)) return min;
	// Math.min/max clamp ±Infinity naturally; NaN alone needs the guard above.
	return Math.max(min, Math.min(max, Math.round(width)));
}

/** Read a persisted width, clamped; undefined when absent or unreadable. */
export function readStoredPanelWidth(key: string, min: number, max: number): number | undefined {
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === null) return undefined;
		const parsed = Number.parseFloat(raw);
		if (!Number.isFinite(parsed)) return undefined;
		return clampPanelWidth(parsed, min, max);
	} catch {
		// Storage unavailable (private mode / disabled) — caller falls back to
		// its CSS-var default (the `initial` option was dropped in the review
		// wave: makePanelResizer never used it, callers apply CSS defaults).
		return undefined;
	}
}

export function makePanelResizer(opts: PanelResizerOpts): PanelResizerHandle {
	const min = opts.min ?? 200;
	const max = opts.max ?? 480;
	const edgeOffset = opts.edgeOffset ?? "-3px";
	const side = opts.side ?? "left";
	const dragOn = opts.dragOn ?? (() => window.matchMedia("(min-width: 768px)").matches);

	// Left panels: handle on the right edge (`right`); right panels: handle on
	// the left edge. The explicit `right:auto` override matters in right mode —
	// `.chat-sidebar-resizer` CSS pins `right:-3px`, and inline `left` alone
	// would leave both edges applied (stretched element).
	const el = h("div", {
		class: "chat-sidebar-resizer",
		"aria-hidden": "true",
		style: side === "right" ? `left:${edgeOffset};right:auto` : `right:${edgeOffset}`,
	});
	let resizing = false;
	let originEdge = 0;

	const widthFromPointer = (clientX: number): number =>
		clampPanelWidth(side === "right" ? originEdge - clientX : clientX - originEdge, min, max);
	const persist = (width: number): void => {
		if (opts.storageKey === undefined) return;
		try {
			window.localStorage.setItem(opts.storageKey, String(width));
		} catch {
			// Best-effort persistence; the live resize still applies.
		}
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (!dragOn()) return;
		resizing = true;
		const host = el.parentElement;
		const rect = host ? host.getBoundingClientRect() : undefined;
		// Drag origin: the host's far edge — the fixed edge the width is measured
		// from (right mode anchors at the viewport side, growing leftward).
		originEdge = side === "right" ? (rect?.right ?? 0) : (rect?.left ?? 0);
		el.classList.add("is-dragging");
		el.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent): void => {
		if (!resizing) return;
		opts.onWidth(widthFromPointer(event.clientX));
	};
	const endResize = (event: PointerEvent): void => {
		if (!resizing) return;
		resizing = false;
		el.classList.remove("is-dragging");
		const width = widthFromPointer(event.clientX);
		opts.onWidth(width);
		persist(width);
	};

	el.addEventListener("pointerdown", onPointerDown as EventListener);
	el.addEventListener("pointermove", onPointerMove as EventListener);
	el.addEventListener("pointerup", endResize as EventListener);
	el.addEventListener("lostpointercapture", endResize as EventListener);

	return {
		el,
		destroy(): void {
			// Listeners stay attached: `el` is reusable across remounts (see the
			// PanelResizerHandle.destroy doc — removing them killed the handle
			// after the first remount).
			resizing = false;
			el.classList.remove("is-dragging");
			el.remove();
		},
	};
}
