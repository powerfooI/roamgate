# Changelog

## Unreleased

- Keep split pane widths stable when switching focus between panes, stopping
  terminal content from reflowing on every focus change.
- Open complete terminal file paths across wrapped rows, including indented
  continuations in agent output, from either part of the link.
- Fix copying preview content and file paths when Roamgate is opened over HTTP.

## 0.7.1 - 2026-09-13

- Use Roamgate service, plugin and data names while keeping existing managed
  services controllable after a 0.7.0 update. Stop/uninstall the previous service
  and unlink `herdr.studio` before switching identities; missing data and browser
  preferences are copied without overwriting new values or deleting originals.
  See the [migration guide](./docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).
- Move project links to `powerfooI/roamgate` and the website to `/roamgate/`.
  Old website links do not redirect; update bookmarks. Existing releases and
  local configuration are preserved.
- Add Mobile Layout settings with a configurable breakpoint, saved or URL-forced
  display modes, and separate mobile/desktop sidebar orders; agents appear first
  on mobile by default.
- Restore Page Up/Down in terminal applications such as nano and add configurable
  terminal copy shortcuts while preserving Ctrl+C as terminal input.
- Add platform-aware keyboard presets and a searchable shortcut editor under
  Behavior & automation, with custom bindings and preset import/export.

## 0.7.0 - 2026-09-13

- Introduce Roamgate, formerly Herdr Studio, as an independent community client
  for Herdr, with its own logo, app icons, and social sharing images.
- **Breaking:** commands and release assets now use `roamgate`. Old clients
  cannot update to Roamgate through their default channel, and old latest
  installer URLs stop working. Install manually; existing processes, data, and
  historical releases are preserved. The legacy source installer remains
  available for historical versions. See the
  [transition guide](./docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).
- Accept `ROAMGATE_*` configuration variables alongside `HERDR_GUI_*`; the new
  names take precedence when both are set.
- Show the Terminal theme menu action as a full-width row on mobile and stop the
  Terminal Themes dialog subtitle from overlapping section titles.
- Open relative Markdown document links in the current preview, including heading
  anchors, without opening another Studio window.
- Keep fast terminal wheel scrolling from jumping backward or replaying stale
  positions when terminal frames arrive late.
- Keep Inspector previews and state separate between the main checkout, linked
  worktrees, and SSH destinations when repointing a saved connection. Previously
  shared selections, preferences, and review drafts start fresh per checkout;
  original browser storage is retained.
- Keep the cursor on the selected terminal pane when switching splits, and preserve
  cursor updates and hide/show transitions across incremental repaints.
- Keep the Actions menu on screen and terminal selection aligned with the mouse
  when changing the interface text size.
- Scroll terminal history while drag-selecting beyond a pane edge, preserving
  offscreen selected text when copying.
- Add attention-first agent ordering and collapsible status, workspace, and agent
  type groups in the separate Agents panel, plus named tabs in both nested and
  separate agent rows.

## 0.6.2 - 2026-09-11

- Reload open tabs once when an update removes their cached code chunks, instead
  of crashing when Changes or a terminal is opened.
- Add terminal color themes: choose from built-in presets per dark/light mode,
  or create custom themes with your own colors (Menu → Terminal theme).
- Stabilize split-pane sizing and terminal rendering during navigation and resizing.
- Show loading and retryable errors while terminal layouts are fetched.
- Load the Inspector and file preview on demand to reduce initial JavaScript downloads.

## 0.6.1 - 2026-09-11

- Fix undersized terminal content in split panes when using Herdr 0.9.0 endpoints.

## 0.6.0 - 2026-09-10

- Use stable Herdr 0.9.0 endpoints for terminals, with optional legacy fallback via
  `HERDR_GUI_DISABLE_ENDPOINT=1`; split panes retain their shared layout sizes.
- Keep endpoint workspace/tab navigation local to each browser across reconnects.
  Same-tab pane focus, topology, and sizes remain shared; creation preserves Herdr's cwd
  policy.
