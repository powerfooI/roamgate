# Roamgate Features

A Web/PWA client for a running [Herdr](https://herdr.dev) server.
[Install](./docs/DEPLOYMENT.md) · [Tutorial](./docs/TUTORIAL.md) ·
[Keyboard shortcuts](#keyboard-shortcuts)

## Workspace, Tab, and Pane Navigation

- Create, rename, pin, switch, and close workspaces/tabs. Linked Git worktrees
  group under their repository; pins and collapsed groups stay in this browser.
  Double-click a tab to rename it, or use its context menu.
- Pinned tabs lead the tab strip and cannot be closed from Roamgate; their
  panes still close while another pane remains. Herdr keeps tab ids across
  restarts, so pins persist until the tab closes elsewhere, such as in the TUI.
- Drag a tab with the mouse to reorder it within its pinned or unpinned group;
  Escape cancels. The order is saved in Herdr (`tab.move`), and numbered tab
  shortcuts address tab-strip positions. Dragging is enabled after the bridge
  confirms Herdr 0.7.2+ support, including legacy connections.
- Split right/down, resize, focus neighbors, move panes to swap with a
  neighbor, zoom, or close panes. Hover over a pane to reveal a drag handle at
  its top center. Drag it onto another pane in the same tab to swap positions;
  Escape cancels. Focus the handle and use arrow keys for directional moves,
  or click the toolbar's **Move pane** button.
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
- Paste images or drop files from the desktop onto a terminal pane to upload
  them to that pane's host and insert their paths without sending Enter. Drop
  explorer rows to insert paths without uploading. The Input Composer accepts
  any file through its picker or drop target and inserts paths into its draft.
  Uploads are stored in private per-user temporary folders. Expired folders
  are swept when the connection starts and hourly after 24 hours by default.
  Inserted paths are absolute and quoted when needed. POSIX hosts use POSIX
  shell quoting; Windows uses forward slashes and quoting for PowerShell and
  common Git Bash paths. Windows paths containing an apostrophe together
  with `$` or a backtick require PowerShell; that combination is not supported
  in Git Bash. Windows `cmd.exe` built-ins are not supported by this path format.
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

Open **Files**, **Changes**, **Commits**, or **Agent History** from the Inspector button,
keyboard shortcuts, or workspace/agent menus.

- Dock right/bottom, resize, or expand without unmounting terminals. Narrow
  layouts use drill-down/overlay views; Esc dismisses transient UI, not Inspector.
- Tab switches keep Inspector open; workspace switches restore checkout-scoped
  selection/layout. Files and Changes save separate widths. Closing returns to
  the originating tab if it still exists.
- Agent browsing starts at its cwd only inside the checkout. Terminal links use
  their pane's workspace. Changes describe the checkout, not agent ownership.
- Single-clicking a file opens a temporary preview tab; the next single-click
  reuses it. Double-click a file or its tab name to keep it open, or press Enter
  on the focused preview tab. Reopening Inspector or reloading restores the open
  files and active tab per connection and checkout. Reopening a file focuses its
  existing tab; identical filenames show their parent paths. Tabs scroll
  horizontally on compact layouts. Use Left/Right, Home/End on a focused file tab
  to switch, and Delete, middle-click, or the close button to close it. Unfinished
  review comments stay attached to their file when switching tabs.
- Files searches names/paths or text across the selected checkout, including
  unopened directories. Content results open the preview at the matching line.
  Git ignore rules and binary files are respected; results stop at 100.
- Commits browses the current branch in pages. Select a commit to see its
  metadata, changed files, diffs, and historical file previews. Merge commits
  compare with their first parent; shallow history boundaries are labeled.
- Closed worktrees must open before browsing; missing ones offer cleanup, never
  sibling files. Directory previews can prefill **New workspace**.
- The expandable **PR/MR status** card shows the current branch's GitHub pull
  request or GitLab merge request, including draft/state, author, branches,
  checks/pipeline and provider-reported review/approval status. `origin` is the
  default source remote when available; select another remote or a matching
  request when needed. **Refresh PR/MR** shows its last refresh time, and the
  linked PR/MR number opens the provider. Missing status
  is shown as unavailable. This card performs no remote mutations.
  Install and authenticate `gh` or `glab` on the checkout host (the SSH host for
  SSH connections); configured self-hosted instances are detected through the
  CLI. Credentials stay on that host. Fork lookups include the parent project.

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

## Ranger

Ranger is an experimental workspace management assistant.

Open **Ranger** from the global topbar button on desktop or the navigation
capsule on mobile, or use its configurable keyboard shortcut. Desktop uses a
floating window like Annotations; **Pin Ranger** reserves space beside the
current workspace. Mobile uses a full chat surface and hides the navigation
capsule until Ranger closes.
Pinning keeps Ranger's width. Drag its left edge, or focus the edge and use
Left/Right, to resize the docked panel; double-click the edge to reset its width.
Use **Maximize Ranger** to fill the workspace area and **Restore Ranger** (or
Escape) to return to the previous layout.
The conversation stays available when switching workspaces or connections.

- Connect a provider and choose a model through the window's **Settings** button.
  Use a separate Ranger connection or explicitly reuse the bridge account's
  saved Pi credentials with **Shared Pi credentials**. Select a saved provider or
  expand **Connect another provider**; both credential sources support sign-in
  and API-key entry in the window. **Configure custom models** connects compatible
  endpoints by API address, format, key, and model IDs separated by commas or
  newlines. Shared mode also reads
  Pi's custom models. See [model setup](docs/DEPLOYMENT.md#ranger-model-connection).
- Change the model and **Thinking effort** with the compact selectors below the
  chat input. Search models across connected providers. Effort choices come from
  the selected model; **Default** shows its effective level, and models without
  adjustable thinking show a disabled control. Changes are saved on the bridge
  and apply to the next message, including when a reply is still streaming.
  They preserve your draft, conversation, and workspace permissions.
- Allow workspaces in Settings. Each question automatically uses saved
  authorized workspaces that are currently available. **Select all** adds the
  currently available workspaces; **Clear** removes every selection. Use
  **Save connection** to apply permission changes.
  Workspace choices use a compact grid that scrolls when the list is long.
  No workspaces are authorized by default. In normal mode, new workspaces need
  to be selected separately. Confirmed deleted workspaces are removed from the
  list and saved selection; temporary disconnects preserve saved choices.
  The scope stays fixed while Ranger streams an answer.
- Type **@** in the message input to search authorized workspaces and concrete
  Agent sessions. Candidates show their host and workspace so names can be
  distinguished across connections. Use Up/Down and Enter or Tab to select;
  Escape closes the picker and Shift+Enter inserts a new line. Selected objects
  appear as removable references below the input and remain bound when switching
  chats. Editing a reference's text removes its binding; ordinary pasted names
  are plain text. Click a reference in the conversation to open its verified
  workspace or Agent pane.
  References focus the question without changing workspace permissions or
  sending prompts. Ranger reads evidence as needed. Changed or unavailable Agent
  sessions require reselection, and monitoring tasks preserve the selected
  session instead of following a replacement Agent in the same pane.
- Expand **Work performed**, then an individual tool card to inspect its
  **Arguments** and **Result** or **Error**, including tools that manage tasks or
  propose actions. Long details are marked when truncated; older calls show
  details when their execution logs can be located. Ranger can read
  workspace status, agent history, changes, and recent terminal output. Source
  links show when the evidence was read and open the corresponding workspace
  or pane; unavailable or replaced connections require fresh evidence.
  Reads and source cards collapse together when each answer finishes; expand
  them again to inspect the evidence.
  Ranger chooses how many recent terminal lines to read (1-1,000; default 120),
  with the newest 32,000 characters retained if the output exceeds its budget.
- Ask Ranger to create a workspace, worktree, or terminal tab, split a pane to
  the right or below, start an agent in a pane, or send a prompt and supporting
  context to an agent. Each operation
  appears as a preview with its host, workspace, parameters, and full text to be
  sent. **Confirm action** executes that exact proposal; **Cancel** dismisses it.
  Tab and split previews show the working directory and source pane when needed;
  completion receipts identify the new tab or pane. Ask Ranger to read the updated
  status before starting an agent there.
  Worktree previews include configured setup hooks. Results distinguish verified
  completion from partial or uncertain outcomes. An uncertain operation must be
  checked at its target before proposing another one; reconnects never replay it.
  In normal mode, newly created workspaces must be explicitly allowed before
  Ranger can use them.
- **High-permission mode** in Settings is off by default. Enable it explicitly
  to authorize all current and newly discovered workspaces and let Ranger
  execute supported management operations and create scheduled
  tasks without individual confirmations. Results remain visible in the chat.
  Each question and task keeps its concrete captured scope. Disable the
  mode to restore normal-mode selections and require confirmation for subsequent
  operations. Older saved High-mode settings keep their selected-workspace scope
  until the broader permission is explicitly confirmed. Existing
  tasks keep their saved permission mode; edit a task while this mode is enabled
  to allow automatic operations in its future runs.
- Closing the window hides it while work continues; the topbar indicator shows
  activity. **Stop** cancels the current turn. **New chat** saves the current
  conversation and starts an empty one, keeping the model connection and workspace
  permissions. **History** lists saved conversations by their first question;
  select one to read its messages and continue chatting. Switching chats retires
  unconfirmed action previews.
- The wave bar on the right marks messages and highlights the visible portion
  of the conversation. Hover to preview a message, click to jump, or focus it
  and use Up/Down, Home, and End. Jumping back pauses automatic following until
  you return to the bottom or send another message.

The bridge stores saved conversations and one active chat shared by its
authenticated browsers/devices; messages survive bridge restarts. A reconnect
fetches current progress without resending a question. Unfinished questions can
resume after a bridge restart once the original connections and workspace
identities have been verified. Stopping the bridge pauses a question; **Stop**
cancels it. Confirmed management operations are never automatically replayed.
Unsent drafts stay in the
current browser tab's memory, separately for each conversation.
The **Chat / Tasks** switch keeps scheduled work separate from conversations.
The Chat toolbar provides direct **History** and **New chat** buttons.

Create a task in **Tasks**, or ask Ranger for a schedule. Confirm its preview in
manual mode; high-permission mode enables it directly. Schedules support one UTC
timestamp, a daily time in an explicit
timezone, or an interval in whole minutes. The task fixes its workspace scope and
model at creation. It runs with the browser closed and retains separate results
and tool activity for each run; reopening Tasks shows the current progress.
Daily schedules skip nonexistent daylight-saving times and run only once at a
repeated time. Missed occurrences are combined into one run after restart.

Enable **Task notifications** to receive Ranger alerts. The task's
**Notifications** setting defaults to **Notify when each run finishes**.
Choose **Let Ranger decide** for monitoring: routine successful checks stay
quiet, and Ranger can send a custom title and message when the condition in
your task prompt warrants attention. Failed Ranger runs and pending action
confirmations still use fixed alerts in either mode.

For example, ask Ranger to check an Agent every minute and notify you only
when its work finishes or fails, then confirm the proposed task in manual mode.
Ranger reads
the authorized workspace context and reports the evidence it finds; an idle
Agent alone does not establish success. Each run can issue one custom notice,
and repeated events are deduplicated across checks and restarts.
**Task completed** controls completion alerts; **Task needs attention** controls
attention alerts. Click **Open Ranger task** or a system notification to view
the associated run. Web Push delivers alerts with the page closed while the
bridge is running. Stopped or cancelled runs and already recorded results stay
silent.

**Pause** prevents future runs without interrupting the current run.
**Stop run** ends only the current run. **Cancel task** ends current work and
future scheduling while preserving its history. **Run now** starts an extra run;
paused tasks stay paused after a manual run or an edit. Cancelled tasks can be
deleted with their history. Each task retains the latest 20 runs, with at most 50
stored tasks.
Task plans, run receipts and durable execution data are persisted in SQLite on
the bridge host.
Automatic runs may read and propose operations. Management operations need
confirmation in the run details unless the task was saved with high-permission
mode and that mode is still enabled globally. Task execution does not replace
the active chat. Workspace permissions cover both reads and management operations.
Ordinary Roamgate access still grants the
[administrative authority](SECURITY.md#trust-model) described by its trust model.

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

### Worktree Hooks

`roamgate.json` (with legacy `paseo.json` compatibility) supports `setup`, `opened`, `teardown`, and `removed` hooks.
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
  have zoomable diagrams, fullscreen viewing, and source views. Markdown
  diagrams expand to their content height. Markdown links navigate within
  Inspector; external links open a browser tab.
- Workspace `.html`/`.htm` files open in Preview mode with a Preview/Source switch.
  Static previews support workspace CSS, images, and fonts, including relative
  CSS imports, plus HTTPS CDN stylesheets. Scripts, external images and external
  fonts are blocked; HTML source is limited to 512 KiB. Files outside the workspace
  remain available as source or downloads.
- Preview images (including SVG), PDFs, and local Markdown images with zoom/Fit.
  Audio files (`.mp3`, `.wav`, `.ogg`/`.oga`/`.opus`, `.m4a`, `.aac`, `.flac`,
  `.weba`) up to 25 MiB play in a native audio player with byte-range seeking,
  including on SSH profiles. Larger audio files remain download-only.
  Unsupported binaries are download-only; decoding depends on the browser.
- Upload by dragging onto a checkout directory; download files or workspace
  `.tar.gz` directories; copy paths or delete with confirmation via right-click
  or long-press. Upload/delete stay checkout-scoped. Operations work over SSH.
  Desktop layout downloads directly, including installed web apps. Mobile
  layout keeps native iOS sharing and its browser fallback behavior.
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
  highlighting work across loaded diffs; images have previews. Non-SSH
  connections load nearby diffs as you scroll; SSH loads selected files on
  demand. The file index jumps to a file without closing other local diffs.
  Generated files marked by `linguist-generated` or `gitlab-generated`, files
  of at least 256 KiB, and diffs with at least 1,000 changed lines or 128 KiB of
  patch content start collapsed with a **View diff** action. Git attribute
  overrides can unmark generated files. Skipped files remain in change totals;
  patches exceeding 512 KiB are truncated and labeled.
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
- Touch reads output without opening the keyboard. In Direct mode, a light
  terminal tap opens the device keyboard. Long-press selects
  text for **Copy**, **Add comment**, or link actions; **Done**/Esc exits.
  Scroll first to select older output. Selection freezes the displayed frame,
  not the connection; legacy streams resume at a 1 MiB buffered UTF-16 limit.
- Customize the floating `2×8` grid and up to four side buttons under
  **Configuration > Behavior > Mobile terminal shortcuts**. The Tabs sheet and
  pane controls work when the tab strip is hidden.
  Choose **Preset** or **Custom keyboard**. The US keyboard lets you toggle Ctrl,
  Alt, and Shift and pick one letter, number, symbol, or basic key; expand **More keys**
  for navigation keys and F1-F12 in separate groups. Set a label and edit or clear individual slots;
  defaults stay available. Buttons send only that combination, with no extra
  Enter. Shift uses US symbols. Endpoint terminals preserve ambiguous modified
  keys such as Ctrl+/, Ctrl+Backspace, Ctrl+Shift+letters, and Alt+Escape;
  ordinary Ctrl aliases (such as Ctrl+I for Tab) remain available. Legacy/shared
  terminals retain their traditional byte encodings; combinations available only
  on endpoint terminals are disabled there with an explanation. Modified Enter
  requires application support. Custom PageUp/PageDown sends application input; the presets scroll
  history. Unsupported combinations, such as Ctrl+1, identify the affected slot
  and block saving. Buttons bypass browser keyboard
  shortcuts, but application keybindings still apply. Cmd/Meta, text macros,
  commands, and multi-step sequences are not supported.
- Drag the `⋯` controls button to move the floating controls; release snaps
  them to the nearer side edge at that height, mirrored on the left. The
  position is kept per browser and stays clear of the header and tab strip
  when space allows.
  The capsules remain available with Composer, Direct input, and the device
  keyboard open. They temporarily move above the input dock without changing
  the saved position. Short/scaled viewports use a horizontally scrollable row;
  the input dock can scroll too when space is tight. In extremely short views,
  reachable controls and input take priority over header clearance. Folding or dragging the
  controls preserves typing focus; choosing another view can dismiss the keyboard.
- The bottom-right **Type** button opens one input dock with a
  **Composer / Direct** mode switch and the configured two shortcut rows.
  The keyboard button shows or hides both rows in either mode and remembers
  the choice per browser, including after reload. Swipe the
  terminal up or down to scroll with the dock open in either mode; gestures
  inside the Composer editor keep their native text-editing behavior.
  Composer supports IME, dictation,
  multiline text, and images. Tap its editor to open the device keyboard. **Insert**
  does not execute; **Send** adds one Enter. Drafts are in-memory per
  connection/pane; closing their pane/tab/workspace asks before discarding.
  Direct sends keys immediately through the terminal's keyboard input and
  preserves the Composer draft. Explicit mode switches are remembered per
  browser, including after reload; reopening input restores that choice
  (Composer by default). Composer opens the keyboard only when its editor is
  tapped; opening the dock, scrolling, and shortcut actions leave it closed.
  **Type** opens the keyboard immediately when restoring Direct.
  Connection and pane safety resets return the live dock to Composer
  without changing the saved choice. Shortcut keys act on the terminal in either mode.
- In the mobile composer, the **terminal command icon (`>_`)** opens a floating
  command picker above the input without shrinking the editor or terminal.
  In the compact controls layout it stays inside the scrollable input dock so
  commands remain reachable without covering the navigation row.
  It browses built-in catalogs for Claude Code, Codex, Pi, Kimi Code, Grok Build,
  and Antigravity CLI (`agy`) using the pane's agent identity.
  Type a leading `/` for prefix completion. Up/Down selects
  a suggestion, Tab prepares it, and Escape dismisses; Enter still
  inserts a newline. Selection never sends input. Inline completion preserves
  arguments; browsing requires confirmation before replacing a non-empty draft.
  Catalogs are static; command availability depends on the installed agent's
  version and configuration. Unknown agents have no built-in suggestions;
  custom commands remain sendable.
- Install as a PWA for an app window; a bundled Nerd Font supplies terminal
  icons. **PWA is not offline access**: Roamgate must remain reachable.
  See [installation steps](README.md#install-as-a-pwa).
- **Configuration > Instance > Title suffix** gives different Roamgate servers
  distinct page and PWA names, such as `Roamgate · Home` and `Roamgate · Work`.
  Names are saved on each server and shared across devices. Existing Android
  installations may need a browser-approved update or reinstall.
  [Instance naming](docs/DEPLOYMENT.md#pwa-instance-names).

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

**Normal runtime requires a token or password, including loopback.** The local
development exception, password policy, and login limits are described in
[Security](./SECURITY.md#trust-model).
UI access grants terminal/file authority, not a read-only role; read it before
sharing access.

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
| Ranger | `Cmd+Option+Shift+A` | `Ctrl+Alt+Shift+A` |
| Zen mode (desktop) | `Cmd+Shift+Z` | `Ctrl+Alt+Z` |
| Recent pane switcher | `Ctrl+Tab` | `Ctrl+Alt+J` |
| Search panes | `Alt+K` | `Alt+K` |
| Create / close tab or pane | `Cmd+T` / `Cmd+W` | `Ctrl+Alt+T` / `Ctrl+Alt+W` |
| Previous / next tab | `Cmd+Option+Left/Right` | `Alt+Shift+Left/Right` |
| Focus neighboring pane | `Cmd+Ctrl+Arrow` | `Ctrl+Shift+Arrow` |
| Move pane (swap with neighbor) | `Cmd+Ctrl+Shift+Arrow` | `Ctrl+Alt+Shift+Arrow` |
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
