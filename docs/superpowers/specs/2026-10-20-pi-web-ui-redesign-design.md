# pi web UI redesign — professional multi-page console

**Date:** 2026-10-20 · **Status:** Approved (mockups reviewed) · **Branch:** `feat/pi-web-gui`
**Mockups:** `docs/superpowers/mockups/pi-web-ui/` (open `index.html`; 8 SVGs — 00 shell … 07 mobile)

## 1 · Context & complaints being fixed

The current web GUI (`packages/web`) is a single page: sidebar + transcript + text footer; everything else lives in modal dialogs. User complaints, each mapped to a fix:

| Complaint | Fix in this design |
| --- | --- |
| "gom chung hết 1 trang", "tạm bợ" | 6-page IDE console with icon rail + hash router (§3) |
| "quản lí project rõ ràng" | Projects page: per-cwd stats, session table, multi-select actions, context files (§3.3) |
| "Hỗ trợ đổi model" | Model popover in editor chips, session details panel, quick-cycle keys; same for thinking level (§3.2.4) |
| "quản lí MCP rõ ràng chỉn chu" | MCP page: stat tiles, server cards with enable/disable switches, sign-in, tool catalog with per-tool toggles (§3.4) |
| "Log token usage rõ ràng, không mớ ký tự lạ ANSI" | 3-tier usage: status-bar context bar + per-message usage rows + Usage dashboard; all extension statuses ANSI-parsed to chips (§4) |
| "button stop các thứ đầy đủ" | Primary Stop↔Send, per-tool stop (bash), retry Cancel, queue management, compaction control (§5) |

## 2 · Confirmed decisions (from user review)

- Layout: **IDE-style left rail**; chat is the centerpiece but every domain has a page.
- Visual: **dark pro** — bg `#0D1117`, surface `#161B22`, raised `#1F2630`, hairline `#2D333B`, text `#E6EDF3` / `#8B949E`, accent teal `#2DD4BF`, ok `#3FB950`, warn `#D29922`, danger `#F85149`, chart-blue `#58A6FF`.
- Pages: **Home, Chat, Projects, MCP, Usage, Settings**.
- MCP: **full control** (with graceful degradation — §6.2).
- Usage: **3 tiers** (§4).
- Devices: **desktop + mobile responsive** (§3.7).
- Tech: **Approach 1** — keep vanilla TS + `Store`, add Router + design tokens; reuse transcript/editor/connection/preview code. No frameworks, no new runtime deps.

## 3 · Information architecture

### 3.1 Shell & routing

- `Router` (hash-based): `#/home` · `#/chat` · `#/chat/<sessionId>` · `#/projects` · `#/projects/<encodedCwd>` · `#/mcp` · `#/usage` · `#/settings/<section>`. Unknown → `#/home`. Deep links drive the UI (e.g. click "resume" in Usage opens `#/chat/<id>`).
- Shell: `[ rail 52px | page header | page content ]` + on Chat: `[ session list 264px | transcript+editor | right panel 320px ]`.
- Rail icons: `⌂ home · 💬 chat · 📁 projects · 🔌 mcp · 📊 usage · ⚙ settings`; bottom: gear + version. Active page = accent pill behind icon. Running badge (count of running sessions) on chat icon.
- Right panel is collapsible (persisted in localStorage like sidebar state today).

### 3.2 Chat page (`#/chat`, default landing after startup)

Reuses existing `TranscriptView`, `EditorController`, preview store, widgets. Restyle + extend:

#### 3.2.1 Session list (left column)
- Search box, `[+ New chat]` (accent ghost), groups by project cwd (sticky headers, collapsible, persisted expanded-groups), rows: name, meta (relative time · msg count · running spinner), active row = accent left bar + raised bg, close button for open slots on hover. Reload row at bottom. Same handlers as today's `SidebarView`.