- Gate creation and history scrolling on advertised endpoint methods, with reasons when
  unavailable. Missing required pane focus fails without silent legacy takeover.
- Restore endpoint OSC 52 clipboard writes with recent-input filtering. Delivery follows
  the foreground recipient, not the producing pane; delayed/background writes can reach
  a new recipient. The 0.9.0 legacy fallback remains unsupported.
- Restore endpoint app clicks, drags, and wheels; preserve browser selection/copy with
  output paused during selection. Fix Unicode text alignment and stale repaint text.
- Preserve mobile tap-to-type and modified keys including Ctrl+J, Shift/Alt+Enter,
  function keys, and Alt-prefixed controls; wait for terminal readiness and reject
  pending requests on disconnect.

## 0.5.3 - 2026-09-08

- Add basic Herdr 0.9.0 / protocol 22 terminal compatibility, retaining legacy support
  and rejecting unknown protocols. OSC 52 and independent client navigation remain
  unsupported on 0.9.0 in this release.
- Refresh external layout changes after reconnect and explain grouped-workspace close
  refusals without closing the group.
- Keep 200 conversation messages in History regardless of tool volume; hide tools by
  default and load their details on demand. Fix tab-following and smooth independent
  wavebar scrolling.
- Show workspace tab counts and improve compact Inspector navigation; restore Inspector
  retargeting after workspace switches.
- Fix duplicated IME text when switching input sources and theme-mismatched loading
  flashes during terminal paste.

## 0.5.2 - 2026-09-06

- Add a website tutorial, History filters, adjustable text size, and multiline Files
  annotations.
- Drag to reorder workspaces persistently or agents within the separate Agents panel;
  use a bottom-sheet application menu on mobile.
- Improve History refresh speed and tool readability; preserve focus/view mode and
  correct Grok timestamps.
- Make `Cmd+W` close only the active split pane; keep Diff labels and mobile shortcuts
  visible.
- Align terminal default colors with the theme, remove the hidden scrollbar gutter, and
  keep IME preedit at the live cursor inside the viewport.

## 0.5.1 - 2026-09-03

- Add `Cmd+Ctrl+Arrow` pane focus, `Cmd+D` split right, and `Cmd+Shift+D` split down.
- Install Studio with `herdr plugin install powerfooI/herdr-studio` on Linux, macOS, and
  Windows using checksum-verified prebuilt binaries; no source toolchain is needed.
- Manage the service and login URL through plugin actions or an interactive Herdr popup
  panel.

## 0.5.0 - 2026-09-02

- Add a GitHub Pages product tour and configurable server log levels with concise
  defaults and debug diagnostics.
- Annotate diff lines, source lines, and rendered Markdown; organize checkout-scoped
  drafts, copy feedback, or pre-fill an agent without submitting. Changed anchors retain
  their captured context with stale markers.
- Add per-file and bulk Git actions for staging, unstaging, resolving, discarding
  unstaged changes, and deleting untracked files. Destructive actions require
  confirmation and recheck file status/content to protect newer work.
- Dim ignored files and simplify file rows; use Inspector header buttons instead of Esc
  to expand, restore, or close it.
- Fix Changes summaries and diffs for Git paths containing spaces, quotes, or
  backslashes.

## 0.4.12 - 2026-09-01

- Fix preview selection and copying, including text outside the viewport. Cmd/Ctrl+A
  selects only the preview; the file header Copy button copies the full file.

## 0.4.11 - 2026-08-31

- Add a mobile composer for IME, dictation, multiline editing, and terminal shortcuts.
  Insert adds text without executing; Send adds exactly one Enter.
- Paste or pick images in the composer; upload once and send their paths only on Insert
  or Send.
- Keep unsent drafts in memory per connection/pane, never persisted; warn before closing
  a pane, tab, or workspace with a draft.

## 0.4.10 - 2026-08-29

