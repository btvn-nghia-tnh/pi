/**
 * Keyboard shortcuts, mirroring the TUI keybindings with browser-safe
 * alternates for combos the browser reserves.
 */

export type ShortcutAction =
	| "app.interrupt"
	| "app.clear"
	| "app.exit"
	| "app.thinking.cycle"
	| "app.thinking.toggle"
	| "app.model.cycleForward"
	| "app.model.cycleBackward"
	| "app.model.select"
	| "app.tools.expand"
	| "app.session.new"
	| "app.session.tree"
	| "app.session.fork"
	| "app.session.resume"
	| "app.editor.external"
	| "app.message.copy"
	| "app.message.followUp"
	| "app.message.dequeue"
	| "app.clipboard.pasteImage"
	| "app.session.toggleNamedFilter"
	| "app.tree.foldOrUp"
	| "app.tree.unfoldOrDown"
	| "app.search"
	| "dialog.cancel"
	| "dialog.confirm"
	| "dialog.up"
	| "dialog.down";

export interface EffectiveShortcut {
	action: ShortcutAction;
	keys: string[];
	browserAlternate: boolean;
}

/**
 * TUI defaults plus browser alternates for reserved combos.
 * Ctrl+T (new tab), Ctrl+N (new window), Ctrl+W (close tab) cannot be
 * intercepted reliably in browsers.
 */
const SHORTCUTS: Record<ShortcutAction, string[]> = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.thinking.cycle": ["shift+tab"],
	"app.thinking.toggle": ["alt+t"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["shift+ctrl+p"],
	"app.model.select": ["ctrl+l"],
	"app.tools.expand": ["ctrl+o"],
	"app.session.new": [],
	"app.session.tree": [],
	"app.session.fork": [],
	"app.session.resume": [],
	"app.editor.external": ["ctrl+g"],
	"app.message.copy": ["ctrl+x"],
	"app.message.followUp": ["alt+enter"],
	"app.message.dequeue": ["alt+up"],
	"app.clipboard.pasteImage": ["ctrl+v"],
	"app.session.toggleNamedFilter": ["alt+n"],
	"app.tree.foldOrUp": ["ctrl+left"],
	"app.tree.unfoldOrDown": ["ctrl+right"],
	"app.search": ["ctrl+shift+f"],
	"dialog.cancel": ["escape"],
	"dialog.confirm": ["enter"],
	"dialog.up": ["up"],
	"dialog.down": ["down"],
};

/** Keybinding overrides received from get_keybindings, applied on top. */
export function effectiveShortcuts(
	serverBindings: Array<{ id: string; keys: string[] }> | undefined,
): EffectiveShortcut[] {
	const byId = new Map<string, string[]>();
	for (const binding of serverBindings ?? []) {
		byId.set(binding.id, binding.keys);
	}
	return (Object.keys(SHORTCUTS) as ShortcutAction[]).map((action) => {
		const serverKeys = byId.get(action);
		const keys = serverKeys && serverKeys.length > 0 ? serverKeys : SHORTCUTS[action];
		return {
			action,
			keys,
			browserAlternate: serverKeys === undefined && action === "app.thinking.toggle",
		};
	});
}

/** Normalize a browser KeyboardEvent to the TUI key format. */
export function eventToKey(event: KeyboardEvent): string {
	const parts: string[] = [];
	if (event.ctrlKey) parts.push("ctrl");
	if (event.metaKey) parts.push("ctrl");
	if (event.shiftKey) parts.push("shift");
	if (event.altKey) parts.push("alt");
	let key = event.key.toLowerCase();
	if (key === " ") key = "space";
	if (!["control", "shift", "alt", "meta"].includes(key)) {
		parts.push(key);
	}
	return parts.join("+");
}

export interface KeyboardContext {
	/** Return true when the key was handled. */
	handleAction: (action: ShortcutAction, event: KeyboardEvent) => boolean;
	/** Server-provided binding overrides. */
	serverBindings?: Array<{ id: string; keys: string[] }>;
}

export function registerGlobalKeyboard(context: KeyboardContext): () => void {
	const handler = (event: KeyboardEvent): void => {
		const key = eventToKey(event);
		const target = event.target as HTMLElement | null;
		const inEditor = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT" || target?.isContentEditable;

		// Editor-scoped keys are handled by the editor component itself.
		const editorScoped: string[] = [
			"escape",
			"enter",
			"alt+enter",
			"ctrl+c",
			"ctrl+d",
			"ctrl+v",
			"ctrl+g",
			"alt+up",
			"shift+tab",
			"tab",
		];
		if (inEditor && editorScoped.includes(key)) {
			// Only handle non-editor global keys when typing.
			return;
		}

		const bindings = effectiveShortcuts(context.serverBindings);
		for (const binding of bindings) {
			if (binding.keys.includes(key)) {
				if (context.handleAction(binding.action, event)) {
					event.preventDefault();
					event.stopPropagation();
				}
				return;
			}
		}
	};

	document.addEventListener("keydown", handler);
	return () => {
		document.removeEventListener("keydown", handler);
	};
}