#### 3.2.2 Transcript
- User message: full-width card, hairline border, 3px accent left rail, `YOU` chip + timestamp (+ `edited`).
- Assistant text: rendered markdown (existing), header chip `ASSISTANT · <model> · time`.
- Thinking: collapsed row "Thought for Ns ▸" (expandable, existing pattern).
- **Tool cards** (restyled existing renderer): header (mono tool name, summarized args, right side status). Status: `running Ns` (warn, animated), `✓ Ns` (ok), `✗` (danger). **Per-tool `[■ stop]` shown only for bash tools while running** (sends `abort_bash` with the tool call id) — the existing protocol only supports aborting bash; other tools get no fake buttons.
- **Per-message usage row** under each completed assistant message (collapse raw detail into one dim line): `⌁ ↑in ↓out · R cache-read · W cache-write · $cost` + context delta; hover/click expands to full usage card (per-component values + cache hit rate). Data source: per-message `usage` already present in the transcript protocol.

#### 3.2.3 Control stack (between transcript and editor)
- Queue chips: each queued steering/follow-up as a chip with `×` (maps to `clear_queue` semantics per index, as today's QueueView).
- Retry banner: warn-tinted row, `Retrying (i/n) in Ns — <short error>` + `[Cancel]` → `abort_retry`.
- Compaction notice: info row `Compacting context…`.
- Steering/follow-up mode: chip in editor toolbar (see below), not a separate banner.

#### 3.2.4 Editor dock
- Card: attach button, textarea (existing editor), then toolbar row: `[model ▾] [think ▾] [auto-compact chip] [steering mode ▾]` + right `[＋ queue] [Send ▶]`.
- **Send ↔ Stop**: while idle/queued → `Send` (accent); while agent running → `Stop` (danger, sends `abort`). If retry pending, Stop = `abort_retry`. `＋ queue` visible while running (adds steering/follow_up per current steering mode).
- Popovers: model picker (searchable list from `get_available_models`, grouped by provider, shows authenticated state; select → `set_model`), thinking picker (`get_available_thinking_levels` → `set_thinking_level`), steering/follow-up pickers (`set_steering_mode` / `set_follow_up_mode`), auto-compact toggle (`set_auto_compaction`).
- Keyboard: existing shortcuts kept; `⌘K`/`Ctrl+K` opens model picker.

#### 3.2.5 Status bar (bottom, 32px, mono)
- Left: `cwd` chip · branch chip · session name (dim).
- Center: **context usage bar** — track w/ fill colored ok/warn(>70%)/danger(>90%); label `<pct>% of <window> (auto on/off)`; click → compaction popover (compact now → `compact`, toggle auto).
- Right: `$cost (today) · ↑in ↓out · R hit%` + current model·thinking chip (click = model picker).
- **No ANSI ever rendered raw** (§4.2).

#### 3.2.6 Right panel (per session)
- Session details card: model, thinking, branch, auto-compaction state, trust, fork/parent info — actions proxied to existing commands.
- Widget cards: `renderWidget` (existing `widget-data.ts` kinds: todo, mcp-status, …) rendered as cards here; messaging above/below editor is deprecated for structured widgets (string-lines widgets keep old placement under editor until migrated).
- Usage—today card: cost, tokens, 10-point sparkline (session-local, from store's usage data), link → `#/usage`.
- Extension statuses card: one chip per status (§4.2).

### 3.3 Projects page (`#/projects`)
- Left: search + project list (from `list_sessions` scope=all grouped by cwd): name, dim path, meta (session count · last activity), running count badge. Active project raised.
- Detail: header (folder icon, name, mono path, chips: branch (primary slot cwd), trusted), 4 stat tiles (sessions, messages, spent, last activity — per-project aggregation from session summaries + usage scan §6.1), session table: `SESSION | MESSAGES | CTX | COST | MODIFIED | ⋯`. Context column = last context % recorded in session file; cost from usage scan.
- Multi-select checkboxes → contextual action bar: `Rename` (`rename_session`), `Fork` (`fork` on open slot / open+fork), `Export HTML` (`export_html`), `Share` (`share_session`), `Delete` (`delete_session`, confirm modal; multi-delete like current multi-select deletion).
- `[＋ New session in <project>]` primary action.
- Context files card: from `get_context_info` of a slot in that project (or primary when absent): file rows with source chip (global/parent/project/override) + "edit on disk" reveal (opens `read_file` preview at path).

### 3.4 MCP page (`#/mcp`)
- Stat tiles: servers (x enabled), connected now, tools (active/total), attention (needs-auth/failed counts).
- Server cards: name, transport chip (stdio/http), status pill (connected / needs-auth / failed+backoff-left / disabled), meta line (tools · resources · up-since or last-failure), actions:
  - `[Reconnect]` → `widget_response` `{action:"reconnect", server}` (§6.2).
  - Enable/disable switch → `{action:"set-enabled", server, value}`.
  - `[Sign in]` (needs-auth only, accent) → `{action:"start-auth", server}`. Adapter-driven auth dialogs already flow over `extension_ui_request → auth_*`, rendered as before.
  - `[⋯]` → open config file in preview/read-only editor hint.
- Tool catalog (expandable per server): tool rows with checkbox (visibility toggle → `set-tool-visible` action), mono name, one-line description. Server-owned tools render read-only badge.
- Data sources: `pi-mcp-status` widget data (already includes servers, statuses, tool/resource counts, failure info) + `get_tools` for active names. Control channel: §6.2.

### 3.5 Usage page (`#/usage`)
- Filters: range chips (Today / 7d / 30d / All) + selects (model, project).
- Stat cards: cost (delta vs previous period), sessions, tokens in (with cache-read), tokens out (cache-write + hit rate).
- Charts (SVG): per-day stacked bars (input accent / output blue / cache gray) with hover tooltip (CSS-only in v1); model breakdown rows with % bars; sessions table (session, project, model, tokens, cost, last active, → open in Chat link) + totals footer.
- Backend: new `get_usage_summary` command (§6.1).

### 3.6 Settings page (`#/settings/<section>`)
Sections (left nav): General · Models · Appearance · Keybindings · MCP & Integrations · Accounts & Auth · Trust & Security · About & Changelog.
- General: auto-compaction, auto-retry (+ attempts), steering mode, follow-up mode, experimental flag — per-session live state now; persisted defaults via `get_settings`/`set_settings`.
- Models: default model/thinking picker (writes to settings), authenticated providers list (`auth_status`), per-project overrides list (read from settings tree, v1 read-only).
- Appearance: theme cards from `get_themes` → `set_theme`; compact/comfortable density toggle (localStorage).
- Keybindings: `get_keybindings` rendered as rows with kbd chips (read-only v1).
- MCP & Integrations: shortcuts to `#/mcp` + extension list from `get_context_info.extensions`.
- Accounts & Auth: `auth_status`, login/logout buttons (`auth_login`/`auth_logout`).
- Trust & Security: `get_trust` current state; trust toggle (`set_trust`), explanation panel.
- About: version, changelog (`get_changelog` rendered markdown), data dir chip.

### 3.7 Mobile (<768px; tablet 768–1279 keeps side rail, drops right panel)
- Rail → bottom tab bar (6 items, running badge on Chats).
- Session list & project list → left drawer with scrim over chat (hamburger in page header).
- Dialogs → bottom sheets (85% height, grip bar; the existing `DialogStack` gains a sheet variant).
- Model/thinking pickers → action-sheet lists.
- Status bar → collapses to a single context chip in Chat header.
- Editor dock sticky bottom; Send↔Stop keeps identical semantics.

## 4 · Usage & ANSI cleanliness (the "⌁ tier")

### 4.1 Data
- Per-turn usage: assistant/tool messages already carry `usage` in the transcript protocol — surfaced in status bar + per-message rows, no backend change.
- Session/cross-session aggregates: new backend command (§6.1); UI polls when Usage or Home opens and on window focus when range=today.

### 4.2 ANSI handling
- `footer-stats` compact text stays for nothing — the old one-line footer is removed.
- All status strings entering the UI pass through a new `sanitizeStatusText()`: parses SGR sequences with the existing `ansi.ts` conversion (reuse its span mapping) into: plain text + accent-color intent map; pills/chips render with token colors instead of raw RGB; unknown control sequences are stripped (never printed). Applied to `extensionStatuses` and any widget `lines` text.
- The right-panel "Extension statuses" card and status bar chips are the only sanctioned status surfaces.

## 5 · Run controls (the "■ tier")

| Control | Sends | Visible when |
| --- | --- | --- |
| Send / Stop (primary) | `prompt` / `abort` (`abort_retry` if retry pending) | idle / running |
| Per-tool stop on bash card | `abort_bash { toolCallId }` | that bash call running |
| Retry banner Cancel | `abort_retry` | retry countdown active |
| Queue + | `steer` or `follow_up` per mode | running |
| Queue chip × | queue removal (existing) | queued items exist |
| Compact now / toggle auto | `compact` / `set_auto_compaction` | context popover |
| Fork session | `fork` | session menu |

## 6 · Backend additions (coding-agent / server)

### 6.1 `get_usage_summary` (web-commands, runs on primary slot or any slot + global scanner)
Request: `{ rangeDays?: 1|7|30|0(all), projectPath?: string, model?: string }`.
Implementation: scan `~/.pi/agent/sessions/**/*.jsonl` filtered by mtime ≥ cutoff (skip per-project filter via path slug mapping), parse `role:"assistant"` records' `usage` (input/output/cacheRead/cacheWrite/cost.total) + model id; merge with in-memory open slots (they may differ from disk until checkpoint); aggregate: totals, per-day, per-model, per-session rows (id, file, cwd, model, tokens, cost, lastActive, messageCount, contextLastPct when cheaply parseable from last user message window usage record).
Response cached in-process for 30s keyed by request. Error-file entries are skipped and counted (`skipped`), never fatal.

### 6.2 MCP control channel — `widget_response` + degradation matrix
- UI sends, key `"pi-mcp-status"`, payload: `{action:"set-enabled"|"reconnect"|"start-auth", server, value?}` and per-tool `{action:"set-tool-visible", server, tool, value}`.
- `RpcCore.dispatchWidgetResponse` → adapter's `pi.ui.onWidgetResponse("pi-mcp-status", …)` when the installed pi-mcp-adapter version registers it.
- `delivered:false` (adapter not yet supporting) → UI degrades per action: **set-enabled** falls back to `mcp_config_write` — new web command that edits `disabled` flags in the standard `.mcp.json` (project) or global mcp config via safe JSON read/merge/write + shows "applies on next session start"; **reconnect** falls back to the same notice; **start-auth** opens the config/background hint and instructs `/mcp-auth` in-chat fallback. Buttons never disappear silently; a one-line banner on the MCP page states the deprecation level.
- No new runtime deps; `.mcp.json` writer lives in coding-agent using plain fs + existing config conventions (discovery order per pi-mcp-adapter docs: global → project override).
- **Tool visibility** stays v2 (needs adapter opt-in); v1 renders checks read-only with a "adapter upgrade required" tooltip. (This is the one place we accept degradation to stay honest with the user's "full control" ask; everything else is fully wired.)

### 6.3 Protocol notes
- New client commands are added to `rpc-types.ts` (union members) + typed handlers in `packages/coding-agent/src/modes/web/web-commands.ts`; keep the strict `type:` discriminated unions and response result types.
- `get_tools` response gains optional `server?: string` source metadata if present in tool sourceInfo (backwards-compatible optional field).

## 7 · Frontend architecture (packages/web)

### 7.1 File map (new code)
```
src/router.ts               — hash router + deep links + page switch
src/shell.ts                — rail + page header + running badge
src/pages/home.ts           — Home
src/pages/chat.ts           — chat workbench composition
src/pages/projects.ts
src/pages/mcp.ts
src/pages/usage.ts
src/pages/settings.ts
src/components/{rail,chips,buttons,cards,popover,toggle,progress,sparkline,
               table,tabs,drawer,sheet,statustext}.ts   — small typed view factories
src/ansi-clean.ts           — sanitizeStatusText()
src/usage-client.ts         — get_usage_summary projection helpers
src/styles/tokens.css       — CSS variables (palette, spacing, radius, type)
src/styles/{components,pages}.css  — new sections
```
- Existing `app.ts` stays as the bootstrapper and now: builds shell, mounts Router, keeps multi-session store wiring; `dialogs.ts` shrinks as pages absorb content (model/settings/theme dialogs become pages/popovers; trust dialog stays until Settings section lands).
- `main.css` keeps transcript/message styling, gradually re-based on tokens. No CSS-in-JS, no preprocessor — plain files copied by `build.mjs` (update it to copy `styles/*.css` and concat in import order).
- Views follow the existing pattern: class with `mount()/unmount()` + `Store.subscribe`, typed `h()` DOM. Components are leaf factories returning elements with event hooks; no state in components (stores only).

### 7.2 State
- No global redux-like state. Each page subscribes to its session store subset plus its own fetch-cache (`Map` + promise dedupe) for page-scoped data (usage summary, session lists) refreshed on focus/route-enter.
- Router switching unmounts page views (existing `unmount()` hygiene) and preserves chat page state in `sessionStores` as today.

### 7.3 Store extensions (`state.ts`, additive)
- `dailyUsage` per session store (accumulated cost/tokens for sparkline; prune by session age).
- `mcpWidget` passthrough already exists in widget cache — expose a typed projector `McpProjector` mapping widget data → server cards.

## 8 · Testing

- Unit (node --test, existing harness in `packages/web/test`):
  - router: hash parse/serialize, unknown route fallback, deep-link round-trip;
  - `sanitizeStatusText`: SGR → tokens/strips, real-world sample `?/1.0M (auto)Ⓜ build🔌 MCP…` fixtures;
  - usage formatting/deltas; aggregation edge cases (no files, malformed lines, empty usage);
  - components: popover focus/cycle, tab bar active state, toggle state classes.
- Backend (`packages/coding-agent/test/suite`): `get_usage_summary` with fixture session JSONLs (range/project/model filters + malformed line skipping); `mcp_config_write` round-trip (safe merge, disabled flags, CRLF/UTF-8 preserved where JSON allows); `widget_response` dispatch false-path.
- Existing checks must stay green: `npm run check` (biome+tsgo), `npm run test`, `scripts/check-browser-smoke.mjs` extended to boot the shell and assert each page route renders placeholder→real content (smoke-level DOM assertions only).

## 9 · Rollout slices (each buildable & green independently)

1. Tokens + components + shell/rail + router + page skeletons; old UI reachable at legacy hash `#/chat` during slice 2-3 dev (then removed).
2. Chat restyle: message cards, tool cards + per-bash stop, queue/banners, editor toolbar popovers (model/think/steering), new status bar + ANSI sanitizer (delete old footer).
3. Session list column + right panel (session details, widgets as cards, usage mini, ext-status chips).
4. Projects page (+ multi-select actions).
5. MCP page read path + `widget_response` control + `.mcp.json` writer fallback + degradation banners.
6. `get_usage_summary` backend + Usage page.
7. Home page (composed of commands from 4-6).
8. Settings page + retire absorbed dialogs.
9. Mobile pass: tab bar, drawer, sheets, responsive polish + smoke tests.

## 10 · Errors & degradation matrix
| Failure | UX |
| --- | --- |
| WS disconnects | existing reconnect overlay (unchanged) |
| page fetch command fails | inline card error + retry button |
| usage scan partial | stat cards show `~` prefix + tooltip skipped-count |
| adapter without onWidgetResponse | MCP controls degrade per §6.2 with visible reason |
| unauthenticated model selected in popover | row marked; on send failure the existing auth dialog path opens |
| settings write fails | toast + revert toggle |

## 11 · Non-goals
- No framework, no build-tool change, no new runtime deps, no bundler.
- No backend protocol rewrite (v1 additions only).
- No collaboration/multi-user features; no cloud sync.
- Transcript renderer internals (message rendering, file previews, markdown) are restyled only where mockups show changes.
- Tool visibility muting for MCP stays read-only v1 (§6.2).

## 12 · Open items (resolve in plan, no user input needed)
- Exact spacing/name glow for running badges (mockup intent is sufficient).
- Whether `Context` column on Projects table is hidden until first usage scan lands data (column is nullable).
