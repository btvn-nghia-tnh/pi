# Multi-Session Web UI — Design Spec

**Date:** 2026-08-30
**Status:** Approved (design review with user)
**Branch target:** `feat/pi-web-gui` (fork `btvn-nghia-tnh/pi`)

## Problem

`pi web` serves exactly one session per server process: switching sessions
loads a different session into the same slot, and the runtime aborts any
in-flight turn when it does (`switchSession` → `teardownCurrent` →
`session.abort()`). Users who want to work on several sessions — or even
just keep a long-running turn alive while reading another session — must run
multiple `pi web` processes.

## Goals

1. **Sidebar** (left, fixed, collapsible) listing every session on disk,
   grouped by project (session cwd). Project name = `basename(cwd)`.
2. **True multi-session**: clicking a session *opens* it. Open sessions stay
   live and keep running their turns in the background while another session
   is being viewed. Multiple open sessions at once; one *active* (viewed)
   session.
3. **Running indicator**: any open session with an in-flight agent turn
   shows a spinner beside its sidebar entry — visible even while viewing a
   different session.
4. **Close session**: an explicit close action (× on the sidebar entry) force-
   closes an open session (aborts its turn, disposes the runtime, removes it
   from the registry).
5. **New session**: a `+` button creates and opens a new session in the
   server's cwd (the current project).
6. **Reload-safe**: a page reload rehydrates every open session with its
   transcript, widgets, and running state.

## Non-goals

- Prompting or steering a session *while it is not the active view* — the
  active session is the only one receiving input. Background sessions finish
  their current turn; to interact, click the session first.
- Multi-tab consensus UI (two browser tabs see the same open sessions and
  both may switch their own active view; a session closed from one tab
  disappears from the other on next event/payload).
- Sidebar session management beyond open/close/new (rename and delete stay in
  the existing sessions dialog).
- Changing the TUI, stdio RPC mode, or the VSCode pendant.

## Architecture

Chosen approach: **N × (AgentSessionRuntime + RpcCore) instances**, every
wire message tagged with a `sessionId`, a client-side session registry with
one `Store` per open session, and an active-session pointer that lives only
on the client. The single-session flow stays intact — the first session
opened at server start behaves exactly as today.

### Server — `WebSessionManager` (`packages/coding-agent/src/modes/web/web-session-manager.ts`)

A registry mapping `sessionId` → `WebSessionSlot { id, runtime, rpcCore,
sessionPath, cwd }`:

