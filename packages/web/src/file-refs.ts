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
