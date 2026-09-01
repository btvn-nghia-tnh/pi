# Pi Web File Preview — Design Document

Date: 2026-09-01
Status: Approved (approach, detection scope, file types, path policy, and full section-by-section design confirmed by user)

## 1. Goal

Let users preview files referenced in the web GUI transcript without leaving the page:

1. The UI detects file references in transcript text (assistant markdown, user messages,
   bash output, truncation hints) and makes them clickable, VSCode-terminal style.
2. Clicking a reference fetches the file content from the `pi web` server.
3. The content renders in a right-side preview panel that expands open and collapses closed.

## 2. Approved decisions

1. **Detection scope: whole transcript.** Tool cards (`read`/`edit`/`write`/`ls` paths),
   assistant message text, bash output, `Full output: <path>` hints, and user messages.
2. **Preview types (v1): text + images.** Text with syntax highlight and line numbers;
   images (jpg/png/gif/webp/bmp — exactly what `detectSupportedImageMimeType`
   sniffs) as data URIs; everything else shows a notice with
   basic info. PDF/video/audio are future work.
3. **Path policy: unrestricted.** Any absolute path that exists is previewable, like the
   agent's own read tool. The web token is the access boundary (same precedent as
   `search_files`, which is not trust-gated).
4. **Detection approach (approved over two alternatives):** regex extraction of path
   candidates + batch existence validation against the server (`fs.stat`), not
   always-clickable (rejected: dead links) and not file-list validation (rejected:
   cannot cover out-of-cwd paths, goes stale).
5. **Fetch mechanism: WebSocket RPC** (`read_file`), JSON with base64 for images —
   consistent with existing attachment rendering. A future HTTP file route can replace it
   without UI changes when media support expands.
6. **YAGNI for v1:** no tabs, no back/forward history, single file at a time, fixed
   panel width, no resize handle.

## 3. Architecture

```
[TranscriptView.renderItem] --(non-streaming item)--> decorateFileRefs(element)   (async)
        | regex candidates               | cache hit?                          fire-and-forget
        v                                 v
   stat_paths RPC ----> module cache: Map<absolutePath, status> (TTL 30s, pending-deduped)
        |
        v confirmed existing files wrapped as <span class="file-ref" data-path>
[user click .file-ref]
        |
        v
   store.openPreview(path, sessionId)
        |
        v
   App: connection.request({type:"read_file", path, sessionId})
        |
        v
   AppState.preview: PreviewState | undefined   ->   Store.emit()
        |
        v
   PreviewView (right column of .app-shell, expands when state present)
```

New components: `packages/web/src/file-refs.ts` (detection + decoration),
`packages/web/src/render/preview.ts` (panel). Transcript rendering itself does not
change shape — decoration runs post-render and is idempotent.

## 4. Server: two new RPC commands

Both follow the existing `search_files` pattern in `web-commands.ts`: routed per session
slot, relative paths resolved against `session.sessionManager.getCwd()` via
`resolveReadPath` from `core/tools/path-utils.ts` (which also expands `~`).

### 4.1 `stat_paths`

Request: `{ type: "stat_paths", paths: string[] }` (batch capped at 64; extra entries
silently dropped).

Response data:

```ts
{ results: Array<{ input: string; path: string; exists: boolean; kind?: "file" | "dir"; size?: number }> }
```

`input` echoes the raw candidate; `path` is the resolved absolute path. The client keeps
two maps: a persistent `raw → absolute` memo and a TTL cache `absolute → status`, so
relative and absolute spellings of the same file share one stat entry.

### 4.2 `read_file`

Request: `{ type: "read_file", path: string; offset?: number; limit?: number }` where
`offset`/`limit` are 1-based line semantics matching the read tool (offset = first line,
limit = max lines from there).

Response data, by file kind:

- Text: `{ kind: "text", text, totalLines, shownLines, truncated, truncatedBy: "lines" | "bytes" | null }`
  — reuse `core/tools/truncate.ts` (`truncateHead`, `DEFAULT_MAX_LINES` = 2000,
  `DEFAULT_MAX_BYTES` = 50KB); `offset`/`limit` slice first, then byte/line caps apply
  (same order as the read tool).