- Add a mobile tab-switcher sheet for creating, switching, and closing tabs.
- Preview PDFs and workspace-local Markdown images; show agent working directories in
  the workspace tree.
- Use file names as preview headings, a separate Changes toggle, and one file-action
  menu.
- Simplify workspace hierarchy markers, spell out Worktree badges, and move agent status
  before tab names.

## 0.4.9 - 2026-08-28

- Rebrand the app as **Herdr Studio**: page title, brand header, in-app copy, and
  documentation.
- Disable pinch and double-tap zoom on phones so the terminal layout stays fixed.
- Hide floating action buttons while the on-screen keyboard is open.
- Keep desktop file downloads as direct downloads instead of opening the system share
  sheet (e.g. macOS Safari).
- Keep the mobile terminal flush with the on-screen keyboard so no black strip appears
  above it, including with third-party iOS keyboards.

## 0.4.8 - 2026-08-27

- Add a Last step scope to Changes that preserves the latest completed agent activity,
  including commits and untracked files.
- Add an interactive message minimap to session History.
- Show user and assistant messages together in session History.
- Improve session History and dialogs on phones, including keyboard, zoom, and safe-area
  handling.
- Prevent touch taps from leaving tooltips stuck.

## 0.4.7 - 2026-08-26

- Unify Files and Changes around shared Git status, keyboard navigation, and inline diff
  controls.
- Restore mobile PWA terminals after switching apps or leaving the lock screen.

## 0.4.6 - 2026-08-25

- Add a preference to disable update checks and native Windows ARM64 packages; build
  with Bun 1.4 to prevent ARM64 service crashes.
- Reorganize application, workspace, and agent menus; group pause/reconnect controls and
  improve mobile notification placement.
- Keep large diffs responsive with refresh progress; fix narrow Inspector layout and
  wrapping.
- Restore terminal frames after resuming sync, keep worktree badges visible, and make
  dialog Enter behavior consistent.

## 0.4.5 - 2026-08-23

- Add Windows x64 support with native named pipes and per-user startup tasks; make
  service installation/removal Unicode-safe and recoverable.
- Reduce idle rendering and suspend fallback polling while hidden.
- Recover terminal streams after another GUI client takes over a pane, and restart
  metadata/update polling after connections settle.

## 0.4.4 - 2026-08-22

- Allow resizing the Files/Changes navigation list in docked Inspectors.
- Retry navigation issued during reconnect; restore terminals after layout changes,
  mobile resume, and attachment to Herdr 0.8.2.
- Keep file/session downloads inside the iOS PWA and stop selections growing after a
  lost mouse release.

## 0.4.3 - 2026-08-22

- Add a dockable Workspace Inspector for Files, Changes, and Agent History, preserving
  each checkout's view and layout.
- Nest agents under workspaces by default and streamline desktop/mobile navigation, pane
  controls, and keyboard focus.
- Isolate Files/Changes by connection and checkout; retain completed Agent History
  without live status.

## 0.4.2 - 2026-08-20

- Add configurable mobile paste for terminal text and images.
- Render Mermaid files and Markdown Mermaid blocks.
- Add a System theme that follows OS appearance changes.
- Keep the default local server when creating connection profiles.
- Infer default remote socket paths for SSH connections.
- Make Markdown code blocks readable in light mode.
- Use the in-app confirmation dialog when removing connections.
- Keep overlays open while terminal output streams.

## 0.4.1 - 2026-08-20

- Restore WebSocket access behind reverse proxies that rewrite the Host header.

## 0.4.0 - 2026-08-20

- Manage multiple local and SSH-backed Herdr servers from one bridge; reload the browser
  or PWA from the application menu.
- Refine dialogs, notifications, and dates; deliver agent status changes immediately and
  refresh workspace status when returning to the page.
- Prevent stale work crossing connection generations.
- Recover Apple IME input and restore full-page Page Up/Down in fullscreen Pi.

