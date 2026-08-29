# Pi Web GUI — Design Document

Date: 2026-08-29
Status: Approved (approach + security + mapping confirmed by user; section-by-section review waived)

## 1. Goal

Build a web GUI for the pi coding agent with **full feature parity to the interactive TUI**:
everything the TUI in this repo can do (slash commands, thinking display, diffs, tool calls
and tool output rendering, token/cost/context info, model info & switching, session
management incl. tree/fork/clone/resume, queueing, compaction, retry, extension UI, themes,
settings, share/import/export, hotkeys) must exist in the web GUI under a web-native form.

Terminal-only constructs are mapped to web-native equivalents (approved):

| TUI | Web equivalent |
|---|---|
| Ctrl+G external editor ($EDITOR) | Full-screen modal editor (Ctrl+Enter submits) |
| Ctrl+Z suspend | N/A (browser) |
| Fullscreen alt-screen mode + scrollbar settings | Web layout is always transcript + fixed bottom dock; native browser scrollbar |
| Kitty/iTerm2 inline images | `<img>` elements |
| OSC 133 / shell integration | N/A |
| OSC 8 hyperlinks | normal `<a>` links |
| Mouse selection / copy | native browser selection |
| Keyboard combos the browser reserves (Ctrl+N/T/W…) | same TUI defaults where the browser allows; documented alternates |

## 2. Approved decisions

1. Deployment: local `pi web` command. One process, one `AgentSessionRuntime`, one active
   session; session switching happens in place (like the TUI). No multi-user remote server.
2. Frontend: vanilla TypeScript + esbuild bundle. No React/Vue/etc.
3. Backend reuses `AgentSessionRuntime` (same layer as TUI/RPC modes) inside the `pi web`
   process; UI talks to it via WebSocket using the RPC JSON protocol.
4. Security: bind `127.0.0.1` by default with a random per-run token in the URL query
   (`?token=…`). `--host <addr>` and `--no-token` opt out (with a warning). Origin/Host
   checks reject cross-origin requests.

## 3. Architecture

```
Browser
  packages/web (new workspace package, browser-only code)
    src/            TypeScript UI + CSS, esbuild → dist/
      talks over WebSocket with JSON commands/events (RPC protocol + web extensions)

pi web process
  packages/coding-agent
    src/modes/web/web-mode.ts     (new: HTTP+WS server, token gate, static serving)
    src/modes/rpc/rpc-core.ts     (new: transport-agnostic RPC command core)
    src/modes/rpc/rpc-mode.ts    (refactored: thin stdio transport over rpc-core)
    src/modes/web/web-commands.ts (new: web-parity commands)
    AgentSessionRuntime + SettingsManager + SessionManager + theme catalog
```

Dependency direction: `coding-agent` server code imports nothing from `packages/web`.
`packages/web` imports only types from `@earendil-works/pi-ai` and
`@earendil-works/pi-agent-core` (both browser-safe per `scripts/check-browser-smoke.mjs`).
Assets are copied at build time (no runtime cross-package resolution).

## 4. Package & repo layout

### New: `packages/web` (`@earendil-works/pi-web`)