- Image: `{ kind: "image", data: base64, mimeType, size }` — mime from
  `detectSupportedImageMimeTypeFromFile` (`utils/mime.ts`); hard cap 5MB, larger files
  return `unsupported` with `reason: "too-large"`.
- Unsupported binary: `{ kind: "unsupported", size, mimeType? }` — decided by a null-byte
  probe of the first 8KB (catches every binary form, including images the sniffer
  rejects).

Errors (missing file, EACCES, is-a-directory) return the standard `rpcError` shape; the
client surfaces them in the panel.

Type additions land in `packages/coding-agent/src/modes/rpc/rpc-types.ts` (command +
response unions) and are mirrored in `packages/web/src/types.ts` (`ClientCommand` and
response payload types).

## 5. Client: detection and decoration (`src/file-refs.ts`)

### 5.1 Candidate extraction (pure, unit-tested)

`extractPathCandidates(text: string): string[]` accepts tokens that:

- are absolute (`/a/b`), `./x`, `../x`, `~/x`, or relative (`a/b.ext`, `a/b/CMakeLists.txt`), and
- contain a `/`, **or** have a known file extension (1-6 chars), **or** are a known
  extensionless file name (fixed allowlist const: Makefile, Dockerfile, LICENSE, README,
  CHANGELOG, .gitignore, .env — enumerated in tests). Leading-dot basenames count.

Exclusions: URLs (tokens preceded by `://`), CLI flags (`--x=y`), tokens inside words.
Trailing punctuation (`,.;:)"'` …) is trimmed from candidates. Only single-line,
whitespace-free tokens (no escaped-space paths in v1).

### 5.2 Decoration (thin DOM layer, not unit-tested — same policy as the existing suite)

`decorateFileRefs(element, ctx)` walks text nodes with a `TreeWalker`:

- Skips text inside `<pre>` and `<a>` (code blocks stay pristine; real links stay links).
- Inside `<code>` elements, decorates only when the element's entire text is exactly one
  candidate — this is the assistant's `` `src/app.ts` `` inline-code pattern.
- Two-phase: collect candidates not in the stat cache → one batched `stat_paths` request
  (pending-deduped) → wrap only confirmed **files** (directories are not linkified).
  Wrapping splits the text node into leading text + `<span class="file-ref"
  data-path="...">candidate</span>` + trailing text.
- Idempotent: text nodes already inside a `.file-ref` are skipped, so re-decoration after
  re-render is safe.
- Fail-closed: if `stat_paths` errors, nothing is decorated (no wrong links);
  `console.warn` only.

Applied from `TranscriptView.renderItem` for every **non-streaming** item: assistant
messages (after stream completion), user messages, bash executions. Re-renders re-run
decoration cheaply thanks to the cache. Tool-card paths (`read`/`edit`/`write`/`ls` args,
`Full output:` hints) are decorated directly without validation — they are authoritative
references (the agent just operated on them); if the file is gone, the panel shows the
error.

Stat cache: module-level, two maps — `rawToAbsolute: Map<string, string>` (persistent)
and `stat: Map<absolutePath, {kind, expires}>` (TTL 30s). `stat_paths` responses populate
both. Raw spellings that miss `rawToAbsolute` trigger one batched RPC; once resolved they
hit the shared absolute entry.

## 6. Preview panel (`src/render/preview.ts`)

### 6.1 State

```ts
interface PreviewState {
  path: string;            // raw path as clicked
  sessionId: string;       // session whose transcript was clicked (cwd for relative paths)
  status: "loading" | "ready" | "error";
  kind?: "text" | "image" | "unsupported";
  text?: string;           // accumulated text (text kind)
  imageSrc?: string;       // data URI (image kind)
  mimeType?: string;
  size?: number;
  totalLines?: number; shownLines?: number; truncated?: boolean; truncatedBy?: string;
  error?: string;
}
```

`PreviewState` lives in a dedicated app-level `PreviewStore` (`packages/web/src/preview-store.ts`),
not in the per-session `AppState`: the panel survives session switches, and transcript
views from any session drive it through `open`, `setText`, `appendText`, `setImage`,
`setUnsupported`, `setError`, `close` (same subscribe/emit pattern as `Store`).