## 0.3.5 - 2026-08-18

- View full agent messages as sanitized Markdown or raw text; present session activity
  as collapsible chronological steps.
- Collapse Diff Viewer files and improve mobile/no-wrap layouts.
- Use `Alt+1` through `Alt+9` for numbered command-menu actions to avoid
  browser-reserved shortcuts.
- Keep WebSockets open under backpressure while protecting against slow clients; restore
  selection after releasing pane dividers outside the window.

## 0.3.4 - 2026-08-17

- Run the first nine visible command-menu actions with `Cmd+1` through `Cmd+9`, with
  matching shortcut hints beside each action.
- Recover iOS third-party IME input missed by xterm.
- Route complete native iOS paste mutations through the terminal paste API when the
  ClipboardEvent text is missing or truncated.

## 0.3.3 - 2026-08-13

- Add a customizable 2-by-8 mobile terminal shortcut editor.
- Pin workspaces and linked worktrees in the Workspace tree.
- Collapse linked worktrees beneath their repository.
- Add clearer linked-worktree badges.
- Route Page Up and Page Down shortcuts through terminal scrollback.
- Hide overlay scrollbars inside dialogs, menus, and mobile controls.

## 0.3.2 - 2026-08-10

- Restore compatibility with reverse proxies that rewrite the Host header.

## 0.3.1 - 2026-08-10

- Check for updates through small platform manifests instead of full archives.
- Harden automatic updates, checksum verification, and executable replacement.
- Block cross-origin and DNS-rebinding access to privileged APIs.
- Stabilize terminal sizing during tab switches and slow connections.
- Keep clipboard relay dimensions stable across tab switches.

## 0.3.0 - 2026-08-07

- Publish the initial release with terminals, workspace tools, file browsing, diffs, and
  Agent Session Inspect.
- Ship checksum-verified standalone packages for Linux and macOS on x86-64 and arm64.

## 0.2.31 - 2026-08-07

- Preserve rapid Chinese IME punctuation input without dropped, duplicated, or reordered
  characters.

## 0.2.30 - 2026-08-07

- Dismiss ordinary in-app notifications after 15 seconds while keeping active operations
  visible.
- Open existing worktrees from their repository source even when another checkout is
  focused.

## 0.2.29 - 2026-08-06

- Show the running herdr-gui version beside the app title.
- Relay remote OSC 52 clipboard requests to the browser that initiated them, including
  Pi file-tree copy actions.

## 0.2.28 - 2026-08-06

- Add half-page Terminal history scrolling with `Alt/Option+Page Up/Down`.
- Copy OSC 52 selections from remote Agent and TUI sessions through the browser
  clipboard.

## 0.2.27 - 2026-08-06

- Open the corresponding Agent pane when a task-completion notification is clicked.
- Refresh stale notification targets and fall back to the Workspace when the Agent pane
  has already closed.

## 0.2.26 - 2026-08-04

- Add a repository-scoped Worktree Lifecycle center for checkout status, hooks, pull,
  sync, open, create, and removal actions.
- Align Agent status badges and present repository hook scripts as readable code blocks.
- Keep lifecycle actions scoped to the selected repository when several Git repositories
  are open.
- Let Herdr close a worktree workspace before residual process cleanup to avoid stale
  working-tree removal failures.

## 0.2.25 - 2026-08-03

- Align Agent status badges in the recent Pane switcher with Workspace status styles.
- Recover stale worktree removals while preserving residual files and stopping checkout
  processes.
- Keep long hook and removal operations connected, then verify cleanup before reporting
  success.

## 0.2.24 - 2026-07-28

- Emit unquoted, safely escaped systemd `EnvironmentFile` paths.

## 0.2.23 - 2026-07-28

- Show assistant replies in Session Inspect with an optional user-only filter.
- Rework Session Inspect around clearer conversation, details, preview, and export
  views.
- Extend accent colors across top-bar controls, File Explorer, and Diff Viewer.
- Recover assistant messages from older Codex sessions without duplicating newer
  records.