```
packages/web/
  package.json        private: true, no npm publish (build-only package)
  tsconfig.json       extends root, browser lib DOM+ES2022
  build.mjs           esbuild: src/main.ts → dist/pi-web.js (+ sourcemap), src/main.css → dist
  vendor/             marked.min.js, highlight.min.js (copied from
                      packages/coding-agent/src/core/export-html/vendor, same versions)
  src/
    main.ts                       entry: boot, connection, mount
    connection.ts                 WS client: token, reconnect, command/response ids, events
    state.ts                      central store (messages, session state, queue, footer data)
    dom.ts                        small DOM helpers (h(), mount, delegate)
    keyboard.ts                   global keydown → action dispatch, keybinding config
    markdown.ts                   markdown→HTML via vendored marked; mermaid + transformers
    diff.ts                       word-level intra-line diff (port of TUI diff.ts)
    ansi.ts                       ANSI→HTML for tool output text (port of ansi-to-html)
    fuzz.ts                       fuzzy filter/sort (port of TUI fuzzy.ts algorithm)
    types.ts                      shared UI-side protocol types (mirror rpc-types)
    render/
      transcript.ts              list controller: append/update items, streaming, autoscroll
      user-message.ts             user message card (bg, attachments, images)
      assistant-message.ts        markdown + collapsible thinking blocks, streaming cursor
      tool-execution.ts           tool call/result card: collapsed/expanded states
      tool-renderers.ts           per-tool renderers (bash, read, write, edit diff, ls, find, grep)
      bash-execution.ts           `!`-command transcript entries
      compaction-summary.ts       compaction + branch summary entries
      custom-message.ts           extension custom entries
      notifications.ts            notice/error entries
    editor/
      editor.ts                   textarea controller: multi-line, submit/steer/follow-up
      autocomplete.ts             slash-command + @file dropdown (fuzzy)
      attachments.ts              clipboard paste + drag-drop images
      shell-mode.ts               ! / !! prefix handling
    footer.ts                     tokens/cost/context/model/thinking/branch/name/status
    widgets.ts                    extension widgets above/below editor
    working.ts                    working indicator / spinner frames
    dialogs/
      dialog.ts                   modal base (focus trap, Esc stack)
      model-selector.ts           search, provider grouping, Ctrl+S save default
      thinking-selector.ts        levels + Ctrl+S save default
      scoped-models.ts            enable/disable/reorder cycle set
      session-selector.ts         /resume: search, sort, named filter, rename, delete, path
      tree-selector.ts            /tree: folding, labels, timestamps, filters, summarize
      settings.ts                 full settings panel (mirrors /settings)
      theme-selector.ts
      extension-ui.ts             select/confirm/input/editor + notify toasts
      trust.ts                    project trust dialog
      login.ts                    provider auth (API key + OAuth URL)
      share.ts / import.ts / export.ts
      session-info.ts             /session stats
      changelog.ts / hotkeys.ts   viewers
      external-editor.ts          Ctrl+G modal
      first-time-setup.ts         experimental setup parity
  dist/                          (gitignored) esbuild output
```

### Modified: `packages/coding-agent`

```
src/modes/rpc/rpc-core.ts        (new) transport-agnostic command core
src/modes/rpc/rpc-types.ts       (extend) new command/result types
src/modes/rpc/rpc-mode.ts        (refactor) stdio transport only
src/modes/web/web-mode.ts        (new) server: http + ws + token + static + runtime wiring
src/modes/web/web-commands.ts    (new) web-parity command handlers
src/modes/web/web-assets.ts      (new) dist dir resolution (module-relative, PI_WEB_DIST env)
src/modes/index.ts               (extend) export runWebMode
src/main.ts                      (extend) `pi web` dispatch (appMode "web")
src/cli/args.ts                  (extend) --port/--host/--no-token/--no-open for web mode
src/core/agent-session-runtime.ts (no change unless importFromJsonl exposure needed — it exists)
package.json                     (deps: add "ws" pinned exact; files: dist/web/)
```

## 5. Protocol design

### 5.1 RPC core refactor

Extract from `rpc-mode.ts` into `src/modes/rpc/rpc-core.ts`:

```ts
export interface RpcCoreOptions {
  runtime: AgentSessionRuntime;
  send: (message: object) => void;        // transport writes one JSON message
  flush?: () => void | Promise<void>;    // optional backpressure hook
  extraCommands?: RpcCommandHandler;     // web-mode adds its command handlers here
}
export class RpcCore {
  handleCommand(command: RpcCommand): Promise<RpcResponse | undefined>;
  handleExtensionUIResponse(response: RpcExtensionUIResponse): void;
  dispose(): Promise<void>;
  // internally: rebindSession(), extension UI context, session.subscribe(toJsonEvent),
  // pending extension UI requests, shutdown flag handling
}
```

