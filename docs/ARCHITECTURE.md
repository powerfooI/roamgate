# Architecture

Roamgate's system contracts. See [Features](../FEATURES.md) for UI behavior,
[Deployment](./DEPLOYMENT.md) for configuration, and [Security](../SECURITY.md)
for the trust model.

## System overview

```text
Browser (React + Vite)
   | same-origin HTTP / WebSocket
   v
Bridge (Bun + TypeScript) -- node:net --> Herdr sockets
```

Browsers cannot open Unix sockets or named pipes, so the bridge connects to
`herdr.sock` (NDJSON control) and `herdr-client.sock` (binary terminal traffic).
It also serves the frontend and owns authentication, local/SSH runtimes, host
operations, notifications, health, and updates. React owns presentation and
browser-local preferences; xterm displays output that Herdr renders.

Browser RPC sends `{ id, method, params }` and receives `{ id, result }` or
`{ id, error }`. Events arrive as `{ event: ... }`. Subscribing triggers a fresh
snapshot, and events during a refresh queue another refresh: this reconciles
missed changes but is not a replayable event log.

## Connection isolation

`ConnectionManager` owns the shared profiles and one `ConnectionRuntime` per
profile. Each runtime owns its transport, viewers, subscriptions, caches, and
reconnect lifecycle. Disconnecting stops the runtime and SSH tunnel, never Herdr.

- Every downstream request carries a connection ID and runtime generation and
  holds a lease on a ready runtime. Replies, events, and frames carry the same
  identity; mismatched or stale identities fail without fallback.
- When a runtime is replaced, old leases are retired first. Effects already
  sent may finish, but their results are discarded.
- Authentication, health, updates, and profile management are bridge-global and
  work regardless of runtime state. One failed runtime never blocks others.
- Browser caches, storage, and pending actions are scoped per connection.

## Instance naming

`/api/instance-settings` reads and writes `title_suffix` in the GUI settings
file. Writes need JSON plus the `x-roamgate-settings` header and reject
cross-site requests. The server derives the HTML title and the manifest `name`
and `short_name` from it; the manifest `id`, `start_url`, and `scope` never
change. HTML and manifest responses are not cached.

## Terminal endpoints

### Negotiation and transport