## 0.2.22 - 2026-07-28

- Add persistent accent colors, including the original neutral appearance.
- Move the Workspaces, Files, and Diff Viewer controls into the top bar.
- Reorganize Menu into concise preferences, updates, and runtime sections.
- Reject invalid persisted sidebar widths and stabilize Vite development login routing.
- Improve Menu keyboard navigation, Escape handling, and focus restoration.

## 0.2.21 - 2026-07-27

- Add `herdr-gui service reload` for systemd and launchd; preserve managed systemd
  wrappers on reinstall and use portable executable paths.

## 0.2.20 - 2026-07-27

- Install and manage systemd or launchd user services from the CLI.
- Generate persistent login tokens and tokenized URLs for non-localhost access.
- Let the external service supervisor restart the process after automatic updates.

## 0.2.19 - 2026-07-27

- Keep the final Terminal columns visible with Apple system monospace fonts.
- Name tabs created with `Cmd+T` consistently as `Tab N`.

## 0.2.18 - 2026-07-27

- Add macOS tab shortcuts and workspace-first recent pane switching with agent status.
- Add portable releases and systemd/launchd service examples with supervisor-aware
  restarts.
- Scroll history with the wheel and Page Up/Down without sending arrows; preserve
  scrolling during selection and tab confirmations across views.
- Verify release checksums before installation or automatic updates.

## 0.2.17 - 2026-07-24

- Add an architecture-aware installer for Linux x86-64 and macOS Apple Silicon.
- Select the correct release archive and preserve process arguments when automatically
  updating on Linux or macOS.

## 0.2.16 - 2026-07-24

- Send `Alt+Enter` and `Shift+Enter` as distinct terminal sequences.
- Preserve IME composition and additional modifiers in Terminal shortcuts.

## 0.2.15 - 2026-07-24

- Support Herdr protocol 17 and future compatible protocol versions.
- Recover stalled browser bridge connections and refresh reused terminals for additional
  clients.
- Avoid redundant embedded asset rewrites that caused development reload churn.

## 0.2.14 - 2026-07-24

- Add Pi agent icons, message history, session summaries, and ATIF export.
- Read agent session files from the remote host when herdr-gui connects over SSH.

## 0.2.13 - 2026-07-22

- Remove Herdr Server update checks and prompts while retaining connected version and
  protocol diagnostics.

## 0.2.12 - 2026-07-20

- Restore Terminal rendering with Herdr 0.7.4 by avoiding repeated attach transitions.
- Preserve indentation when pasting multiline text into terminal editors.

## 0.2.11 - 2026-07-20

- Add Grok Build session discovery, message history, Timeline, and ATIF export.
- Show passive Herdr Server update status and update guidance in Menu.
- Negotiate and validate Herdr thin-client protocols 14 through 16 instead of assuming
  protocol 14.

## 0.2.10 - 2026-07-15

- Add overlay scrollbars that preserve content width and full-message viewing in Session
  Inspect.
- Create new worktrees from the latest `origin/main` revision.
- Create and group worktrees under the workspace that initiated them, including
  repositories opened in multiple workspaces.
- Reload the frontend after self-update and harden static asset and SPA fallback
  handling.

## 0.2.9 - 2026-07-15

- Preview existing workspace-relative Terminal file paths with `Cmd/Ctrl+Click`,
  including SSH workspaces.
- Restore Kimi assistant, reasoning, tool, and token details in session timelines
  without duplicate messages.
- Stop Terminal HTTP links before trailing parenthesized prose.

## 0.2.8 - 2026-07-13

- Add opt-in automatic `origin/main` updates for open workspaces, with per-repository
  controls.
- Present task notifications as a switch in Menu.
- Prevent automatic updates for dirty, detached, changed, or conflicting Git checkouts.
- Stop Terminal links before Unicode punctuation and invisible characters.

## 0.2.7 - 2026-07-10

