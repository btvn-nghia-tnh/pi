/**
 * Prompt history for the editor: a capped, deduplicated string ring buffer
 * persisted in localStorage. Pure storage logic so it stays unit-testable;
 * the editor owns ArrowUp/Down navigation over the entries.
 */

const HISTORY_KEY = "pi-web-prompt-history";
const HISTORY_MAX = 100;

/** Append an entry (skips empty prompts and immediate repeats), newest last. */
export function appendPromptHistory(entries: string[], text: string, max = HISTORY_MAX): string[] {
	const trimmed = text.trim();
	if (!trimmed) return entries;
	if (entries[entries.length - 1] === trimmed) return entries;
	const next = [...entries, trimmed];
	return next.length > max ? next.slice(next.length - max) : next;
}

/** Persisted history, newest last. Corrupt storage reads as empty. */
export function loadPromptHistory(): string[] {
	try {
		const raw = globalThis.localStorage?.getItem(HISTORY_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

export function savePromptHistory(entries: string[]): void {
	try {
		globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(entries));
	} catch {
		// Storage unavailable or full: history becomes session-only.
	}
}