The backend is chosen from a verified protocol allowlist (see
[compatibility](./DEPLOYMENT.md#herdr-compatibility)). Herdr 0.9.x endpoints
require generation 1 and the exact codecs `shell.snapshot.v1`,
`shell.surface.v1`, `shell.input.semantic.v1`, and `shell.blob.v1`; anything
unknown fails closed. Each viewer crops its pane from the shared tab surface.

Capabilities are negotiated per terminal socket and rechecked at dispatch:

| Capability | Contract |
| --- | --- |
| `pane.focus` | Required to attach; no legacy fallback without it. |
| `pane.scroll` | Gates explicit history scrolling. |
| `tab.create`, `workspace.create` | Gate creation from the existing endpoint. |
| `health_check` | Enables ping/pong. |

`surface_delta` and `surface_reuse` are requested by default and stored per
connection (`settings.terminal_transport`). Changing them makes viewers reattach
with a fresh full frame. Invalid updates close the stream rather than show stale
output. These codecs reduce Herdr-to-bridge traffic; terminal messages of 1 KiB
or more are also WebSocket-compressed to the browser. Kitty graphics are not
shown.

### Geometry, input, and selection

`terminal.attach` sends the pane's `cols`/`rows` and optionally the tab's
`surface_cols`/`surface_rows`. Terminals cancel the UI's CSS zoom and scale the
xterm font instead, so mouse and IME coordinates stay correct.

- Input waits for readiness, revalidates its lease, and is never replayed into a
  replacement terminal.
- Endpoint keyboard input uses basic CSI-u for ambiguous modified keys
  (modified Enter, Backspace, Escape, Ctrl+/ vs Ctrl+_); Herdr re-encodes for
  the application. Legacy attachments send raw bytes.
- PageUp/PageDown are sent as semantic input; half-page history uses
  `pane.scroll`.
- Mouse cells are zero-based and pane-local; only a press inside the pane owns
  a drag.
- Selection freezes the displayed frame until cleared. Edge-drag reads history
  one viewport at a time and stops on release, blur, resize, or content change.

### Links

The browser detects URLs and file paths in soft-wrapped text, including
Windows paths. Inferred paths must resolve inside the pane's workspace.

Endpoint repaints carry a `link_frame` identity that changes with content,
scroll, or geometry. `terminal.link.resolve` checks ownership and frame
identity, then uses the frame's OSC 8 table or, on Herdr 0.9.1+,
`pane.link.resolve` to rebuild wrapped URLs. Coordinates are zero-based cropped
pane cells. Ambiguous viewport-clipped URLs are rejected, `pane.link.activate`
is never called, and only HTTP(S) and safe local `file://` targets open. Hover
never activates a link; touch requires an explicit **Open link** or **File
actions**.

## Browser navigation and creation

`browserNavigation.ts` keeps endpoint workspace/tab selection local to each
browser; snapshots provide topology but never override newer selections. Pane
focus within a tab stays shared and is sent through `pane.focus`.

Creation passes `focus: false` and adopts the returned IDs only if the
initiating selection is still current. Omitting cwd preserves Herdr's
`terminal.new_cwd`. `workspace.path` expands `~` on the connection's host,
validates the directory, and returns up to 50 suggestions; creation rechecks the
path before dispatch.

Only the first workspace in an empty session uses control-socket creation. A
20-second admission deadline covers readiness and validation: expired requests
never run, and dispatched timeouts are reported as uncertain.

## Workspace resource ownership

A **checkout** owns Files, Changes, and Commits. A workspace supplies routing, a
tab a return location, and a pane optional context. Changes and Last step
snapshots do not prove which agent made a change.

Git resource keys combine `worktree.gui_settings_key` with the normalized
checkout path, per connection. Workspaces on the same checkout may share caches.
Actions remember their originating checkout and never fall back to a sibling.
Terminals stay mounted while the Inspector changes.

Browser preferences live in namespaced `localStorage` and sync across tabs on the
same origin. Navigation, open files, drafts, and focus stay per tab.

### Last step capture limits and ownership

Last step snapshots the checkout when the workspace goes from active to idle.
Captures include small untracked files and commits made during the turn, use raw
on-disk bytes (no Git filters), and never touch the user's index.

A capture is refused entirely when a file exceeds 8 MiB, content exceeds 32 MiB
in total, or there are more than 10,000 files. It is also refused for symlinks,
special or unreadable files, newline/tab filenames, applicable `filter`
attributes, shared repositories (`core.sharedRepository` other than unset,
`false`, `0`, or `umask`), files on a different filesystem from the Git
directory, or after a 10-second timeout. A refusal is logged and the previous
Last step stays available. Snapshots are not atomic against concurrent edits.

Work happens in an owner-only `roamgate-last-step-capture` directory inside the
checkout's Git directory. Only complete loose objects are hard-linked into Git's
object database; Roamgate never runs `git add`, GC, or deletes user objects.

**Recovery:** a crash can leave that directory behind, and later captures then
refuse to run. Stop captures for the checkout and make sure the capture shell
and its children have exited (reboot if unsure). Then remove only
`$(git rev-parse --absolute-git-dir)/roamgate-last-step-capture`. Never remove
anything from `objects`, `objects/pack`, or the index. Over SSH, a remote capture
may still finish after the local caller fails.

## Filesystem browsing

`file.list` is checkout-relative with realpath/symlink escape checks.
`scope: "filesystem"` with an absolute path enables read-only host browsing; it
is a view mode, not a stored permission. Upload, delete, `file.mkdir`, and
`file.move` are checkout-only and reject absolute paths. Moves use the host's
atomic no-replace rename (`renamex_np`, `renameat2`, or `MoveFileExW`), never
copy, and need Python 3 over SSH.

`file.reveal` runs a fixed per-platform command (`explorer.exe`, `open`,
`xdg-open`), never a shell. It needs `ROAMGATE_ALLOW_FILE_REVEAL=1`, a local
profile, and a loopback peer; loopback does not prove the browser is on the same
machine. See [host file reveal](DEPLOYMENT.md#host-file-reveal).

Previews are inert. SVG is never inserted into the app DOM and carries a
sandbox CSP. HTML previews render in an empty-sandbox iframe with an enforcing
CSP: workspace CSS, images, and fonts are inlined as data URLs; HTTPS
stylesheets load directly from the browser (exposing the viewer's IP); scripts,
forms, frames, and external images/fonts are blocked. Limits: 512 KiB per HTML
or stylesheet, 5 MiB per image/font, 64 resources and 10 MiB per preview
(HTTP 413 beyond that).

## Agent activity

`agent.list` adds `last_activity_at` from the session file's mtime, with a
1.5-second budget; missing data never hides an agent.
[History synchronization](./HISTORY.md) covers transcript projection and caching.

## Agent integrations

`integration.list` uses Herdr's RPC as the source of truth. Missing versions are
filled from read-only `herdr integration status` on the same host (over SSH for
remote connections), only when the CLI version matches the running server. CLI
failures leave versions unknown without failing the list.

## Ranger

The bridge runs one Pi Durable assistant service, independent of the selected
connection and shared by all authenticated browsers through bridge-global
`bridge.assistant.*` RPC and revisioned snapshot pushes. Reconnecting fetches
state; sends are never replayed.

- **Tools** are defined in `server/src/assistant/tools.ts` and run through
  `callWorkspaceTool` against the turn's approved scope. Pi's built-in tools,
  extensions, skills, and project instructions are disabled, and workspace
  evidence is treated as untrusted.
- **Scope:** no workspaces are allowed by default. Each turn captures concrete
  connection/workspace pairs (at most 512) and rechecks runtime leases around
  every read. Only the dedicated confirmation can enable high-permission mode
  (`approval_mode: "auto"` with `workspace_scope: "all"`).
- **Actions:** a proposal pins its runtime lease and target, and
  `action.confirm` accepts only the proposal ID. A receipt is saved before
  dispatch, one action runs at a time, and failed or uncertain actions are never
  retried. Pane/agent closes are refused in multi-pane worktree-root workspaces
  because Herdr cannot prevent an implicit group close.
- **Persistence:** conversations and execution checkpoints live in the assistant
  directory; one bridge process must own it. After a restart, a turn resumes
  only after its endpoints, Herdr boot IDs, and workspaces are re-verified.
- **Tasks** live in `tasks.sqlite`; each state change commits before it is
  published. One scheduled run executes at a time, overdue occurrences are
  combined, and runs re-verify identities and permissions. Run results emit an
  `assistant_notification` push; custom notices are deduplicated by event key.

## Task notifications

With the default `herdr` source, each runtime keeps one passive endpoint shell
(`surface_active: false`) that receives Herdr's `SemanticNotification` (tag 14)
after Herdr applies its own policy. Finished maps to completed and
needs-attention to blocked. The bridge relays these to Web Push and browsers
(`roamgate.task_notification`) and advertises `herdr_task_notifications` so pages
skip their own tracking. Servers without endpoint support fall back to the
`status` tracker, which watches agent transitions (initial state is silent).

Web Push stores private VAPID keys and subscriptions, sends to an allowlist of
push providers with a 10-second deadline, 4 concurrent requests, and a
256-message memory queue. Failures are logged, not replayed. See
[delivery limits](./DEPLOYMENT.md#web-push-notifications).

## SSH transport

Unix SSH runtimes run one OpenSSH process forwarding both sockets into a private
temporary directory. Readiness needs a control `ping` and render handshake.
Transient failures retry six times with backoff up to 30 seconds;
authentication, host-key, and protocol failures do not.

Windows-host profiles instead listen on two local Unix sockets; each connection
spawns an OpenSSH stdio process running Herdr's `remote-api-bridge` or
`remote-client-bridge` through PowerShell. A capability probe rejects missing or
old binaries and stopped sessions.

Destinations must be an OpenSSH alias or `user@host`, passed after `--`.
Host-key checks stay on and authentication is non-interactive. Owned paths are
removed only after the child process exits. Roamgate never installs remote
software. See [connection setup](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

## Distribution model

Production builds embed the frontend and Bun into one executable. Release
binaries, archives, checksums, and update manifests all use the `roamgate` name;
missing or legacy manifests fail closed. Publishing needs all six platform
asset sets. Old clients need [manual migration](./DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).

## Trust boundary

Roamgate is trusted single-user administration; authentication grants full
authority (see [Security](../SECURITY.md#trust-model)). The browser accepts one
bridge hello before other messages; message kinds are validated and downstream
events cannot inject bridge fields. NDJSON lines are size-bounded, and malformed
terminal frames are dropped.

State-changing HTTP endpoints need authentication plus a marker header; the
push and settings endpoints also reject cross-site requests:

| Endpoint | Required header |
| --- | --- |
| Updates | `x-roamgate-update: 1` (legacy `x-herdr-gui-update: 1` is accepted; the new header wins) |
| Web Push subscriptions | `x-roamgate-push: 1`, JSON body |
| Instance settings | `x-roamgate-settings`, JSON body |

Login bodies are limited to 16 KiB (`413`). Headers never replace login.