`rpc-mode.ts` keeps: stdio JSONL reader/writer, signals, stdout takeover, process exit.
No behavior change; existing RPC tests keep passing.

### 5.2 New commands (shared core; available to RPC and web)

Session management:

- `list_sessions` `{ scope: "cwd" | "all" }` → `{ sessions: [{ file, id, name?, cwd, modified, parentSession?, messageCount }] }`
  (from `SessionManager.list` / `listAll`).
- `delete_session` `{ sessionPath }` → `{ method: "trash" | "unlink" }` — `trash` CLI first,
  fallback `unlink` (same logic as TUI picker).
- `rename_session` `{ sessionPath, name }` → `SessionManager.open(path).appendSessionInfo(name)`.
- `navigate_tree` `{ targetId, summarize?, customInstructions?, replaceInstructions?, label? }` →
  `{ editorText?, cancelled }` (in-place tree navigation; `session.navigateTree`).
- `import_session` `{ path }` → result of `runtimeHost.importFromJsonl(path)`; on
  `MissingSessionCwdError` the error is surfaced so the UI can prompt for a cwd
  (`import_session` `{ path, cwd }` retry).

Context / info:

- `get_context_info` → `{ version, cwd, gitBranch?, contextFiles: [{path, source}],
  skills: [{name, description, sourceInfo}], promptTemplates: [{name, description, sourceInfo}],
  extensions: [{name, sourceInfo}], commands: [...same as get_commands], keybindingCount,
  themeNames: [string], sessionDir, providers: [{id, authenticated, subscription?}] }`
  (feeds the startup header; git branch computed via `git rev-parse --abbrev-ref HEAD`
  with a 5s cache, invalidated on session switch).
- `get_changelog` → `{ markdown }` (same content the TUI /changelog shows:
  parsed CHANGELOG.md entries across packages, links normalized).
- `get_keybindings` → `{ bindings: [{ id, keys, description }] }` (current effective config
  incl. user overrides from keybindings.json).

Settings:

- `get_settings` → `{ global, project, effective, paths: { global, project }, errors }`
  (SettingsManager snapshot).
- `set_settings` `{ scope: "global" | "project", values: Record<string, unknown> }` →
  `{ errors? }` — writes via SettingsManager, then applies runtime-affecting keys
  (theme, thinking budgets, steering/followUp modes, compaction, retry, hideThinkingBlock…)
  the same way `/settings` does in the TUI.
- `get_themes` → `{ themes: [{ name, vars: Record<string,string> }] }` (theme-controller
  catalog incl. custom user themes).
- `set_theme` `{ name }` → persists setting + emits `theme_changed` event with theme vars.

Files (for `@` completion):

- `search_files` `{ query?, limit? }` → `{ files: string[] }` — relative paths under the
  session cwd, gitignore-aware (reuse `ignore` dep), cached per cwd + mtime refresh;
  fuzzy filtering happens client-side.

Auth / trust:

- `auth_status` → `{ providers: [{ id, authenticated, kind? }] }`.
- `auth_login` `{ provider, method: "api_key" | "oauth", apiKey?, openUrl? }` →
  `{ url? }` for oauth (URL opened by the client in a new tab); completion is signaled by
  the `auth_changed` event. API-key path stores the key and returns success.
- `auth_logout` `{ provider }` → removes credentials.
- `get_trust` → `{ trusted, options: ProjectTrustOption[], savedDecision? }`.
- `set_trust` `{ trusted, updates, path? }` → saves decision via TrustManager.

Misc:

- `export_session` `{ path? }` → exports by extension (`.html` via existing
  `exportToHtml`, `.jsonl` via the session file copy) and returns `{ path }` — the web
  client offers it as a download link.
- `reload` → `session.reload()` + re-emit `connected` data (extensions, skills, themes,
  keybindings reloaded) — powers `/reload`.
