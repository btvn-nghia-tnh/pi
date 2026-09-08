# Changelog

## [Unreleased]

### Fixed

- Custom messages (intercom, subagent notices, subagent slash results) render their content: the human-readable `content` payload (markdown or content blocks) now renders in the body with a friendly label per type, and the structured `details` payload stays available in a collapsed section. Previously the renderer read a nonexistent `data` field, so these messages showed only a bare type label with no message text.

### Added

- Initial browser GUI package for `pi web`: transcript rendering (markdown, thinking blocks, tool cards with word-level diffs, images), editor with slash commands, `@` file completion, shell mode, image paste, queue management, footer stats, all selectors and dialogs (model, thinking, sessions, tree, settings, themes, trust, login, share, import/export, changelog, hotkeys), keyboard shortcuts, reconnect handling, and transcript search.
- File preview panel: an expanding right column rendering text (syntax highlighted, line-numbered, load-more paging) and images fetched over `read_file`.
- Clickable file references across the transcript (assistant text, user messages, bash output, tool cards) — validated against the server before linkifying; clicking opens the preview panel; Esc closes it.
- Syntax-colored code blocks and file previews: the active theme's syntax colors now map to `.hljs` token styles (markdown fences included).
- Tabbed file preview panel: multiple files stay open as VSCode-style tabs; clicking an already-open reference re-opens and refreshes its tab; Esc closes the active tab (the panel hides when the last tab closes).
- Fixed cross-session widget pollution: extension widget/status events for a session the client has not registered yet (they race ahead of its session_opened payload during openSession) no longer fall back to the active session's store, where they could delete or replace another session's widgets (e.g. the todo list vanishing after opening a subagent-running session).
- Jupyter notebook preview: `.ipynb` files render as cells — markdown via the markdown renderer, code highlighted per-cell (language from kernel metadata), stream/error/image outputs inline.
- Rendered HTML preview: `.html`/`.htm` files display as a sandboxed live page (scripts run, no same-origin access) with a Source toggle to switch to the highlighted source view.
- Rendered markdown preview: `.md`/`.markdown` files display as formatted markdown with the same Source toggle; markdown rendered from file content (file previews and notebook cells) is sanitized — script/iframe/embed tags, `on*` handlers, and `javascript:`/`vbscript:` URLs are stripped before entering the DOM.

