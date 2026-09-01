# Changelog

## [Unreleased]

### Added

- Initial browser GUI package for `pi web`: transcript rendering (markdown, thinking blocks, tool cards with word-level diffs, images), editor with slash commands, `@` file completion, shell mode, image paste, queue management, footer stats, all selectors and dialogs (model, thinking, sessions, tree, settings, themes, trust, login, share, import/export, changelog, hotkeys), keyboard shortcuts, reconnect handling, and transcript search.
- File preview panel: an expanding right column rendering text (syntax highlighted, line-numbered, load-more paging) and images fetched over `read_file`.
- Clickable file references across the transcript (assistant text, user messages, bash output, tool cards) — validated against the server before linkifying; clicking opens the preview panel; Esc closes it.
- Syntax-colored code blocks and file previews: the active theme's syntax colors now map to `.hljs` token styles (markdown fences included).
- Tabbed file preview panel: multiple files stay open as VSCode-style tabs; clicking an already-open reference re-opens and refreshes its tab; Esc closes the active tab (the panel hides when the last tab closes).
- Jupyter notebook preview: `.ipynb` files render as cells — markdown via the markdown renderer, code highlighted per-cell (language from kernel metadata), stream/error/image outputs inline.
- Rendered HTML preview: `.html`/`.htm` files display as a sandboxed live page (scripts run, no same-origin access) with a Source toggle to switch to the highlighted source view.
- Rendered markdown preview: `.md`/`.markdown` files display as formatted markdown with the same Source toggle; markdown rendered from file content (file previews and notebook cells) is sanitized — script/iframe/embed tags, `on*` handlers, and `javascript:`/`vbscript:` URLs are stripped before entering the DOM.