- `share_session` → runs the share flow (radius, fallback GitHub gist) →
  `{ url, gistUrl? }`; progress via existing status mechanism.
- `get_session_dir` → `{ dir }` (used by import/share UI hints).

### 5.3 Events

All existing RPC events pass through unchanged (`toJsonEvent`), including
`extension_ui_request` and `bash_execution_update`. Added:

- `theme_changed` `{ name, vars }` — after `set_theme`.
- `auth_changed` `{ provider }` — after login/logout.
- `connected` (server→client on WS open) `{ state: RpcSessionState, messages,
  contextInfo, trust, version, tokenValid: true }` — one-shot initial sync so the
  browser renders a full transcript immediately.
- `server_shutdown` `{ reason }` — sent before the process exits.

### 5.4 Wire format

JSON text frames over WebSocket (`ws`), one message per frame, same shapes as RPC JSONL.
Requests carry optional `id`; responses mirror it. Extension UI dialogs use the existing
`extension_ui_request` / `extension_ui_response` sub-protocol verbatim.

## 6. Backend design (`pi web`)

- Dispatch: `main.ts` recognizes `args[0] === "web"` → appMode `"web"`; strips the `web`
  subcommand and web flags (`--port`, `--host`, `--no-token`, `--no-open`) before generic
  parsing; the rest
  of startup (session selection, migrations, trust, settings) is the shared runtime path.
  `--mode web` also accepted.
- Server: `node:http` + `ws`. Default port 4762, `--port` to override; `--host 127.0.0.1`.
  On start, prints the URL and (unless `--no-open`) opens the default browser.
- Token: `crypto.randomBytes(24).toString("base64url")`, required on every request
  (`?token=` or `Authorization: Bearer`); compared with constant-time equality. 404 for
  wrong/missing token (no 403 oracle). `--no-token` warns. When `--host` is not loopback,
  require `--no-token` acknowledgement and print a warning.
- Origin check: `Host` must match the bound host:port; `Origin` (if present) must match
  the served origin; otherwise reject. Protects against DNS rebinding from public sites.
- Static: serve `web-dist/` (module-relative resolution: `dist/web/` in published layout,
  `packages/web/dist/` in dev via `PI_WEB_DIST`). Content-types, ETag caching, path
  traversal rejection. No directory listings.
- WebSocket: single endpoint `/ws`. Commands are processed sequentially per connection;
  every connected client receives all events (multi-tab observation works; v1 has one
  runtime).
- Shutdown: SIGINT/SIGTERM → send `server_shutdown`, close WS, `runtimeHost.dispose()`,
  exit 0.

## 7. Frontend design

- No framework. Small `h()` DOM helper + explicit render functions per component; a
  central `state.ts` store with subscribe; components re-render on store updates
  (coarse-grained; transcript items append/update in place by entry id).
- Theming: CSS custom properties on `:root`; values generated from theme JSON `vars` +
  `colors` map (from `get_themes` / `connected`), dark default. Theme switch rewrites the
  variables — mirrors TUI theme switching.
- Transcript: virtual-friendly list; each entry keyed by message id/entry id; streaming
  text appends to the live markdown render; thinking blocks collapsible with per-level
  color (thinkingOff…thinkingMax mapped from theme colors); tool cards collapsed by
  default with summary line, expanded shows full output (Ctrl+O toggles globally, same as
  TUI); diffs rendered with word-level intra-line highlight (port of `diff.ts` using the
  `diff` npm package, browser-safe); images inline `<img>` (converted/previewed like the
  TUI `Image` component); mermaid code blocks rendered as ASCII art via `grok-mermaid`
  (same library as TUI) inside a `<pre>`; if the browser bundle check rejects
  `grok-mermaid` as non-browser-safe, fall back to a plain fenced code block
  (degradation documented here; decided at implementation time).
