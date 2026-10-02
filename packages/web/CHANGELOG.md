# Changelog

## [Unreleased]

### Fixed

- Custom messages (intercom, subagent notices, subagent slash results) render their content: the human-readable `content` payload (markdown or content blocks) now renders in the body with a friendly label per type, and the structured `details` payload stays available in a collapsed section. Previously the renderer read a nonexistent `data` field, so these messages showed only a bare type label with no message text.

### Added

- Initial browser GUI package for `pi web`: transcript rendering (markdown, thinking blocks, tool cards with word-level diffs, images), editor with slash commands, `@` file completion, shell mode, image paste, queue management, footer stats, all selectors and dialogs (model, thinking, sessions, tree, settings, themes, trust, login, share, import/export, changelog, hotkeys), keyboard shortcuts, reconnect handling, and transcript search.
- File preview panel: an expanding right column rendering text (syntax highlighted, line-numbered, load-more paging) and images fetched over `read_file`.
- SVG image preview: `.svg` files render as images in the preview panel via a `data:image/svg+xml;charset=utf-8;base64,...` URI (browsers disable SVG scripts and external references in `<img>` context); oversized or mislabeled files fall back to the source view.
- Session picker multi-select deletion: checkboxes mark sessions for deletion and "Delete selected" removes exactly the checked ones (open sessions cannot be checked; deleted files go to the trash when available); deletes refresh the sidebar too.
- Session picker "Select all" toggle: one click checks (or unchecks) every closable session in the current scope.
- Inline ask-user cards: extension select/confirm/input questions render as cards above the editor instead of modals — the transcript stays readable while the question is answered ("is this plan ok?" no longer covers the plan). The ask_user_question questionnaire overlay follows the same treatment: it renders inline (radio rows, custom answer, preview pane and submit row included) while other overlay widgets (status panels) stay modal. Auth prompts and long-form editors stay modal.
- Browser tab status: while any session runs, the tab title pulses (▶) and the favicon shows a green dot; when all turns finish while the tab is hidden, a desktop notification fires when permission was already granted (never prompted).
- Transcript code fences get a hover copy button that copies the exact code text (with a brief ✓ confirmation); bare tool-output blocks are untouched.
- Editor prompt history: ArrowUp on an empty input recalls previous prompts, ArrowDown walks back to the draft, typing cancels — persisted in localStorage, capped at 100, immediate repeats deduped.
- Preview in-file search: text previews get a find box (Ctrl+F when the preview is open) with case-insensitive highlighting, an n/m counter, Enter/Shift+Enter navigation, and Esc to clear; the query resets on tab switches.
- /quit closes the active session slot (running sessions confirm first; the primary session explains that the browser tab must be closed instead — window.close() is blocked for tabs the browser opened).
- Clickable file references across the transcript (assistant text, user messages, bash output, tool cards) — validated against the server before linkifying; clicking opens the preview panel; Esc closes it.
- Syntax-colored code blocks and file previews: the active theme's syntax colors now map to `.hljs` token styles (markdown fences included).
- Tabbed file preview panel: multiple files stay open as VSCode-style tabs; clicking an already-open reference re-opens and refreshes its tab; Esc closes the active tab (the panel hides when the last tab closes).
- Fixed cross-session widget pollution: extension widget/status events for a session the client has not registered yet (they race ahead of its session_opened payload during openSession) no longer fall back to the active session's store, where they could delete or replace another session's widgets (e.g. the todo list vanishing after opening a subagent-running session).
- Jupyter notebook preview: `.ipynb` files render as cells — markdown via the markdown renderer, code highlighted per-cell (language from kernel metadata), stream/error/image outputs inline.
- Rendered HTML preview: `.html`/`.htm` files display as a sandboxed live page (scripts run, no same-origin access) with a Source toggle to switch to the highlighted source view.
- Rendered markdown preview: `.md`/`.markdown` files display as formatted markdown with the same Source toggle; markdown rendered from file content (file previews and notebook cells) is sanitized — script/iframe/embed tags, `on*` handlers, and `javascript:`/`vbscript:` URLs are stripped before entering the DOM.