- Add a `Ctrl+Tab` recent pane switcher with current-pane marking.
- Use the HTTPS release host for install and self-update downloads.
- Allow terminal scrolling while selecting text.
- Improve Kimi agent icon contrast in light theme.

## 0.2.6 - 2026-07-07

- Add Session Inspect summaries with raw session preview and export.
- Add Timeline and ATIF views for agent sessions, including ATIF export.
- Keep session preview search focused correctly after `Cmd/Ctrl+F`.
- Classify Codex tool output as observations in the session timeline.

## 0.2.5 - 2026-07-06

- Add an agent message history drawer for Codex, Claude, and Kimi sessions.
- Show the Herdr integration install command when session history is unavailable.
- Remove manual send-message actions from Command K and agent menus.

## 0.2.4 - 2026-07-06

- Do not show task completion notifications for the currently active pane.

## 0.2.3 - 2026-07-06

- Stabilize terminal font fallback so Chrome and Safari render closer together.

## 0.2.2 - 2026-07-05

- Fix self-update restarts when herdr-gui runs under a parent process wrapper.
- Show restart mode and diagnostic log path while applying updates.

## 0.2.1 - 2026-07-05

- Add unauthenticated `/health` and `/healthz` endpoints for probes.

## 0.2.0 - 2026-07-05

- Add browser task completion notifications with an Open workspace action.
- Add one-click update and restart for Linux x64 standalone releases.
- Keep password login valid across herdr-gui self-restarts.

## 0.1.10 - 2026-07-05

- Add File Explorer drag-and-drop uploads plus confirmed file and directory deletion.
- Show Git status badges in File Explorer for changed files and directories.
- Move File Explorer delete actions into the right-click and long-press menu.

## 0.1.9 - 2026-07-04

- Show all Diff Viewer files in order with image previews for binary image diffs.
- Add File Explorer downloads for files and directories.
- Keep directory downloads scoped to the workspace and package them as `tar.gz`.

## 0.1.8 - 2026-07-03

- Keep Command K selection anchored to the top result while search results change.

## 0.1.7 - 2026-07-02

- Show per-file added and deleted line counts in Diff Viewer.

## 0.1.6 - 2026-07-02

- Add search controls to Diff Viewer with match navigation and shortcuts.
- Add desktop Diff Viewer wrap toggle.
- Keep split diff panes at equal width when wrapping is disabled.
- Keep hidden File Preview from intercepting Diff Viewer search shortcuts.

## 0.1.5 - 2026-06-30

- Add workspace menu Git pull action.
- Add Diff Viewer mode for comparing the current branch against main.
- Add mobile Ctrl+R shortcut button.
- Improve toast presentation for command and hook output.
- Hide the mobile tab line when there is only one tab.

## 0.1.4 - 2026-06-29

- Render Markdown files in File Explorer with a Raw toggle.
- Open file paths directly from the command menu.
- Preserve Terminal, File Preview, and Diff Viewer state when switching views.
- Keep File Explorer focused on the active preview file and expand parent folders.
- Restore the active File Preview after page refresh.

## 0.1.3 - 2026-06-27

- Styled app-wide tooltips for existing title hints.
- Narrow command-menu close/remove actions to the current workspace, worktree, pane, or
  agent context.
- Remove agent Ctrl+C/Ctrl+D shortcuts from command and context menus.
- Remove File Explorer and Diff Viewer shortcuts from workspace context menus.
- Avoid detecting `/path` fragments inside relative terminal paths as previewable files.

## 0.1.2 - 2026-06-27

- Cmd/Ctrl-click terminal file paths to preview files in a dialog.
- Image previews for common image files, including absolute paths such as `/tmp/...`.
- Keep Agent and Workspace terminal switching in sync after focusing agent panes.

## 0.1.1 - 2026-06-26

- Add searchable, syntax-highlighted text previews with line numbers for local and SSH
  workspaces; preserve UTF-8 at the preview limit.