- Editor: styled textarea, multi-line via Shift+Enter/Ctrl+Enter, Enter submits (queues
  steering while streaming; Alt+Enter queues follow-up), border color reflects thinking
  level (same palette mapping as TUI), autocomplete dropdown for `/` commands
  (extension + prompt + skill + built-in list) and `@` files (fuzzy), Tab completes paths,
  `!`/`!!` shell mode, image paste (Ctrl+V) and drag-drop, Ctrl+G modal editor, Ctrl+X
  copy last assistant message, Alt+Up restores queue, Escape aborts (with confirm if
  messages queued → same restore-to-editor behavior as TUI).
- Footer: left = cwd (~-compressed) + git branch + session name; right = model + thinking
  level; middle = token stats `↑ ↓ R W CH%`, cost `$x.xxx (sub)`, context `% / window
  (auto)` with >70% warning / >90% error colors; extension statuses inline. Data from
  usage events + `get_state` + `get_session_stats` on settle, cache-hit-rate from last
  assistant message (same computation as FooterComponent).
- Slash commands: typing `/` opens the built-in command list (23 builtins + get_commands);
  builtins handled client-side (open dialogs etc.); extension/skill/prompt commands sent
  via `prompt`. `/bash`-style `!` handled by shell-mode. All builtins from the TUI list
  exist: settings, model, tree, thinking, scoped-models, export, import, share, copy,
  name, session, changelog, hotkeys, fork, clone, trust, login, logout, new, compact,
  resume, reload, quit. `quit` closes the tab after server shutdown; `reload` calls a
  `reload` command → server reloads extensions/skills/themes/keybindings and re-emits
  `connected` data.
- Dialogs: one modal layer with an Esc stack; all selectors support keyboard navigation
  (arrows/enter/escape), fuzzy search, and the TUI's per-dialog shortcut set (Ctrl+S save
  in model/thinking pickers, picker rename/delete/sort/filter keys…).
- Extension UI: `select`/`confirm`/`input`/`editor` render as modals and answer via
  `extension_ui_response`; `notify` → toast; `setStatus` → footer chip; `setWidget` →
  widget areas above/below editor; `setTitle` → `document.title`; `set_editor_text` →
  editor content; `setWorkingIndicator` custom frames honored (spinner area).
- Queue: pending steering/follow-up messages shown above the editor (same as TUI),
  `queue_update` events drive it; Escape restores them into the editor; retry countdown
  timer from `auto_retry_start` events (same countdown UI); compaction loader from
  `compaction_start`/`compaction_end`.

## 8. Feature parity matrix (checklist)

- [x] Startup header: version, context files, skills, prompt templates, extensions,
      changelog notice, trust prompt (untrusted projects), first-time setup (experimental)
- [x] Transcript: user (bg + attachments/images), assistant markdown, thinking blocks
      (collapsible, colored by level, Ctrl+T toggle, hideThinkingBlock setting), tool calls
      + results (per-tool renderers, custom tool renderers via details fallback, expand/
      collapse Ctrl+O), bash execution entries, compaction/branch summaries, custom
      extension entries, notifications/errors, cache-miss notices
- [x] Streaming: text deltas, thinking deltas, tool call arg deltas, usage ticker
- [x] Editor: multi-line, autocomplete, @file fuzzy, Tab completion, images, ! / !!,
      external editor modal, copy, queueing (steer/follow-up/dequeue), abort + restore
- [x] Footer: token/cost/cache/context stats, model + thinking, cwd/branch/name,
      extension statuses, experimental `xp` marker
- [x] Slash commands: all 23 builtins + extension/skill/prompt commands
- [x] Model switching: cycle (Ctrl+P / Shift+Ctrl+P), selector (Ctrl+L), scoped models,
      save defaults
- [x] Thinking: cycle (Shift+Tab), selector, save default, per-model levels
- [x] Sessions: new, resume picker (search/sort/filter/rename/delete), name, session
      info, fork, clone, tree navigation (fold/labels/filters/summarize), import, export
      (HTML + JSONL), share