### 6.2 Layout and DOM

`.app-preview` is appended to `.app-shell` after `.app-main` (mirrors how the multi-session
sidebar was prepended). Width `clamp(320px, 40vw, 640px)`, `border-left`, own scrolling.
Removing the preview state removes the column; the main area re-expands. Header shows
basename (full path in tooltip), kind + size badge, and a `×` close button.

### 6.3 Rendering

- **Text:** one scroll container holds a line-number gutter (`pre` with
  `"1\n2\n…"`, same line-height, generated from the line count) beside the highlighted
  code block; `white-space: pre` with horizontal scrolling like a real file viewer.
  Syntax highlight via the vendored `hljs` with an extension→language map. The whole
  block is highlighted at once so multi-line tokens do not break.
- **Image:** `<img>` with the data URI, `object-fit: contain`.
- **Truncated text:** a `Load more` button at the bottom requests `read_file` with
  `offset = shownLines + 1` (1-indexed first line) and appends the response
  (`appendPreviewText`); disappearing
  when the file end is reached.
- **Unsupported:** notice with size (and mime when known).

### 6.4 Interaction

- Clicking a `.file-ref` replaces whatever the panel currently shows (single file at a
  time). Clicking one in session X's transcript opens the preview with
  `sessionId = X`; the `read_file` request carries that sessionId explicitly (the
  connection's existing `tagCommand` passes explicit sessionIds through), so relative
  paths resolve against the right cwd. If that session has closed, absolute paths still
  work via the primary-slot fallback; relative paths error out in the panel.
- Esc: `handleEscape` closes an open preview **before** the existing queue/abort logic
  (`if (state.preview) { closePreview(); return; }`).

## 7. Error handling

| Case | Behavior |
|---|---|
| `stat_paths` fails | No decoration (fail-closed), `console.warn` |
| File deleted between validate and click | Panel error state + Retry button |
| RPC failure (disconnect mid-request) | Panel error + Retry |
| Image/binary above caps | Unsupported notice with size |
| `offset` past EOF | `rpcError` (matches read tool); panel error — only reachable if the file shrank between requests |
| Relative path, originating session closed | Panel error |

## 8. Security considerations

- Everything rides the existing token-gated WebSocket; no new HTTP surface.
- No path restriction by design (approved decision #3): the token is the boundary, and
  the agent itself reads unrestricted paths.
- Size caps bound response size (text 50KB/2000 lines per chunk, images 5MB).
- `stat_paths` batch cap (64) bounds request size.

## 9. Testing

- `packages/web/test/file-refs.test.ts` (node --test, pure functions): candidate
  extraction — absolute/`./`/`../`/`~/`/relative+extension/extensionless names; URL,
  flag, and trailing-punctuation exclusions; extension→language map.
- `packages/coding-agent/test/suite/web-commands.test.ts` (extend): `stat_paths`
  (exists/file/dir/missing/relative resolution/batch cap) and `read_file` (text
  truncation + offset paging, image base64 + mime, unsupported binary, missing file,
  directory).
- `packages/web/test/state.test.ts` (extend): preview state transitions
  (open → loading → ready, append chunk, error, close).

## 10. Files touched

Server: `packages/coding-agent/src/modes/rpc/rpc-types.ts`,
`packages/coding-agent/src/modes/web/web-commands.ts`.

Client: `packages/web/src/types.ts`, `packages/web/src/file-refs.ts` (new),
`packages/web/src/render/preview.ts` (new), `packages/web/src/state.ts`,
`packages/web/src/app.ts`, `packages/web/src/render/transcript.ts`,
`packages/web/src/render/tools.ts`, `packages/web/src/styles/main.css`.

Changelog entries under `## [Unreleased]` in both `packages/web/CHANGELOG.md` (feature)
and `packages/coding-agent/CHANGELOG.md` (new RPC commands).

## 11. Future work

- HTTP `/file?path=` route for browser-native rendering (PDF, video, audio) — panel
  already isolates the content source, so this swaps the fetch layer only.
- Resizable panel width; preview tabs / history.
- Open-in-system-editor action from the panel.
