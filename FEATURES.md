# Roamgate Features

A Web/PWA client for a running [Herdr](https://herdr.dev) server.
[Install it](./docs/DEPLOYMENT.md) or follow the [tutorial](./docs/TUTORIAL.md).

## Workspace, Tab, and Pane Navigation

- Browse workspaces and recognized agents; create, rename, focus, pin, or close
  workspaces and create, rename, switch, or close tabs.
- Group linked Git worktrees under their repository. Pin workspaces/worktrees
  to the top and collapse groups; preferences stay in this browser.
- Split panes right/down, resize boundaries, focus neighbors, zoom, or close.
- Search workspace, worktree, file, tab, pane, and agent actions in the command
  menu (`Cmd+K` on macOS, `Ctrl+Alt+K` elsewhere). A workspace-relative or
  absolute path opens the file.

Herdr 0.9.0 uses **Local navigation** per browser/connection; legacy connections
use **Shared navigation**. Reconnect preserves live selections; reload starts
from Herdr's selection. Closing/moving a selected pane selects a remaining pane
in its tab, then a remaining tab/workspace. Topology changes, terminal sizes,
and same-tab pane focus (including `follow` cwd) remain shared.

Creation preserves Herdr's cwd policy and needs an open, connected source
terminal tab; unavailable sources show an error. An empty session can create its
first workspace directly. See [compatibility](docs/DEPLOYMENT.md#herdr-compatibility).

### Recent Pane Switcher

The switcher includes the 12 most recently focused live panes plus the current
layout, across tabs/workspaces. Entries show workspace, tab or cwd, and agent
icon/status. Closed panes leave history automatically. The keys below use the
macOS preset; see [other platform bindings](#keyboard-shortcuts).

| Key | Action |
| --- | --- |
| `Ctrl+Tab` | Open at the previous pane; hold Ctrl and repeat Tab to advance |
| `Ctrl+Shift+Tab` | Move backward |
| `Up` / `Down` | Move through entries |
| Release `Ctrl` or press `Enter` | Switch |
| `Esc` | Cancel |

## Full Browser Terminal

- Display Herdr's server-rendered terminal at browser rows/columns, with splits.
- Send normal input, modified Enter, macOS line-editing shortcuts, multiline
  paste, IME composition, and rapid CJK punctuation.
- Scroll history by wheel, trackpad, touch, or half-page
  `Alt/Option+Page Up`/`Page Down`. Full page keys go to terminal apps (such as
  nano) or Herdr history when the shell owns them; mobile buttons route the same
  way. Endpoint history needs advertised support; disabled controls explain why.
  Explicit half-page shortcuts remain history actions in mouse-aware apps.
- On Herdr 0.9.0, clicks/drags/wheels use pane-local cells in mouse-aware apps.
  Select browser text with Option-drag (macOS) or Shift-drag (elsewhere);
  ordinary output needs no modifier. Selection pauses visible endpoint output
  until cleared, then catches up. Drag past pane edges to scroll and copy
  offscreen rows. Release or blur stops scrolling; if output changes, finish
  the selection before scrolling further. Pixel mouse is unsupported.
- Paste clipboard images to upload to the Herdr host and insert their paths,
  including through `--ssh-host`.
- Relay terminal OSC 52 clipboard writes. Herdr 0.9.0 follows the foreground
  recipient, not proven originating-pane ownership; see
  [clipboard compatibility](docs/DEPLOYMENT.md#herdr-compatibility).
- `Cmd/Ctrl`-click HTTP(S) links to open safely in a new tab, or workspace-relative
  / absolute paths to preview text, Markdown, or images.

## Workspace Inspector

Open Files, Changes, or Agent History with the TabBar Inspector button,
`Cmd+Shift+B` on macOS, or workspace/agent context menus. The header identifies repository,
branch/worktree, and checkout path.

- Dock right/bottom, resize, or expand without unmounting the terminal. Header
  controls restore/close; Esc dismisses transient UI, not the Inspector.
- Tab switches keep it open. Workspace switches restore the target checkout's
  view, selection, and layout. Closing returns to the originating tab if it
  exists, otherwise the active tab.
- Wide layouts show navigation beside content; narrow layouts drill into files
  with overlay/full-screen views. Resize the separator by dragging or
  Left/Right/Home/End; double-click resets it. Files and Changes save separate
  checkout-scoped widths.
- Agent browsing starts at its cwd only inside the checkout. Terminal links use
  their pane's workspace, not later focus. Changes cover the checkout, not
  proven agent ownership.
- Open closed worktrees before browsing. Missing/prunable worktrees offer cleanup,
  never sibling files. Removal clears only that checkout's resource state.

Preview is read-only: no synthetic terminal tabs or cross-worktree merged changes.
See [resource ownership](docs/ARCHITECTURE.md#workspace-resource-ownership).

## Agent Awareness and Session Inspection

- See Herdr-recognized identity and working/blocked/done/idle status in the tree,
  pane switcher, command menu, and Agent panel. Focus panes there or through
  browser completion notifications.
- Open Agent History with independent User/Agent/Tool filters (User/Agent enabled,
  Tool hidden initially), a message minimap, and on-demand tool details. The recent window
  counts 200 conversation entries, not associated tools; exports remain complete.
  See [History synchronization](docs/HISTORY.md).
- Choose **Agents: Separate** at the bottom of Workspaces for a dedicated panel,
  or keep agents nested. Separate defaults to **Attention first**: blocked,
  done, working, idle, unknown. Sort/Group icons offer workspace/manual order
  and status/workspace/type groups with collapse controls. Ungrouped manual
  order supports dragging. Sort/group preferences are browser-local; manual
  order is per connection.
- Rows show tab names before pane IDs; blank or numbered defaults (`2`, `Tab 2`)
  are omitted in both views.
- Inspect turns, tokens, update time, session ID/file, and other metadata. Session
  Inspector offers Timeline, searchable ATIF/raw transcripts, and original-file
  or normalized ATIF export.

Supported providers: **Codex, Claude, Kimi, Grok Build, Pi**, with a readable
session record. Missing Herdr integration metadata shows the integration command.
With `--ssh-host`, Herdr-reported paths and Pi ID lookup read remotely. Other
ID/directory fallbacks (including Grok Build discovery) remain local and need
locally accessible transcripts.

## Git Worktree Lifecycle

- Create a linked worktree from freshly fetched `origin/main` without changing
  the source branch or dirty files; discover/open existing worktrees.
- See checkout paths, open/closed state, branch status, and uncommitted counts.
- Focus open worktrees, run `git pull`, or enable per-checkout branch updates.
- Remove linked worktrees with confirmation, hooks, process cleanup, and recovery
  that preserves residual files when safe removal fails.

Open **Worktree Lifecycle** from a workspace context menu or search
`worktree lifecycle` in the command menu.

### Paseo Worktree Hooks

Define [Paseo hooks](https://paseo.sh/docs/worktrees) under `worktree` in the
repository's `paseo.json`:

```json
{
  "worktree": {
    "setup": "bun install",
    "opened": "./scripts/worktree-opened.sh",
    "teardown": "./scripts/worktree-teardown.sh",
    "removed": "./scripts/worktree-removed.sh"
  }
}
```

| Paseo hook | When Roamgate runs it | Working directory |
| --- | --- | --- |
| `setup` | After a new linked worktree has been created and opened | New worktree |
| `opened` | After an existing linked worktree has been opened | Opened worktree |
| `teardown` | Before a linked worktree is removed | Worktree being removed |
| `removed` | After removal finishes | Source checkout |

For `setup`, `opened`, and `teardown`, the target checkout's `paseo.json` wins;
only an absent file falls back to the source checkout. After removal, `removed`
normally uses the source configuration because the target no longer exists.

Commands run through `sh -c`. The following variables are available:

| Variable | Value |
| --- | --- |
| `PASEO_HOOK` | `setup`, `opened`, `teardown`, or `removed` |
| `PASEO_CHECKOUT_PATH` | Target worktree path, including the former path for `removed` |
| `PASEO_SOURCE_CHECKOUT_PATH` | Parent/source checkout path when known |
| `ROAMGATE_HOOK_EVENT` | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `ROAMGATE_HOOK_CHECKOUT_PATH` | Same target path exposed under a `ROAMGATE_`-prefixed alias |
| `ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH` | Same source path exposed under a `ROAMGATE_`-prefixed alias |

Legacy `HERDR_GUI_HOOK_*` aliases remain available with the same values.

Notices show hook outcomes and bounded diagnostics (exit code, stderr, or error).
Failed `teardown` stops removal: fix/disable the hook before retrying. Other hooks
are not transactional: failed `setup`/`opened` does not undo creation/opening;
failed `removed` cannot restore a worktree.

Hooks default to enabled. Disable them per repository in **Worktree hooks** or
**Worktree Lifecycle**, which also show detected configuration and commands.
With `--ssh-host`, configuration and execution are remote. **Hooks are trusted,
unsandboxed code:** review `paseo.json` before creating, opening, or removing.

### Automatic Branch Updates

Fetch `origin/main` and merge into enabled checkouts' current branches every
10 minutes by default. The UI shows interval and last result. Manage saved
per-checkout settings in **Menu → Automatic branch updates**, workspace context
menus, or Worktree Lifecycle.

Runs skip dirty or detached checkouts, verify branch/HEAD/worktree stayed unchanged
during fetch, and abort conflicting merges. Updates run only while the workspace
is open in the current connection.

## File Explorer and Preview

- Browse a cached, expandable tree, optionally including hidden files. Search
  covers loaded files; Git badges mark changed files/directories; ignored files
  are dimmed.
- Preview text with line numbers, syntax highlighting, and `Cmd/Ctrl+F` search.
  Markdown and `.mmd`/`.mermaid` files offer Raw/Rendered views, including
  Mermaid diagrams in Markdown fences.
- Follow Markdown file links within the Inspector: relative to the document,
  leading `/` from workspace root, and heading fragments within the destination.
  External links open a new browser tab.
- Preview common images, PDFs, and workspace-local Markdown images; unsupported
  binaries are download-only.
- Drag uploads onto the root/directory. Download files or workspace-scoped
  `.tar.gz` directories; copy absolute paths; delete with confirmation.
  Open actions by right-click or touch long-press.

File operations and previews work locally and over SSH.

## Review Annotations

- Click/drag diff line numbers or source annotation gutters to comment on lines;
  release opens the editor with file, range, and content snapshot.
- Select rendered Markdown passages to capture their text and nearest heading.
- Edit, delete, or reorder checkout-scoped comments. Copy compiled feedback or
  pre-fill a selected Agent pane; **delivery never submits**. Review and press
  Enter manually.
- Browser-local drafts persist until delivered/cleared. Refresh re-anchors matching
  content and marks unresolved anchors stale without losing captured quotes.

## Diff Viewer

- Browse a directory tree with staged, unstaged, untracked, conflicted, and
  branch-diff badges plus added/deleted counts.
- Choose **Working tree**, **Against main**, or **Last step** (latest completed
  agent-activity snapshot, including commits/untracked files; not proof of ownership).
- Read files in repository order. Large, truncated, and `linguist-generated=true`
  diffs start collapsed and render on expansion.
- Choose desktop side-by-side/unified views; mobile is unified. Wrapping saves
  independently for desktop/mobile. Search with `Cmd/Ctrl+F`, Enter/Shift+Enter,
  or previous/next controls. Text is syntax-highlighted; images have previews.
- Jump to File Explorer from a diff. Working-tree context menus (right-click,
  long-press, or keyboard menu key) offer open, copy relative/absolute path, and
  status-matched stage, unstage, mark resolved, discard unstaged, or delete
  untracked actions, with destructive-action confirmation.
- **More Git actions** (`…`, beside Refresh) offers Stage All, Unstage All,
  Discard All Unstaged, and Delete All Untracked with affected-file counts.

Scope, view mode, wrapping, and recent selection persist per checkout/browser.
Git actions recheck status/content and reject stale menus instead of destroying
newer work.

## Mobile and PWA

- Responsive terminals, Inspector, and viewport/keyboard handling. **Menu →
  Appearance → Mobile Layout → Display mode** offers Automatic/Mobile/Desktop.
  Automatic uses **Mobile up to (px)**: 768 by default, adjustable 320–2560 CSS
  pixels. Mobile stays mobile at any width, including after reload.
- URL overrides `?layout=mobile`, `?layout=desktop`, or `?layout=auto` beat saved
  mode. Choosing a menu mode clears that override, preserving other parameters.
- Choose **Agents on top** or **Workspaces on top** independently for each layout
  under Mobile Layout. This affects the separate Agents panel; mobile defaults
  to agents first, desktop to workspaces first.
- Configure the floating terminal panel's `2×8` shortcut grid and up to four
  side buttons. Empty editor slots keep their positions but compact at runtime.
  Actions include Ctrl, arrows, Enter variants, full/half-page scrolling, and
  Paste (text or uploaded clipboard-image paths).
- Switch split panes or use the Tabs sheet to create/switch/close tabs when the
  strip is hidden. The composer supports native IME, dictation, multiline text,
  and images: **Insert** does not execute; **Send** adds exactly one Enter.
  Drafts stay in memory per connection/pane; closing their pane/tab/workspace
  asks before discarding them.
- A bundled glyph-only Nerd Font supplies common terminal icons. Install as a
  PWA in iOS/iPadOS Safari, macOS Safari, Chrome, or Edge to remove browser chrome.
  It still needs a reachable Roamgate process, not offline access. Use **Menu →
  Reload page** in the browser or PWA.

Mobile shortcuts and appearance stay in this browser, not Herdr configuration.

## Remote, Multi-Client, and Operations

- Manage shared local/SSH profiles with independent browser selection. Disconnect
  does not stop Herdr/workspaces. Linux/macOS `--ssh-host` forwards control and
  render sockets; Windows supports native local profiles, not SSH forwarding.
  See [connection setup](docs/DEPLOYMENT.md#multiple-and-remote-herdr-connections).
- Remote file/image-paste/Git/hook operations run on the same host; session
  inspection has the metadata limits described above.
- Multiple browsers receive pushed events. Pause/resume yours, see client counts,
  or pause others. Completion notifications return to the relevant pane.
- Choose light/dark/system appearance, persistent accents, and terminal themes
  per appearance mode in **Menu → Appearance → Terminal theme**. Built-ins
  include Solarized, Dracula, One Dark, Nord, Tokyo Night, Catppuccin, and GitHub;
  custom themes set base/ANSI colors. Themes apply live to all terminals and save
  per browser. **Text size** scales the UI from 80% to 150%, including mobile.
- Manage a user service from the CLI; check releases and run checksum-verified
  one-click standalone updates under a supported supervisor. Probe `/health` or
  `/healthz`. See [services](docs/DEPLOYMENT.md#run-as-a-user-service).

**Loopback bypasses login even with a password.** Non-loopback generates a token
unless a fixed password is set. Authentication provides no TLS, rate limiting,
multi-user authorization, or sandboxing; read [SECURITY.md](./SECURITY.md).

## Keyboard Shortcuts

Open **Menu → Behavior & automation → Keyboard shortcuts** for the searchable
list and preset editor on desktop/mobile. Lists and hints show active bindings.
See the [desktop](docs/screenshots/keyboard-shortcuts-desktop.png) and
[mobile](docs/screenshots/keyboard-shortcuts-mobile.png) editors.

- **Automatic** detects macOS/iOS, Windows, or Linux/Android; explicit presets
  override detection.
- **Edit** records/types up to three alternatives, restores defaults, or unassigns
  an action. Editing built-ins creates a custom copy. Overlapping conflicts are
  rejected while ordinary typing, IME, and dialog dismissal stay available.
- **Save as** creates named presets; **Active preset** switches them. Edits save
  immediately and sync to same-origin tabs. **Export/Import** transfers JSON
  between browsers; deleting a custom preset returns to Automatic.
- Letter/number bindings use physical keys, unaffected by modifier-produced
  characters. Recording captures only keys the page receives; choose alternatives
  for browser/OS-reserved shortcuts, including macOS tab shortcuts.

Common defaults (Linux/Android overrides follow the table):

| Action | macOS / iOS | Windows / Linux / Android |
| --- | --- | --- |
| Command menu | `Cmd+K` | `Ctrl+Alt+K` |
| Sidebar | `Cmd+B` | `Ctrl+Alt+B` |
| Workspace Inspector | `Cmd+Shift+B` | `Ctrl+Alt+Shift+B` |
| Recent pane switcher | `Ctrl+Tab` | `Ctrl+Alt+J` |
| Create / close tab or pane | `Cmd+T` / `Cmd+W` | `Ctrl+Alt+T` / `Ctrl+Alt+W` |
| Previous / next tab | `Cmd+Option+Left/Right` | `Alt+Shift+Left/Right` |
| Focus neighboring pane | `Cmd+Ctrl+Arrow` | `Ctrl+Shift+Arrow` |
| Split right / down | `Cmd+D` / `Cmd+Shift+D` | `Ctrl+Alt+D` / `Ctrl+Alt+Shift+D` |
| Numbered tab | `Ctrl+1…9` | `Ctrl+Alt+1…9` |
| Numbered command menu action | `Option+1…9` | `Alt+1…9` |
| Workspaces | `Ctrl+Shift+W` | `Ctrl+Alt+O` |
| File Explorer | `Cmd+Shift+E` | `Ctrl+Alt+E` |
| Diff Viewer | `Ctrl+Shift+G` | `Ctrl+Alt+G` |
| Agent history | `Cmd+Shift+H` | `Ctrl+Alt+H` |
| Search raw preview / diff | `Cmd+F` | `Ctrl+F` |
| Send composer / add review comment | `Cmd+Enter` | `Ctrl+Enter` |
| Copy terminal selection | `Cmd+C` | `Ctrl+Shift+C` / `Ctrl+Insert` |
| Terminal paste | `Cmd+V` | `Ctrl+V` (also `Ctrl+Shift+V` on Linux) |
| Open terminal links / file paths | `Cmd+Click` | `Ctrl+Click` |

Linux/Android uses `Ctrl+Alt+Shift+T` to create tabs, `Ctrl+Alt+Shift+D` to
split right, and `Ctrl+Alt+Shift+S` to split down, avoiding common Linux desktop
shortcuts for launching a terminal or showing the desktop.

Terminal copy, page/half-page navigation, and modified Enter are configurable
here. Copy needs a selection; plain `Ctrl+C` remains terminal input. Native text
editing, editor search, and shell/agent keys follow those apps. Native clipboard
gestures remain; remapped paste needs the browser Clipboard API. Touch controls
use the separate **Mobile terminal shortcuts** editor.

Esc dismisses dialogs, menus, notifications, and update banners. Tab/arrows
navigate controls. The pane switcher accepts Up/Down, Enter, or release of its
opening modifier. Diff search uses Enter/Shift+Enter for next/previous. Select in
mouse-aware apps with Option-drag (macOS) or Shift-drag (elsewhere).