- [x] Compaction: manual (+custom instructions), auto toggle, summary rendering
- [x] Retry: auto-retry events + countdown, abort retry
- [x] Extension UI: select/confirm/input/editor dialogs, notify, status, widgets, title,
      editor text, working indicator
- [x] Settings panel: all settings from docs/settings.md surfaced (theme, delivery modes,
      transport, compaction, retry, trust default, thinking budgets, mermaid, hide
      thinking, cache notices, quiet startup, telemetry, editor padding, autocomplete
      height, tui-mode equivalents noted as N/A)
- [x] Themes: dark/light/custom catalog, live switch
- [x] Hotkeys viewer, changelog viewer
- [x] Login/logout (API key + OAuth), trust decisions
- [x] Keybindings: TUI defaults mapped; `get_keybindings` respected for remapped actions
- [x] Quit/exit: /quit + Ctrl+D on empty editor → graceful server shutdown

## 9. Error handling

- Command errors → `{ success: false, error }` surfaces as toast + inline where the
  command originated (same messages as TUI where applicable).
- WS disconnect → full-screen reconnect overlay with countdown; auto-reconnect with
  backoff; on reconnect the client re-syncs via `get_state`+`get_messages` (and
  `connected` initial sync).
- Server crash → browser shows last-error overlay; process exit code non-zero.
- Tool errors → tool card error styling (isError), same truncation + full output path
  handling (offer download link for `fullOutputPath`).
- Extension errors → `extension_error` events render as notices.

## 10. Security

- Default loopback bind + random token (constant-time compare), 404 masking, Host/Origin
  validation, no directory traversal, static-only GET/HEAD, WS requires token.
- Token in query string is acceptable here (localhost, per-run random, process-lifetime).
  `--no-token` prints a warning; non-loopback bind requires explicit `--no-token` +
  prints a stronger warning (mirrors the repo's containerization docs stance).
- The web server never exposes filesystem reads outside commands that the TUI also has
  (`search_files` limits to cwd + gitignore).

## 11. Testing

- Server: vitest in `packages/coding-agent/test/` using the existing suite harness +
  faux provider (no real provider APIs) for: rpc-core refactor regression (all existing
  rpc commands), each new command (list/delete/rename/navigate/import/settings/themes/
  keybindings/changelog/auth/trust/search_files/share stubs), token/origin/traversal
  gating, `connected` payload.
- UI: `node --test` in `packages/web/test/` for pure modules: state store reductions,
  markdown/mermaid transform, diff word-highlight, ansi-to-html, fuzzy, footer
  formatting (port of `formatTokens` etc.).
- Bundle: add `packages/web` to the browser smoke check (esbuild `platform: "browser"`)
  to keep the UI dependency-graph browser-safe.
- Manual: scripted checklist (all slash commands, streaming, queue, dialogs).

## 12. Build & publish integration

- Root `build`: build `packages/web` (esbuild) → copy `dist` into
  `packages/coding-agent/dist/web/` before coding-agent bundle step.
- `packages/coding-agent/package.json`: `files` already includes `dist`; add `ws` dep
  (pinned exact, no lifecycle scripts → no shrinkwrap allowlist change).
- `packages/web` is `private: true` (never published), version synced via
  `scripts/sync-versions.js` (include in workspaces for lockstep).
- Docs: new `docs/web.md` (usage, flags, security notes) + changelog `[Unreleased]`
  entries for coding-agent (and a `packages/web/CHANGELOG.md` for symmetry).

## 13. Out of scope

- Multi-user remote serving, authentication against remote users (pi-protocol/server
  packages remain untouched).
- Mobile-specific layouts (responsive enough to be usable; not optimized).
- TUI extension `custom()` components: extension-provided *terminal* components cannot
  render in a browser. Web parity = the RPC degradation contract (`ctx.mode === "web"`
  behaves like `"rpc"`: dialogs work, custom() returns undefined). Documented, matching
  the existing RPC behavior contract.
