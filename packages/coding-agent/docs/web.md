# Web GUI

`pi web` serves the browser GUI for the coding agent with the same feature
surface as the interactive TUI.

```bash
pi web                  # http://127.0.0.1:4762/?token=... (opens your browser)
pi web --port 9000      # custom port
pi web --no-open        # do not open a browser
pi web --no-token       # no URL token (not recommended)
pi web --host 0.0.0.0   # expose to the network (use with care)
```

All shared startup flags apply (`--model`, `--session`, `--cwd`, `--name`, …).
`pi --mode web` is equivalent to `pi web`.

## How it works

```
browser (packages/web UI)  ←—  HTTP (static bundle) + WebSocket (JSON protocol)
        │
pi web process
  - AgentSessionRuntime (the same layer as the TUI and RPC modes)
  - RPC command core (shared with `pi --mode rpc`)
  - web parity commands (sessions, settings, themes, auth, trust, files)
```

The browser talks to the agent over a WebSocket using the RPC JSON protocol
(commands, responses, agent events, extension UI requests). One process runs
one active session; `/new`, `/resume`, `/fork`, `/clone`, and `/tree` switch
sessions in place, like the TUI.

## Security

- The server binds `127.0.0.1` by default and requires a random per-run token
  (constant-time compared) on every request, including the WebSocket upgrade.
  Wrong or missing tokens get `404` responses.
- `Host` and `Origin` headers are validated to block cross-origin requests and
  DNS rebinding.
- Static file serving is restricted to the bundled UI directory (no traversal).
- `--host` binds a non-loopback address only when you pass it explicitly; it
  prints a warning. Combine with your own TLS/VPN for remote access.
- The token travels in the URL query string. This is acceptable for localhost
  use; use a reverse proxy with authentication before exposing `pi web` to a
  network.

## Feature parity

Everything the TUI can do is available in the web GUI, mapped to web-native
equivalents:

| TUI | Web GUI |
|---|---|
| Transcript: user/assistant/tool messages, thinking blocks, diffs, images | same, rendered as HTML (markdown + syntax highlight + word-level diffs) |
| Editor: `/` commands, `@` file completion, `!`/`!!` shell, image paste/drag | same (autocomplete dropdown, clipboard paste, drag & drop) |
| Queue: Enter steer / Alt+Enter follow-up / Esc abort + restore / Alt+Up dequeue | same |
| Footer: tokens ↑↓RW, cache hit rate, cost, context %, model + thinking | same |
| Slash commands: all 23 builtins plus extension/skill/prompt commands | same (`/settings`, `/model`, `/tree`, `/thinking`, `/scoped-models`, `/export`, `/import`, `/share`, `/copy`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`, `/trust`, `/login`, `/logout`, `/new`, `/compact`, `/resume`, `/reload`, `/quit`) |
| Model/thinking cycling, selectors, saving defaults (Ctrl+S) | same (Ctrl+P / Shift+Ctrl+P / Shift+Tab / Ctrl+L) |
| Session picker: search, sort, rename, delete, named filter, scope | same |
| Session tree navigation with branch summaries | same |
| Extension UI: select/confirm/input/editor dialogs, notify, status, widgets | same via the extension UI protocol |
| Compaction, auto-retry with countdown, retry abort | same |
| Themes (dark/light/custom) | same (CSS variables generated from theme data) |
| Settings panel | same editable surface as `/settings` |
| Transcript search (fullscreen mode) | Ctrl+Shift+F find bar |
| External editor (Ctrl+G) | full-screen modal editor |
| Ctrl+Z suspend | not applicable in a browser |
| Terminal-only rendering (Kitty images, OSC 8/133) | native web equivalents |

## Extension notes

`pi web` reports `ctx.mode === "rpc"` to extensions (it behaves like RPC
mode): dialogs (`ctx.ui.select/confirm/input/editor`) work through the
browser, `notify`/`setStatus`/`setWidget`/`setTitle`/`setEditorText`/
`setWorkingIndicator` work, while terminal-only APIs (`ctx.ui.custom()`,
custom editor components, markdown transformers that render TUI components)
degrade exactly like RPC mode.

## Development

```bash
npm --prefix packages/web run build   # esbuild bundle → packages/web/dist
npm --prefix packages/web run check    # typecheck (DOM lib)
npm --prefix packages/web test         # node --test unit tests

# Serve the dev bundle without a full coding-agent build:
PI_WEB_DIST=packages/web/dist ./pi-test.sh web --no-open
```

The browser smoke check (`npm run check:browser-smoke`) bundles
`packages/web/src/main.ts` to catch Node-only imports.
