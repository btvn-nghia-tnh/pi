/**
 * Markdown rendering via the vendored marked + highlight.js loaded by
 * index.html. Falls back to escaped plain text when globals are missing.
 */

export interface MarkdownRenderOptions {
	streaming?: boolean;
}

interface HighlightJs {
	highlight(code: string, options: { language: string }): { value: string };
	getLanguage?: (language: string) => unknown;
}

interface MarkedGlobal {
	parse(markdown: string, options?: Record<string, unknown>): string;
	setOptions(options: Record<string, unknown>): void;
}

declare global {
	interface Window {
		marked?: MarkedGlobal;
		hljs?: HighlightJs;
	}
}

function escapeHtmlText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Render markdown to an HTML string. Mermaid fences render as plain code blocks. */
export function renderMarkdown(markdown: string, _options?: MarkdownRenderOptions): string {
	const marked = typeof window !== "undefined" ? window.marked : undefined;
	if (!marked) {
		return `<p>${escapeHtmlText(markdown).replaceAll("\n", "<br>")}</p>`;
	}
	try {
		marked.setOptions({
			breaks: true,
			gfm: true,
		});
		let html = marked.parse(markdown);
		const hljs = typeof window !== "undefined" ? window.hljs : undefined;
		if (hljs) {
			html = html.replace(
				/<pre><code(?: class="language-(\w[\w+-]*)")?>([\s\S]*?)<\/code><\/pre>/g,
				(_match: string, language: string | undefined, code: string) => {
					let decoded = code;
					try {
						decoded = decodeHtmlEntities(code);
					} catch {
						decoded = code;
					}
					if (language && hljs.getLanguage && hljs.getLanguage(language)) {
						try {
							const highlighted = hljs.highlight(decoded, { language }).value;
							return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
						} catch {
							// fall through to escaped
						}
					}
					return `<pre><code class="hljs">${escapeHtmlText(decoded)}</code></pre>`;
				},
			);
		}
		return html;
	} catch {
		return `<p>${escapeHtmlText(markdown)}</p>`;
	}
}

function decodeHtmlEntities(text: string): string {
	if (typeof document === "undefined") return text;
	const textarea = document.createElement("textarea");
	textarea.innerHTML = text;
	return textarea.value;
}

/** Extract raw text from markdown for copy-to-clipboard fallbacks. */
export function markdownToPlainText(markdown: string): string {
	return markdown;
}

const FORBIDDEN_ELEMENTS = new Set(["script", "iframe", "object", "embed", "style", "link", "meta", "base", "form"]);

/**
 * Strip active-content vectors (script/iframe/embed tags, on* handlers,
 * javascript:/vbscript: URLs) from HTML rendered from untrusted file
 * content (markdown previews, notebook cells). Agent-authored transcript
 * markdown keeps the raw renderMarkdown path.
 */
export function sanitizeMarkdownHtml(html: string): string {
	if (typeof document === "undefined") return html;
	const container = document.createElement("div");
	container.innerHTML = html;
	const walk = (element: Element): void => {
		for (const child of [...element.children]) {
			if (FORBIDDEN_ELEMENTS.has(child.tagName.toLowerCase())) {
				child.remove();
				continue;
			}
			for (const attribute of [...child.attributes]) {
				const name = attribute.name.toLowerCase();
				if (name.startsWith("on")) {
					child.removeAttribute(attribute.name);
					continue;
				}
				if ((name === "href" || name === "src") && /^\s*(?:javascript|vbscript):/i.test(attribute.value)) {
					child.removeAttribute(attribute.name);
				}
			}
			walk(child);
		}
	};
	walk(container);
	return container.innerHTML;
}