- Expand folders on single click and load terminal/preview assets on demand.
- Keep the Workspaces shortcut consistent from file preview.

## 0.1.0 - 2026-06-26

- File Explorer side panel with cached directory loading.
- Diff Viewer with changed-file tree, split/unified views, syntax highlighting, and
  mobile diff browsing.
- Shortcut Lookup dialog from the Menu.
- Improve mobile terminal controls with a compact floating shortcut panel.
- Diff Viewer opens with `Ctrl+Shift+G` on desktop.

## 0.0.12 - 2026-06-25

- Show connected client count and allow pausing other herdr-gui clients.
- Show a reconnect shortcut in the top bar when this client is paused or disconnected.
- Move connection pause controls into the Menu connection section.

## 0.0.11 - 2026-06-25

- Pause/resume this browser's Herdr sync; dismiss resumed notices after 5 seconds.
- Remove the `feature/` prefix from lucky worktree branch names.
- Preserve multiline paste and send Shift+Enter distinctly for multiline agent input.

## 0.0.10 - 2026-06-25

- External provider icons for agent rows.
- `Ctrl+1` through `Ctrl+9` shortcuts for switching tabs.
- Improve agent icon and status-dot alignment.
- Improve command menu search ranking with top results and keywords.

## 0.0.9 - 2026-06-25

- Add lucky workspace/worktree names and directional pane focus commands.
- Improve input/confirmation focus and Enter handling; require Cmd/Ctrl-click for
  terminal links.
- Remove the unused Read pane output action.

## 0.0.8 - 2026-06-24

- Add pane split, resize, zoom, focus, and close actions plus a mobile pane switcher.
- Reorganize the command menu and improve mobile safe areas, keyboard, and terminal
  sizing.
- Reduce terminal blank space and improve split-pane attachment stability for one
  browser.

## 0.0.7 - 2026-06-24

- Configure repository-scoped Paseo setup/opened/teardown/removed hooks from the
  workspace menu, with saved per-repository enablement.
- Use only repository `paseo.json` hooks to avoid stale plugin behavior.
- Improve multi-client terminals and weak-network WebSockets; dismiss ordinary notices
  after 3 minutes.

## 0.0.6 - 2026-06-24

- Add automatic update checks and one-click standalone updates with safer same-directory
  binary replacement.
- Add agent/tab context menus, worktree removal commands, and sidebar Git badges.
- Improve mobile/Safari scrolling, selection, paste, and loading; avoid unwanted mobile
  keyboard popups.

## 0.0.5 - 2026-06-23

- Add `herdr-gui --version` and `-V`; ensure releases embed fresh frontend assets.
- Separate before-remove and removed worktree hooks, show results, and recover terminals
  safely after removal.
- Add worktree/tab commands and confirm pane/tab closure; keep important failures in
  dismissible notices.
- Fix terminal focus, Chinese IME/punctuation, copied text, and Safari/mobile selection.

## 0.0.4 - 2026-06-23

- Add terminal HTTP(S) links, a changelog viewer, light theme, `Cmd+B` sidebar toggle,
  and terminal maximize controls; hide sidebar/maximize controls on mobile.
- Improve Chinese text selection, font fallback, punctuation input, and Safari selection
  behavior.
- Add Page Up/Down and macOS line-editing shortcuts.
- Open existing worktrees from workspace menus; speed up terminal switching and
  workspace/agent status refresh with loading indicators.

## 0.0.3 - 2026-06-23

- Actions command combobox for workspace, tab, pane, agent, and hook actions.
- Removed the top-bar updated timestamp.

## 0.0.2 - 2026-06-23

- Version display in Menu.
- Release packaging script for versioned and latest `tar.xz` archives.
- Browser-side image and `Ctrl+V` paste handling in terminal.

## 0.0.1 - 2026-06-23

- Initial web UI, Bun bridge, terminal, worktree, hooks, uploads, and standalone binary.
