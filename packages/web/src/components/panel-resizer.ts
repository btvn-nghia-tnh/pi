/**
 * Reusable horizontal panel-resizer handle (issue batch 3).
 * Modeled on the chat page's sidebar resizer, generalized so any left/right
 * panel can drive a persisted px width through a CSS variable of its owner's
 * choosing. The handle must be appended INSIDE the panel it resizes: the
 * drag origin is the panel's left edge (handle rides its right edge).
 */
import { h } from "../dom.ts";

export interface PanelResizerOpts {
	/** Called with the clamped width during drags and on boot restore. */
	onWidth(px: number): void;
	/** Initial width in px used when nothing is stored. */
	initial: number;
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
}

export interface PanelResizerHandle {
	readonly el: HTMLElement;
	/** Cancels any in-flight drag, removes listeners + element. Call on unmount. */
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
		// Storage unavailable (private mode / disabled) — caller falls back to initial.
		return undefined;
	}
}

export function makePanelResizer(opts: PanelResizerOpts): PanelResizerHandle {
	const min = opts.min ?? 200;
	const max = opts.max ?? 480;
	const edgeOffset = opts.edgeOffset ?? "-3px";
	const dragOn = opts.dragOn ?? (() => window.matchMedia("(min-width: 768px)").matches);

	const el = h("div", { class: "chat-sidebar-resizer", "aria-hidden": "true", style: `right:${edgeOffset}` });
	let resizing = false;
	let originLeft = 0;

	const widthFromPointer = (clientX: number): number => clampPanelWidth(clientX - originLeft, min, max);
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
		originLeft = host ? host.getBoundingClientRect().left : 0;
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
			resizing = false;
			el.removeEventListener("pointerdown", onPointerDown as EventListener);
			el.removeEventListener("pointermove", onPointerMove as EventListener);
			el.removeEventListener("pointerup", endResize as EventListener);
			el.removeEventListener("lostpointercapture", endResize as EventListener);
			el.remove();
		},
	};
}
