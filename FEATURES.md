# Roamgate Features

A Web/PWA client for a running [Herdr](https://herdr.dev) server.
[Install](./docs/DEPLOYMENT.md) · [Tutorial](./docs/TUTORIAL.md) ·
[Keyboard shortcuts](#keyboard-shortcuts)

## Workspace, Tab, and Pane Navigation

- Create, rename, pin, switch, and close workspaces/tabs. Linked Git worktrees
  group under their repository; pins and collapsed groups stay in this browser.
- Split right/down, resize, focus neighbors, zoom, or close panes.
- Search workspaces, worktrees, files, tabs, panes, and agents in the command
  menu. Enter a relative/absolute path to open a file.
- Desktop **Zen mode** hides app chrome and runs the terminal flush to every
  edge. Hover **Exit Zen** at the top to pull the topbar back, or click it to
  leave; the sidebar restores its previous state on exit.

Endpoint connections use **Local navigation** per browser/connection; legacy
connections use **Shared navigation**. Reconnect preserves selections; reload
starts from Herdr's selection. Same-tab pane focus, topology, and terminal sizes
remain shared. Creation preserves Herdr's cwd policy and requires a connected
source terminal, except for the first workspace in an empty session.
See [compatibility](docs/DEPLOYMENT.md#herdr-compatibility).

### Recent Pane Switcher

Switch across tabs/workspaces using the 12 most recently focused live panes plus
the current layout. Use Up/Down; release the opening modifier or press Enter to
switch, Esc to cancel. On macOS, hold Ctrl and repeat Tab (Shift reverses).
Entries show workspace, tab, pane ID, cwd, and agent status; closed panes leave
history. Press K while the switcher is open to start searching, even while
holding the opening modifiers (and Shift when cycling backwards).

### Pane Search

`Alt+K` opens the same switcher in search mode over **every** live pane, not
just recent ones, so a pane never visited stays reachable. Filter on workspace,
tab, cwd, or agent name/status; terms match in any order, all must match, and
results keep their recent-first order. Up/Down or Tab/Shift+Tab move, Enter
switches, `Alt+K` or Esc closes. Search never commits on a modifier release, so
it stays open while typing. K (including with the opening modifiers held) or
`Alt+K` inside the recent switcher converts it in place without opening the
command menu. The current pane stays listed for context, but selection starts on
the first pane a jump can reach.

## Full Browser Terminal

- Server-rendered terminals support normal input, modified Enter, macOS editing
  keys, multiline paste, IME, and CJK punctuation.
- Scroll by wheel, trackpad, touch, or explicit half-page history shortcuts.
  Full page keys route to terminal apps or Herdr history; unavailable endpoint
  history controls explain missing support.
- Mouse-aware apps receive pane-local clicks/drags/wheels. Select browser text
  with Option-drag (macOS) or Shift-drag (elsewhere); ordinary output needs no
  modifier. Selection freezes presentation until cleared. Desktop edge-drag
  captures offscreen rows; release, blur, or changed content stops scrolling.
- Paste images to upload them to the connected host and insert their paths.
  OSC 52 clipboard writes follow Herdr's foreground recipient, not proven source
  pane ownership; see [clipboard limits](docs/DEPLOYMENT.md#herdr-compatibility).
- `Cmd/Ctrl`-click HTTP(S) links to open a browser tab; file/directory paths,
  including Windows drive and backslash paths, open preview/workspace actions.
  Touch uses long-press, then **Open link** or
  **File actions**. Nothing opens on hover or ordinary touch.

Herdr 0.9.1 supports read-only wrapped-link resolution; OSC 8 keeps explicit
full destinations. Viewport-clipped plain URLs cannot be recovered safely.
Older servers retain local URL/path detection; legacy touch lacks explicit OSC 8
metadata. See [link contracts](docs/ARCHITECTURE.md#links).

## Workspace Inspector

Open **Files**, **Changes**, or **Agent History** from the Inspector button,
keyboard shortcuts, or workspace/agent menus.

- Dock right/bottom, resize, or expand without unmounting terminals. Narrow
  layouts use drill-down/overlay views; Esc dismisses transient UI, not Inspector.
- Tab switches keep Inspector open; workspace switches restore checkout-scoped
  selection/layout. Files and Changes save separate widths. Closing returns to
  the originating tab if it still exists.
- Agent browsing starts at its cwd only inside the checkout. Terminal links use
  their pane's workspace. Changes describe the checkout, not agent ownership.
- Closed worktrees must open before browsing; missing ones offer cleanup, never
  sibling files. Directory previews can prefill **New workspace**.

Inspector and Annotations leave the sidebar unchanged. Preview is read-only;
[resource ownership](docs/ARCHITECTURE.md#workspace-resource-ownership) prevents
cross-worktree state mixing.

## Agent Awareness and Session Inspection

- See recognized agents and working/blocked/done/idle status; focus their panes
  from the tree, switcher, command menu, Agent panel, or notifications.
- Choose nested agents, **Agents: Separate**, or **Agents: Compact**. Separate
  supports attention-first, workspace/manual ordering, grouping, and dragging
  in ungrouped manual mode. Idle recency uses session-file activity, falling
  back to Herdr state changes. Preferences are browser-local; manual order is
  per connection.
- **Agent History** has User/Agent/Tool filters, loaded-text search, a minimap,
  and on-demand tool details. Its recent window is 200 conversation entries plus associated tools;
  exports stay complete. **Session Inspector** adds metadata, Timeline,
  searchable ATIF/raw transcripts, and original/normalized export.
- **Menu > Configuration > Integrations** installs, updates, or uninstalls
  Herdr's bundled integrations with confirmation, not agent applications.
  Changes affect the connected server user across sessions, including SSH.
  Restart agent sessions if reporting has not started. Version metadata uses
  Herdr's API with a same-host CLI fallback; “available” means bundled, not an
  online release. See [integration version lookup](docs/ARCHITECTURE.md#agent-integrations).

Session inspection supports **Codex, Claude, Kimi, Grok Build, Pi, Muse Code,
and Antigravity CLI** with readable records. Missing metadata shows integration
guidance where an integration is available. Muse uses the newest retained session
matching the foreground working directory under
`$XDG_DATA_HOME/muse/sessions` (default `~/.local/share/muse/sessions`), or a
Herdr-reported session ID/path. Start Muse without `--no-session-log` to retain
transcripts; sessions in the same directory require an explicit ID/path to
distinguish them reliably. SSH reads Herdr-reported paths and Pi ID lookups
remotely; Muse requires a reported path over SSH and never searches local files
for a remote pane. Other ID/directory fallbacks remain local and require
accessible transcripts. Muse token totals use per-run provider routing; when a
cached-token convention is unknown, totals show `-` rather than an estimate.
See [History synchronization](docs/HISTORY.md).

## Git Worktree Lifecycle

Open **Worktree Lifecycle** from a workspace menu or the command menu to:

- Create a linked worktree from `origin`'s freshly fetched default branch,
  without changing the source branch or dirty files; discover/open existing
  worktrees. The default branch is queried from the remote, not cached `origin/HEAD`;
  an unavailable remote or unresolved default branch stops creation.
- Inspect paths, open/closed state, branch status, and uncommitted counts.
- Focus, pull, configure branch updates, or remove with confirmation, hooks,
  process cleanup, and preservation of residual files when safe removal fails.

Worktree creation and automatic branch updates fetch the advertised default
commit by its object ID without rewriting remote-tracking refs or `FETCH_HEAD`.
Stale tracking-ref names do not block creation or sync, and both operations use
the resolved commit rather than a ref that another fetch could change.

### Paseo Worktree Hooks

`paseo.json` supports `setup`, `opened`, `teardown`, and `removed` hooks.
**Hooks are enabled by default and execute trusted, unsandboxed repository code**
on the connected host. Review them or disable them under **Worktree hooks** /
**Worktree Lifecycle** before acting. Failed teardown stops removal; other hook
failures do not undo completed operations.
See [configuration and variables](docs/DEPLOYMENT.md#worktree-hooks).

### Automatic Branch Updates

Opt in per checkout through workspace menus, Worktree Lifecycle, or
**Configuration > Connection > Automatic branch updates**. Updates fetch and
merge `origin`'s default branch every 10 minutes by default, only while the
workspace is open in that connection. Each update queries the remote's current
default branch; if it cannot be resolved or fetched, the update fails without
merging. Updates skip dirty/detached checkouts, recheck branch/HEAD and worktree
after fetch, and abort conflicts. They never push.

## File Explorer and Preview

- Browse cached trees, toggle hidden files, and filter **loaded** names/paths
  with case-insensitive substrings or globs (`*`, `?`, `[]`, `{}`, `**`).
  Git badges mark changes; ignored files are dimmed.
- **Browse filesystem** opts into read-only host browsing outside the checkout.
  Parent/absolute-path navigation allows preview, copy path, and download.
  **Workspace only** restores the tree; refresh or checkout/connection changes
  reset this mode.
- Text previews provide highlighting, line numbers, search, and refresh.
  Markdown has a Preview/Source switch with the active mode highlighted;
  Mermaid fences and `.mmd`/`.mermaid` files
  have zoomable diagrams and source views. Markdown links navigate within
  Inspector; external links open a browser tab.
- Workspace `.html`/`.htm` files open in Preview mode with a Preview/Source switch.
  Static previews support workspace CSS, images, and fonts, including relative
  CSS imports, plus HTTPS CDN stylesheets. Scripts, external images and external
  fonts are blocked; HTML source is limited to 512 KiB. Files outside the workspace
  remain available as source or downloads.
- Preview images (including SVG), PDFs, and local Markdown images with zoom/Fit.
  Unsupported binaries are download-only; decoding depends on the browser.
- Upload by dragging onto a checkout directory; download files or workspace
  `.tar.gz` directories; copy paths or delete with confirmation via right-click
  or long-press. Upload/delete stay checkout-scoped. Operations work over SSH.
- With [host file reveal enabled](docs/DEPLOYMENT.md#host-file-reveal), local
  profiles over loopback offer **Reveal on host** and **Open folder on host**
  in explorer and Changes menus. These open the Roamgate host's desktop, not
  necessarily the browser's: files are selected in Finder/File Explorer;
  Linux opens their containing folder. Changes uses the nearest existing
  ancestor for deleted paths, including removed directories. Disabled by
  default; SSH profiles and non-loopback peers are refused.
- Drag a file or folder from the tree with the mouse to insert its absolute path
  into the active terminal pane or the terminal composer.

## Review Annotations

Open **Annotations** independently of Inspector. Desktop supports floating or
pinned layouts; mobile has a dedicated touch surface.

1. Comment on diff line numbers, source gutters, rendered Markdown selections,
   or selected terminal text using **Add comment**.
2. Edit/reorder checkout-scoped comments, then copy feedback or pre-fill a chosen
   agent pane. **Delivery never submits**: review and press Enter manually.
3. Use **Go to agent** after pre-fill. Copy retains drafts; successful pre-fill
   removes only unchanged delivered comments. Failed delivery, concurrent edits,
   or leaving the workspace/connection preserves the original draft.

With focus inside Annotations, use the configurable shortcuts shown on **Copy**
and **Pre-fill agent**. Copy confirms success with a brief notification.
Drafts stay in this browser and survive panel closure. Blank comments cannot be
sent. Refresh re-anchors matching file/diff content and marks unresolved anchors
stale without losing quotes. Terminal quotes are not re-anchored; missing panes
are marked unavailable.

## Diff Viewer

- Review **Working tree**, **Against main**, or **Last step** (the latest completed
  activity snapshot, not proof of agent ownership). See staged, unstaged,
  untracked, conflict, and branch-diff badges with added/deleted counts.
- Use side-by-side/unified desktop views; mobile is unified. Search and syntax
  highlighting work across diffs; images have previews. Large, truncated, and
  generated diffs start collapsed.
- File/folder context menus offer open, copy path, stage, unstage, mark resolved,
  discard unstaged, and delete untracked, plus repository-wide bulk actions.
  Destructive actions require confirmation. Status/content is rechecked to reject
  stale menus instead of destroying newer work.

Scope, view, wrapping, and selection persist per checkout/browser; wrapping is
separate for desktop/mobile. Jump from a diff to its file preview.

## Mobile and PWA

- **Configuration > Appearance > Layout** selects Automatic/Mobile/Desktop.
  Automatic defaults to 768 CSS px (adjustable 320–2560); `?layout=mobile`,
  `desktop`, or `auto` overrides saved mode until a menu choice clears it.
  Agent/workspace panel order is saved separately for each layout.
- Touch reads output without opening the keyboard. Use **Open device keyboard**
  to type; a light terminal tap dismisses it without input. Long-press selects
  text for **Copy**, **Add comment**, or link actions; **Done**/Esc exits.
  Scroll first to select older output. Selection freezes the displayed frame,
  not the connection; legacy streams resume at a 1 MiB buffered UTF-16 limit.
- Customize the floating `2×8` grid and up to four side buttons under
  **Configuration > Behavior > Mobile terminal shortcuts**. The Tabs sheet and
  pane controls work when the tab strip is hidden.
- Drag the `⋯` controls button to move the floating controls; release snaps
  them to the nearer side edge at that height, mirrored on the left. The
  position is kept per browser and stays clear of the header and tab strip.
- The composer supports IME, dictation, multiline text, and images. **Insert**
  does not execute; **Send** adds one Enter. Drafts are in-memory per
  connection/pane; closing their pane/tab/workspace asks before discarding.
- Install as a PWA for an app window; a bundled Nerd Font supplies terminal
  icons. **PWA is not offline access**: Roamgate must remain reachable.
  See [installation steps](README.md#install-as-a-pwa).

## Remote, Multi-Client, and Operations

- Shared local/SSH profiles have independent browser selection. Disconnecting
  does not stop Herdr. SSH forwarding requires Linux/macOS; Windows supports
  native local profiles. [Connection setup](docs/DEPLOYMENT.md#multiple-and-remote-herdr-connections).
- Browsers receive pushed events; inspect client counts or pause/resume clients.
  **Configuration > Behavior > Task notifications** independently enables
  input-required/completed alerts, following Herdr's own notification decisions
  by default. **Background push** works without an active page; **Active page
  only** does not. Delivery is best-effort.
  [Web Push setup and revocation](docs/DEPLOYMENT.md#web-push-notifications).
- Choose light/dark/system appearance, accents, and interface scale (80%–150%).
  **Configuration > Appearance > Terminal** groups the terminal font, font size
  (70%–200%, scaling terminal text without resizing the rest of the interface),
  and built-in/custom terminal themes. The font can be any family installed on
  the viewing device; Chromium browsers can list installed fonts, and missing
  glyphs fall back to the default terminal fonts. Preferences stay in this browser.
- **Configuration > Connection > Terminal incremental transport** saves a shared
  per-connection setting on the server. It reduces Herdr-to-Roamgate traffic,
  briefly reconnecting displays without stopping tasks; older servers retain
  their transport.
- Manage [user services](docs/DEPLOYMENT.md#run-as-a-user-service), use
  checksum-verified standalone updates under a supported supervisor, and probe
  `/health` or `/healthz`.

**Loopback bypasses login even with a password.** Non-loopback requires a token
or password. UI access grants terminal/file authority, not a read-only role;
read [Security](./SECURITY.md) before sharing access.

## Keyboard Shortcuts

Open **Menu > Configuration > Behavior > Keyboard shortcuts** for the searchable
reference/editor. Automatic detects your platform; explicit/custom presets
support up to three bindings per action, unassignment, reset, and JSON
export/import. Editing built-ins creates a custom copy. Changes save immediately
and sync to same-origin tabs; conflicts are rejected.

Common defaults (Linux/Android exceptions follow):

| Action | macOS / iOS | Windows / Linux / Android |
| --- | --- | --- |
| Command menu | `Cmd+K` | `Ctrl+Alt+K` |
| Sidebar | `Cmd+B` | `Ctrl+Alt+B` |
| Workspace Inspector | `Cmd+Shift+B` | `Ctrl+Alt+Shift+B` |
| Expand / restore Inspector (desktop) | `Cmd+Option+Enter` | `Ctrl+Alt+Shift+Enter` |
| Annotations | `Cmd+Option+A` | `Ctrl+Alt+A` |
| Zen mode (desktop) | `Cmd+Shift+Z` | `Ctrl+Alt+Z` |
| Recent pane switcher | `Ctrl+Tab` | `Ctrl+Alt+J` |
| Search panes | `Alt+K` | `Alt+K` |
| Create / close tab or pane | `Cmd+T` / `Cmd+W` | `Ctrl+Alt+T` / `Ctrl+Alt+W` |
| Previous / next tab | `Cmd+Option+Left/Right` | `Alt+Shift+Left/Right` |
| Focus neighboring pane | `Cmd+Ctrl+Arrow` | `Ctrl+Shift+Arrow` |
| Split right / down | `Cmd+D` / `Cmd+Shift+D` | `Ctrl+Alt+D` / `Ctrl+Alt+Shift+D` |
| Zoom / restore pane | `Cmd+Shift+Enter` | `Ctrl+Alt+Enter` |
| Numbered tab | `Ctrl+1…9` | `Ctrl+Alt+1…9` |
| Numbered command menu action | `Option+1…9` | `Alt+1…9` |
| Workspaces | `Ctrl+Shift+W` | `Ctrl+Alt+O` |
| File Explorer | `Cmd+Shift+E` | `Ctrl+Alt+E` |
| Diff Viewer | `Ctrl+Shift+G` | `Ctrl+Alt+G` |
| Agent history | `Cmd+Shift+H` | `Ctrl+Alt+H` |
| Search raw preview / diff | `Cmd+F` | `Ctrl+F` |
| Send composer / add review comment / pre-fill agent (focused surface) | `Cmd+Enter` | `Ctrl+Enter` |
| Copy review feedback (in Annotations) | `Cmd+Shift+C` | `Ctrl+Shift+C` |
| Copy terminal selection | `Cmd+C` | `Ctrl+Shift+C` / `Ctrl+Insert` |
| Terminal paste | `Cmd+V` | `Ctrl+V` (also `Ctrl+Shift+V` on Linux) |
| Open terminal links / file paths | `Cmd+Click` | `Ctrl+Click` |

Linux/Android uses `Ctrl+Alt+Shift+T` for new tabs, `Ctrl+Alt+Shift+D` to split
right, and `Ctrl+Alt+Shift+S` to split down, avoiding desktop-reserved bindings.
Letter/number bindings use physical keys. Browsers/OSes can intercept shortcuts;
choose alternatives in the editor or use menus.

Copy needs a selection; plain `Ctrl+C` remains terminal input. Page/half-page
navigation and modified Enter are configurable. Native editing/IME/app keys
remain available; remapped paste requires the Clipboard API. Touch shortcuts
have a separate editor. Esc dismisses transient UI; Tab/arrows navigate controls,
except in the pane switcher's search, which keeps typing in its field;
Enter/Shift+Enter advances/reverses diff search.
