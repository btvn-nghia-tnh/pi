import type { StatPathsData } from "./types.ts";

/**
 * File reference detection for the transcript: pure candidate extraction and
 * extension mapping (unit-tested) plus DOM decoration (added with the preview
 * wiring). Candidates are validated against the server via stat_paths before
 * anything becomes clickable.
 */

/** Whitespace/punctuation-delimited token scan (single-line tokens only). */
const TOKEN_RE = /(?:^|[\s([{'"`=<>])([^\s([{'"`=<>]+)/g;
const TRIM_CHARS = ".,;:!?\"'`)]}";
/** Leading trim excludes "." so dotfiles and ./ ../ prefixes keep their dot. */
const LEADING_TRIM_CHARS = ",;:!?\"'`)]}";

/** Well-known files without an extension worth linking. */
export const EXTENSIONLESS_FILE_NAMES = new Set([
	"makefile",
	"dockerfile",
	"docker-compose",
	"license",
	"readme",
	"changelog",
	".gitignore",
	".gitattributes",
	".env",
	".npmrc",
]);

function hasExtension(candidate: string): boolean {
	return /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(candidate);
}

function isKnownName(candidate: string): boolean {
	const lower = candidate.toLowerCase();
	const basename = lower.split("/").pop() ?? lower;
	return EXTENSIONLESS_FILE_NAMES.has(lower) || EXTENSIONLESS_FILE_NAMES.has(basename);
}

function looksLikePath(candidate: string): boolean {
	return /^([~/]|\.\/|\.\.\/)/.test(candidate) || /^[A-Za-z0-9_.-]+\//.test(candidate);
}

/**
 * Extract path candidates from free text. Tokens are accepted when they look
 * like paths (absolute, ~, ./, ../, or containing a slash), carry a known
 * file extension, or are well-known extensionless file names. URLs and CLI
 * flags are rejected; surrounding punctuation is trimmed. Existence is NOT
 * checked here — that is stat_paths' job.
 */
export function extractPathCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (const match of text.matchAll(TOKEN_RE)) {
		let candidate = match[1] ?? "";
		while (candidate.length > 0 && TRIM_CHARS.includes(candidate[candidate.length - 1]!)) {
			candidate = candidate.slice(0, -1);
		}
		while (candidate.length > 0 && LEADING_TRIM_CHARS.includes(candidate[0]!)) {
			candidate = candidate.slice(1);
		}
		if (candidate.length === 0 || candidate.includes("://") || candidate.startsWith("-")) continue;
		if (looksLikePath(candidate) || hasExtension(candidate) || isKnownName(candidate)) {
			candidates.push(candidate);
		}
	}
	return [...new Set(candidates)];
}

const EXTENSION_LANGUAGE: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	rb: "ruby",
	php: "php",
	swift: "swift",
	kt: "kotlin",
	css: "css",
	scss: "scss",
	html: "html",
	htm: "html",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	xml: "xml",
	md: "markdown",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	lua: "lua",
	vim: "vim",
	dockerfile: "dockerfile",
};

/** Map a file path to a highlight.js language id (lowercase extension). */
export function extensionToLanguage(path: string): string | undefined {
	const segments = path.split(/[\\/]/);
	const name = segments[segments.length - 1] ?? path;
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return undefined;
	const extension = name.slice(dot + 1).toLowerCase();
	return EXTENSION_LANGUAGE[extension];
}

// ---------------------------------------------------------------------------
// DOM decoration (validated via stat_paths; thin, not unit-tested per the
// web suite's pure-function policy)
// ---------------------------------------------------------------------------

export interface FileRefContext {
	sessionId: string | undefined;
	statPaths: (paths: string[]) => Promise<StatPathsData["results"]>;
}

interface PendingMatch {
	node: Text;
	start: number;
	length: number;
	candidate: string;
}

const STAT_TTL_MS = 30_000;
/** `${sessionId}::${raw}` → resolved absolute path. */
const rawToAbsolute = new Map<string, string>();
/** Absolute path → stat result (TTL-bounded). */
const statCache = new Map<string, { kind: "file" | "dir"; expires: number }>();

function cacheKey(raw: string, sessionId: string | undefined): string {
	return `${sessionId ?? ""}::${raw}`;
}

function lookupStat(raw: string, sessionId: string | undefined): { kind: "file" | "dir" } | undefined {
	const absolute = rawToAbsolute.get(cacheKey(raw, sessionId));
	if (!absolute) return undefined;
	const entry = statCache.get(absolute);
	if (!entry || entry.expires < Date.now()) return undefined;
	return entry;
}

function recordStats(results: StatPathsData["results"], sessionId: string | undefined): void {
	for (const result of results) {
		rawToAbsolute.set(cacheKey(result.input, sessionId), result.path);
		if (result.exists && (result.kind === "file" || result.kind === "dir")) {
			statCache.set(result.path, { kind: result.kind, expires: Date.now() + STAT_TTL_MS });
		}
	}
}

function wrapMatch(match: PendingMatch): void {
	if (!match.node.isConnected) return;
	const value = match.node.nodeValue ?? "";
	if (value.slice(match.start, match.start + match.length) !== match.candidate) return;
	const candidateNode = match.node.splitText(match.start);
	candidateNode.splitText(match.length);
	const span = document.createElement("span");
	span.className = "file-ref";
	span.dataset.path = match.candidate;
	span.textContent = match.candidate;
	candidateNode.replaceWith(span);
}

/**
 * Decorate file references inside `root`: collect candidates from text
 * nodes, validate the unknown ones through ctx.statPaths, then wrap
 * confirmed files in clickable `.file-ref` spans. Idempotent (skips text
 * inside pre/a/.file-ref and already-wrapped nodes); fail-closed (a stat
 * failure decorates nothing).
 */
export function decorateFileRefs(root: HTMLElement, ctx: FileRefContext): void {
	const matches: PendingMatch[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode() as Text | null;
	while (node) {
		const parent = node.parentElement;
		if (parent && !parent.closest("pre, a, .file-ref")) {
			const text = node.nodeValue ?? "";
			if (parent.tagName === "CODE") {
				// Inline code: linkify only when the entire element text is one candidate.
				if (extractPathCandidates(text).includes(text)) {
					matches.push({ node, start: 0, length: text.length, candidate: text });
				}
			} else {
				for (const candidate of extractPathCandidates(text)) {
					const start = text.indexOf(candidate);
					if (start >= 0) {
						matches.push({ node, start, length: candidate.length, candidate });
					}
				}
			}
		}
		node = walker.nextNode() as Text | null;
	}
	if (matches.length === 0) return;

	const apply = (): void => {
		// Reverse document order keeps splitText offsets of earlier matches valid.
		for (let i = matches.length - 1; i >= 0; i--) {
			const match = matches[i]!;
			if (lookupStat(match.candidate, ctx.sessionId)?.kind === "file") {
				wrapMatch(match);
			}
		}
	};

	const unknown = [...new Set(matches.map((match) => match.candidate))].filter(
		(candidate) => lookupStat(candidate, ctx.sessionId) === undefined,
	);
	if (unknown.length === 0) {
		apply();
		return;
	}
	void ctx
		.statPaths(unknown)
		.then((results) => {
			recordStats(results, ctx.sessionId);
			apply();
		})
		.catch(() => {
			// Fail-closed: no links rather than wrong links.
		});
}