- **openSession(sessionPath)** — creates a slot for an existing session file
  (`createAgentSession` with that session's cwd), binds its own `RpcCore`
  (RpcCore is transport-agnostic; its `send` callback wraps every outgoing
  message with the slot's `sessionId` before the server broadcasts it).
- **newSession()** — creates a slot with a fresh session in the server cwd.
- **closeSession(id)** — aborts the in-flight turn, emits the session's
  shutdown events, disposes the runtime, drops the slot.
- **Lifecycle is per-server, not per-client**: a browser tab closing does not
  close sessions; a second tab connecting sees the same open sessions in its
  `connected` payload.
- Backpressure: each slot's RpcCore applies the existing backpressure hooks
  against the shared socket set.

The initial session (server start) is opened through the same manager —
`pi web` behaves exactly like today until the user opens another session.

### Protocol — session envelope

- Every **agent event** and **session-scoped command** carries a top-level
  `sessionId`. Session-scoped commands: `prompt`, `steer`, `follow_up`,
  `abort`, `bash`, `set_model`, `set_thinking_level`, `compact`, `fork`,
  `export_session`, `share_session`, `set_session_name`, …
- **Connection-level commands stay untagged**: `list_sessions`,
  `get_themes`, `set_theme`, `auth_*`, `get_keybindings`, `open_session`,
  `close_session`, `new_session`, plus the existing `extension_ui_response`
  (extended with `sessionId`).
- **New commands**:
  - `open_session { sessionPath }` → opens (or focuses, if already open) a
    session; response returns its `sessionId` and metadata.
  - `close_session { sessionId }` → closes the slot.
  - `new_session` becomes "open a new session" (adds a slot instead of
    replacing the current one). The old replace semantics remain available
    internally for other RPC hosts; only the web command handler changes.
  - The web `switch_session` command is dropped from the web handler in favor
    of `open_session` (the sessions dialog switches to open semantics too).
- **Connected payload** gains `sessions: Array<{ id, sessionPath, cwd, name,
  running }>` — one entry per open slot. `running` is computed server-side
  from the slot's agent turn state.

### Client — session registry + sidebar (`packages/web`)

- **`SessionRegistry`**: owns one `Store` per open session plus cached
  rehydration data. Incoming tagged messages route to the owning store.
  Untagged connection-level messages route as today (theme, auth, toasts).
- **Active pointer**: switching sessions swaps which store the
  transcript/editor/footer views are bound to — no server round-trip, no
  abort. Views are recreated per switch (stores keep all state; transcript
  mounts fresh).
- **Sidebar** (`src/render/sidebar.ts`):
  - Data from `list_sessions` (scope `all`) merged with open-session
    markers; groups sorted by most recently modified project, sessions by
    `modified` descending.
  - Entry visuals: open sessions get a filled marker (●) and — while an
    agent turn is in flight — a spinner glyph (⟳ animated via CSS); closed
    sessions listed with a hollow marker (○).
  - Click on a closed session → `open_session` (dialog-free); click on an
    open session → switch view. `×` on open entries → `close_session` (with
    a confirm step when that session is running).
  - `+` button → `new_session` and focus it.
  - Collapse toggle (chevron), width and collapsed state persisted in
    `localStorage` (`pi-web-sidebar-collapsed`).
- **Running state** is derived client-side from tagged agent events
  (`message_start`/`message_end`/`turn_end` per store) — the store already
  tracks `working` state; the sidebar reads it per session.

### Extension UI channels — scoped per session

`extension_ui_request` messages (widgets, statuses, dialogs, working
indicators) flow through the owning slot's RpcCore, so they are already
tagged. Client-side they land in the owning session's store. The server-side
widget cache (widget-cache.ts) becomes per-slot. Pending dialog replay (the
`pendingUiRequests` connected field) becomes per-session.

### Trust and cross-project sessions

Opening a session from another project creates it with that project's cwd and
goes through the existing per-project trust flow: an untrusted session shows
the trust dialog before its first prompt. `set_trust` stays a connection-
level command targeting the project of the supplied session.

## Data flow examples

**Open + background run.** User clicks session S2 (closed) in the sidebar →
client sends `open_session` → server opens a slot, replies with metadata →
client rehydrates S2's store from the reply (messages/state/widgets/pending
dialogs) and switches the view. User prompts S2, then clicks back to S1 while
S2's turn streams — S2's tagged events keep updating S2's store; the sidebar
spinner on S2 animates; S1's view is untouched.

**Reload.** Client reconnects → `connected` payload lists all open sessions
with running flags → client rehydrates each open session (parallel
`get_messages`/state fetches per session) → the previously active session is
restored as active (from `localStorage`), defaulting to the most recently
modified.

**Close.** User clicks × on running session S2 → confirm → `close_session` →
server aborts S2's turn, persists it, disposes the slot → sidebar removes the
● marker (S2 stays listed as a closed session from `list_sessions`).

## Edge cases

- **Two tabs, one session closed**: the other tab gets the
  session-closed tagged message and drops that session's view (active falls
  back to another open session).
- **Fork/new-session inside an active session** (via existing commands):
  forks open as new slots; the extension `newSession` command action opens
  a slot too instead of replacing.
- **Extension `switchSession`/`navigateTree` command actions** (used by the
  sessions dialog's tree): these operate on the *slot's own runtime* — they
  replace that slot's session in place, keeping the same sessionId. The
  client treats it as a session-content reset (existing rehydration flow).
- **Aborting from the wrong view**: `abort` commands are tagged; only the
  addressed session is aborted.
- **Widgets from a closed session**: the close path clears that slot's
  widget cache and broadcasts the clears.
- **Backpressure**: per-slot output buffering as today; the broadcast layer
  is unchanged.

## Testing

**Unit** (vitest, packages/coding-agent):
- `web-session-manager`: open/new/close lifecycle, event tagging,
  per-slot widget-cache isolation, close-with-running-turn aborts and
  persists, connected payload lists slots with running flags.

**Client tests** (packages/web/test):
- SessionRegistry routing: tagged events land in the right store; untagged
  as today.
- Sidebar grouping/sorting/markers/spinner derivation; collapse persistence.

**E2E** (headless chromium, existing harness):
1. Open session A, start a long turn, switch to session B, A's sidebar entry
   spins; return to A → result present and correct.
2. Open session B from the sidebar while A runs; prompt B; both transcripts
   independent (no cross-talk in widgets: todo/mcp widgets per session).
3. Close a running session → aborted + persisted; sidebar reflects it.
4. Reload mid-run → all sessions rehydrated, running flags correct, active
   session restored.
5. Session from a different project opens and hits the trust dialog.

## Implementation phases

1. **Phase 1 — foundations**: `WebSessionManager`, envelope (`sessionId`
   tagging), `open_session`/`close_session`, client `SessionRegistry` +
   store-per-session, rehydration per session. Switching via the existing
   sessions dialog.
2. **Phase 2 — sidebar**: sidebar component, grouping, markers, spinner,
   close buttons, collapse persistence, `+` new session.
3. **Phase 3 — polish**: cross-project trust flow, fork-as-slot, backpressure
   verification, full E2E suite, docs update (`packages/coding-agent/docs/web.md`).
