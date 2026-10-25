# Roamgate Features

A Web/PWA client for a running [Herdr](https://herdr.dev) server.
[Install](./docs/DEPLOYMENT.md) · [Tutorial](./docs/TUTORIAL.md) ·
[Keyboard shortcuts](#keyboard-shortcuts)

## Workspace, Tab, and Pane Navigation

- Create, rename, pin, reorder, switch, and close workspaces and tabs. Linked Git
  worktrees group under their repository. Pinned tabs lead the tab strip and
  cannot be closed from Roamgate. Drag-to-reorder needs Herdr 0.7.2+.
- Linked GitHub PRs and GitLab MRs appear in right-side sidebar badges with their
  number (`#N` for GitHub, `!N` for GitLab) and an open, draft, merged, or closed
  icon, preserving the workspace name. When several requests match, the sidebar
  shows the most recently created one. The workspace menu opens that request
  directly. Status refreshes every
  minute after each check; unresolved requests keep the branch label. A
  refresh keeps the current badge visible, and a failed refresh keeps the last
  known request dimmed with its last successful check time. A rebase stopped on
  a detached HEAD keeps the rebased branch's request. This uses
  the same host-side authentication as the
  [PR/MR status card](#workspace-inspector).
- New workspace paths accept absolute paths or `~/` and suggest subdirectories
  as you type. Leave the field blank to use Herdr's default directory.
- Split, resize, focus, swap (drag the handle at a pane's top center), zoom, and
  close panes.
- Drag a pane's handle onto another tab to move the pane there, or onto **+**
  to give it a tab of its own. Hold it over a tab to open that tab, then drop
  it on a pane's edge to place it on that side. Running programs keep going.
- The command menu searches workspaces, worktrees, files, tabs, panes, and
  agents, and opens typed file paths.
- Desktop **Zen mode** hides app chrome so the terminal fills the window.

Each browser keeps its own workspace and tab selection on endpoint connections;
older (legacy) connections share navigation. Pane focus, layout, and terminal
sizes within a tab are always shared. See
[compatibility](docs/DEPLOYMENT.md#herdr-compatibility).

### Recent Pane Switcher

Switch between the 12 most recently focused panes across tabs and workspaces.
On macOS hold Ctrl and press Tab (Shift reverses); release the modifier or press
Enter to switch, Esc to cancel. Press K to switch to search mode.

### Pane Search

`Alt+K` searches **every** live pane by workspace, tab, cwd, or agent
name/status. All terms must match, in any order. Enter switches; `Alt+K` or Esc
closes.

## Full Browser Terminal

- Server-rendered terminals with full keyboard input, IME, CJK punctuation, and
  multiline paste.
- Scroll with wheel, trackpad, touch, or page shortcuts. Mouse-aware apps
  receive clicks and drags; hold Option (macOS) or Shift to select text instead.
- Paste images or drop files onto a pane to upload them to that pane's host and
  insert their quoted paths (without pressing Enter). Dropping explorer rows
  inserts paths without uploading. Uploads expire after 24 hours by default.
- `Cmd/Ctrl`-click opens URLs in a browser tab and file paths in the preview.
  On touch, long-press and choose **Open link** or **File actions**.
- OSC 52 clipboard writes go to the browser that most recently typed into the
  foreground session, which is not necessarily the pane that produced the
  write; see [clipboard limits](docs/DEPLOYMENT.md#herdr-compatibility).

Herdr 0.9.1+ resolves URLs that wrap across lines. See
[link contracts](docs/ARCHITECTURE.md#links).

## Workspace Inspector

Open **Files**, **Changes**, **Commits**, or **Agent History** from the
Inspector button, shortcuts, or workspace/agent menus.

- Dock right or bottom, resize, or expand. Narrow layouts use drill-down views.
- Single-click opens a temporary preview tab; double-click keeps it. Open files
  are restored per connection and checkout.
- Files search covers names, paths, and file contents across the checkout
  (respecting `.gitignore`, up to 100 results).
- Files refresh automatically after an agent step completes in the workspace,
  preserving expanded directories and selections.
- Commits browses the current branch with per-commit diffs and file previews.
  Wide panels show commits, changed files, and diffs in three columns; drag the
  commit-list divider to resize it, or double-click to reset. Narrow panels
  navigate from commits to files to diffs, with Back returning one level.
- The **PR/MR status** card in **Changes** and **Commits** shows the branch's
  GitHub pull request or GitLab merge request: state, checks, and reviews. It
  needs `gh` or `glab` authenticated on the checkout host and never changes
  anything remotely. If a refresh fails, it keeps the last known request marked
  **Last known**. A detached checkout resolves a request only while a branch
  rebase is in progress.

Sidebar and worktree PR/MR badges keep the last successful summary in this
browser (up to 200 checkouts). Reloading or reconnecting shows it as **Last known**
while the status refreshes. Temporary Git, network, CLI, or authentication
failures do not erase a known link. Cached summaries are isolated by connection
destination, repository, checkout, and branch; a confirmed missing or ambiguous
request clears the cached link. Cached links require a known branch; temporary
Git status failures retain the last confirmed branch. A detached checkout waits
for Git to confirm an active branch rebase before showing a request, and must
confirm it again after reconnecting.

Inspector state is scoped to each checkout; see
[resource ownership](docs/ARCHITECTURE.md#workspace-resource-ownership).

## Agent Awareness and Session Inspection

- See recognized agents and their working/blocked/done/idle status in the
  sidebar, switcher, command menu, Agent panel, and notifications.
- Choose nested, **Separate**, or **Compact** agent views with optional
  attention-first ordering and grouping.
- Switch **Current / All servers** in the **Workspaces** heading in any agent
  layout. **All servers** labels each workspace with its server, preserving
  the existing worktree nesting and indentation. **Nested** also shows agents
  under their workspace, **Compact** keeps workspace tab counts, and **Separate**
  collects agents in their own panel. Selecting a workspace or agent opens its
  server. Disconnected servers and failed reads remain visible. Other servers'
  context menus offer navigation; switch to their server for workspace and pane
  actions.
- **Agent History** shows the latest 200 conversation entries with search, a
  minimap, and tool details. The **Chat view** toggle reads them as
  conversation bubbles with rendered replies and collapsible tool-call blocks
  that follow new output, plus a message box that types into the agent's
  terminal and shares the pane's terminal composer draft. Paste images or use
  **Add images** to choose them on desktop or mobile; uploaded image paths stay
  in the draft until you send. Enter sends and Shift+Enter adds a line; on
  touch keyboards Enter adds a line and the Send
  button sends. On phones the box replaces the terminal composer dock while
  the chat is open. Sending to an agent that is working, blocked, or in an
  unknown state first shows where the text will land and needs **Send
  anyway**. The timeline view adds User/Agent/Tool filters. Exports are always
  complete. **Session Inspector** adds metadata, a timeline, raw/ATIF
  transcripts, and export.
- **Menu > Configuration > Integrations** installs, updates, or removes Herdr's
  bundled agent integrations (not the agents themselves). See
  [version lookup](docs/ARCHITECTURE.md#agent-integrations).

Session inspection supports **Codex, Claude, Kimi, Grok Build, Pi, Muse Code,
and Antigravity CLI**. Transcripts must be readable by the bridge. Over SSH,
Roamgate reads the session path Herdr reports; it never searches local files for
a remote pane. Muse needs session logging enabled (no `--no-session-log`).
See [History synchronization](docs/HISTORY.md).

## Ranger

Ranger is an **experimental** assistant that answers questions about your
workspaces and can manage them. Open it from the topbar, the mobile **⋮** menu,
or its shortcut.

- **Setup:** connect a model provider in **Settings** and choose which
  workspaces Ranger may access (none by default). See
  [model setup](docs/DEPLOYMENT.md#ranger-model-connection).
- **Ask:** Ranger reads workspace status, agent history, diffs, and terminal
  output, and cites its sources. Type **@** to point it at a workspace or agent.
  When the model shares its reasoning, a collapsible **Thinking** section shows
  it above the reply.
- **Mobile:** Chat and Tasks share a compact header. History, new chat, and
  settings icons sit beside Close. Ranger uses the bottom Message input while
  open, keeping its draft separate from the terminal draft. Model and thinking
  options open above the input; the message box grows with your draft.
- **Steer or queue:** while Ranger answers, **Enter** (or **Steer**) adds your
  message to the current answer after its next step, and **Alt+Enter**
  (**Option+Enter** on macOS, or **Queue**) sends it once the answer finishes.
  Waiting messages show above the message box, where you can edit or remove
  queued ones. After **Stop** they wait until you choose **Send next**.
- **Act:** Ranger can create workspaces, worktrees, tabs, and splits, and start,
  prompt, or close agents and panes. You confirm each action unless
  **High-permission mode** is on. Closing never deletes files or history.
- **Schedule:** the **Tasks** view runs a prompt once, daily, or every N minutes
  while the bridge is running, and can notify you when a run finishes or when
  Ranger decides something needs attention.

Conversations are saved on the bridge and shared across your devices. Ranger
has the same [full authority](SECURITY.md#trust-model) as any Roamgate user.

## Git Worktree Lifecycle

Open **Worktree Lifecycle** from a workspace menu or the command menu to:

- Create a worktree from `origin`'s freshly fetched default branch without
  touching the current checkout. Creation stops if the remote is unavailable.
- See each worktree's path, branch status, uncommitted changes, and PR/MR badge.
- Focus, pull, configure branch updates, or remove worktrees (with confirmation
  and hooks).

### Worktree Hooks

`roamgate.json` (or legacy `paseo.json`) defines `setup`, `opened`, `teardown`,
and `removed` hooks. **Hooks are on by default and run unsandboxed repository
code** on the connected host; review or disable them under **Worktree hooks**.
A failed teardown stops removal. See
[configuration](docs/DEPLOYMENT.md#worktree-hooks).

### Automatic Branch Updates

Opt in per checkout to fetch and merge `origin`'s default branch every 10
minutes while the workspace is open. Dirty or detached checkouts are skipped,
conflicts are aborted, and nothing is ever pushed.

## File Explorer and Preview

- Browse the tree with Git status badges, hidden-file toggle, and name/glob
  filtering of loaded entries.
- **Browse filesystem** opens read-only browsing outside the checkout.
- Preview text with highlighting and search, Markdown (with Mermaid diagrams),
  static HTML (workspace CSS/images/fonts; scripts blocked; 512 KiB limit),
  images, PDFs, and audio up to 25 MiB.
- Upload by drag and drop, download files or folders (`.tar.gz`), copy paths,
  create folders, move files by dragging, and delete with confirmation. All of
  this works over SSH (moves need `python3` on the remote host).
- With [host file reveal](docs/DEPLOYMENT.md#host-file-reveal) enabled, local
  loopback clients can open files in the host's Finder/File Explorer.
- Drag a file into a terminal or the composer to insert its path.

## Review Annotations

Open **Annotations** independently of the Inspector.

1. Comment on diff lines, source lines, rendered Markdown, or selected terminal
   text.
2. Edit and reorder comments, then copy them or pre-fill an agent's input.
   **Pre-fill never submits**; review and press Enter yourself.

Drafts stay in this browser and re-anchor to changed files on refresh.

## Diff Viewer

- Compare **Working tree**, **Against branch**, or **Last step** (the latest
  completed agent turn; not proof of which agent made the change).
  Branch comparisons detect the recorded repository default (including `master`
  and custom names), and let you choose a comparison branch per repository.
  Inspection uses local refs only and never fetches from a remote.
- Side-by-side or unified view, search, syntax highlighting, and image previews.
  Generated and very large files start collapsed.
- Stage, unstage, mark resolved, discard, or delete from file/folder menus.
  Destructive actions require confirmation and are rejected if the file changed.

## Mobile and PWA

- **Configuration > Appearance > Layout** selects Automatic, Mobile, or Desktop
  (`?layout=mobile|desktop|auto` overrides it).
- Agent panes have a **Chat** button immediately to the right of **Direct**
  in the bottom bar. It opens Agent History for reading and replying in a
  conversation, without adding a row above the content. Chat is the default
  history view; a saved timeline preference is still respected.
- Mobile agent sessions initially open in Terminal; select **Chat** to opt in.
  Choosing Chat or Terminal is remembered on this browser and reused when
  switching sessions or reloading.
  Shell panes open in Terminal without changing that preference.
- The bottom bar holds **Message…**, **Direct**, **Chat** (for agent panes), **Tabs** (with the workspace's
  tab count, red when another agent needs you) and **⋮**, a menu of views and tools: Chat, Terminal,
  Files, Changes, Commits, Annotations, Ranger, and Workspaces.
- Mobile hides the top tab strip. Use **Tabs** in the bottom bar to switch,
  create, or close tabs. Tabs with multiple panes list their panes underneath;
  select a pane to open it directly, including across tabs. The current pane is
  highlighted, without a separate pane-switching toolbar above the terminal.
- Touch scrolls without opening the keyboard. Long-press selects text for
  **Copy**, **Add comment**, or link actions.
- Floating terminal shortcuts (a `2×8` grid plus side buttons) are customizable
  under **Configuration > Behavior > Mobile terminal shortcuts** and can be
  dragged to either edge.
- **Message…** is the editable draft in the bottom bar, with IME,
  dictation, images, and multiline input. Tapping it raises the keyboard and
  reveals **Attachment**, **Keyboard shortcuts**, and **Commands**, in that
  order. Tools expand above the same field, without a separate Composer dock.
  **Insert** adds text without Enter; **Send** adds Enter. The terminal button
  beside Message activates **Direct** (keys go straight to the terminal).
  File and image uploads in Direct paste their paths into the terminal without
  Enter; in Message they insert into the draft. If the original Direct target
  changes during an upload, its paths stay in that pane's draft with a warning.
  While editing a multiline draft (including visual wraps), Message expands
  and temporarily hides Direct, Chat, Tabs, and **⋮**. Leaving the field restores
  the single-line preview and navigation; tapping Message resumes editing.
  Drafts stay in the field when collapsed. Sends, scrolling, and shortcut
  actions leave a dismissed keyboard closed.
  Files and Workspaces keep only the bottom input/navigation row. Ranger Chat
  uses that input for Ranger; its History, Tasks, and Settings keep navigation
  without terminal input. Returning to Terminal restores the tools and
  shortcuts as left, without changing the draft/caret or reopening the keyboard.
  Ordinary Tabs and **⋮** popups keep the underlying page's input-tool visibility.
- The phone's Back gesture or button closes Tabs or **⋮**, then the visible input
  tools or a mobile view such as Workspaces, Files, Changes or Ranger, one per
  press, before leaving the page. Hidden input tools do not intercept a view's Back.
- **Agent terminals** beside Message appears only in ordinary shell terminals
  on mobile, not existing agent or pad terminals. Selecting an agent sends its
  launch command to the current terminal and presses Enter. Start from an empty
  shell prompt and Message draft. A failed send retains the command in Message.
  Use the pencil beside any agent to edit its command, including arguments or a custom
  executable, even when its default command is not detected on the server.
  Commands are saved in this browser per connection and agent; **Reset** restores
  the detected command. Agent status reporting uses its existing Herdr integration.
- The **Commands** button in the input toolbar offers slash commands for
  Claude Code, Codex, Pi, Kimi Code, Grok Build, and Antigravity CLI.
- Install as a PWA for an app-style window; see
  [installation steps](README.md#install-as-a-pwa). **A PWA is not offline
  access**: Roamgate must stay reachable.
- **Configuration > Instance > Title suffix** names each server (for example
  `Roamgate · Home`); see [instance naming](docs/DEPLOYMENT.md#pwa-instance-names).

## Remote, Multi-Client, and Operations

- Save local and SSH connection profiles; each browser selects independently.
  Linux/macOS bridges can reach Unix or Windows SSH hosts. See
  [connection setup](docs/DEPLOYMENT.md#multiple-and-remote-herdr-connections).
- Task notifications for input-required and completed agents, delivered by
  [Web Push](docs/DEPLOYMENT.md#web-push-notifications) even with the page
  closed. Delivery is best-effort.
- Themes, accents, interface scale (80–150%), terminal font, font size, and
  terminal color themes. Preferences sync across tabs in the same browser.
- Run as a [user service](docs/DEPLOYMENT.md#run-as-a-user-service) with
  checksum-verified updates, and probe `/health` or `/healthz`.
- [Command-line tools](docs/DEPLOYMENT.md#command-line-management) such as
  `roamgate doctor`, `url --qr`, `config`, `auth`, and `connections`.

**Normal runtime requires login, including on loopback, and login grants full
terminal/file access.** Read [Security](./SECURITY.md#trust-model) before
sharing access.

## Keyboard Shortcuts

On desktop, press `Cmd+Shift+K` (`Ctrl+Alt+Shift+K` on Windows/Linux) or choose
**Menu > Shortcut cheat sheet** for a filterable overview. Edit bindings under
**Menu > Configuration > Behavior > Keyboard shortcuts** (up to three per
action, with JSON import/export).

| Action | macOS / iOS | Windows / Linux / Android |
| --- | --- | --- |
| Command menu | `Cmd+K` | `Ctrl+Alt+K` |
| Shortcut cheat sheet (desktop) | `Cmd+Shift+K` | `Ctrl+Alt+Shift+K` |
| Sidebar | `Cmd+B` | `Ctrl+Alt+B` |
| Workspace Inspector | `Cmd+Shift+B` | `Ctrl+Alt+Shift+B` |
| Expand / restore Inspector (desktop) | `Cmd+Option+Enter` | `Ctrl+Alt+Shift+Enter` |
| Annotations | `Cmd+Option+A` | `Ctrl+Alt+A` |
| Ranger | `Cmd+Option+Shift+A` | `Ctrl+Alt+Shift+A` |
| Zen mode (desktop) | `Cmd+Shift+Z` | `Ctrl+Alt+Z` |
| Recent pane switcher | `Ctrl+Tab` | `Ctrl+Alt+J` |
| Search panes | `Alt+K` | `Alt+K` |
| Focus terminal input (desktop) | ``Ctrl+` `` | ``Ctrl+` `` |
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

On Linux/Android, new tab is `Ctrl+Alt+Shift+T`, split right is
`Ctrl+Alt+Shift+D`, and split down is `Ctrl+Alt+Shift+S`, avoiding
desktop-reserved keys. Browsers and OSes may intercept some shortcuts; rebind
them or use the menus. Plain `Ctrl+C` always goes to the terminal.
