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

Browsers cannot open Unix sockets or Windows named pipes. The bridge connects
`herdr.sock` (NDJSON control) and `herdr-client.sock` (binary terminal traffic),
serves the frontend, and owns authentication, local/SSH runtimes, host operations,
notifications, health, and updates. React owns presentation and browser-local
preferences; xterm displays Herdr-rendered output, not a bridge-owned PTY.

Browser RPC sends `{ id, method, params }` and receives `{ id, result }` or
`{ id, error }`. Subscribed events use `{ event: ... }`; downstream traffic also
carries connection identity. Subscription acknowledgements trigger snapshots;
events during refresh queue another refresh. This reconciles missed changes,
not an atomic or replayable event log.

## Connection isolation

A bridge-global `ConnectionManager` owns shared profiles and independent
`ConnectionRuntime` instances. Each runtime owns its transport, viewers,
subscriptions, clipboard relay, services, caches, and reconnect lifecycle.
Render streams open only while viewed. Disconnect/removal stops the runtime and
SSH tunnel, not Herdr or its workspaces.

- Downstream RPC/HTTP requires an immutable connection ID, runtime generation,
  and request-local ready-runtime lease. Replies, events, frames, and clipboard
  pushes carry that identity; HTTP streams recheck it per chunk.
- Replacement retires leases before publishing status. Already-dispatched effects
  may finish on the original host, but retired results cannot publish. Explicit
  malformed, unknown, stale, or unready identities fail without fallback.
  Omitted identities and legacy HTTP aliases are a bounded, logged compatibility
  path for older single-connection clients only.
- Authentication, health, updates, client accounting, and profile management are
  bridge-global and independent of downstream readiness. Global RPC rejects
  misleading connection fields. Starts/stops serialize; shutdown is bounded;
  one failed runtime does not block healthy connections or management.
- Browser caches, storage, mount keys, notifications, and async actions are
  connection-scoped. Switching connections retires the browser lease; same-ID
  runtime replacement clears active and inactive sessions before IDs can recur.

## Instance naming

The authenticated, bridge-global `/api/instance-settings` endpoint reads and
updates `title_suffix` through the GUI settings store's atomic mutation queue.
Writes require JSON and the `x-roamgate-settings` header, reject cross-site
requests, and do not require a live Herdr connection. Existing settings without
this field retain the default `Roamgate` name.

The server derives HTML title/application metadata and both manifest `name` and
`short_name` from the same normalized suffix. HTML values are escaped with
`HTMLRewriter`; manifest values are JSON-encoded. The credentialed manifest stays
at `/manifest.json`, with unchanged `id`, `start_url`, `scope`, and icons. Entry
HTML and manifest responses are private and require revalidation; the push
service worker does not cache them. Frontend startup/focus refreshes read the
same setting, and confirmed saves update document metadata without changing
connection selection or install identity.

## Terminal endpoints

### Negotiation and transport

Backend selection uses a verified protocol allowlist, not browser inference.
[Compatibility](./DEPLOYMENT.md#herdr-compatibility) defines supported versions,
legacy fallback, and clipboard limitations.

Herdr 0.9.0 endpoints require generation 1 and exact codecs
`shell.snapshot.v1`, `shell.surface.v1`, `shell.input.semantic.v1`, and
`shell.blob.v1`. Unknown generations/codecs fail closed. Attachment waits for the
initial snapshot; each viewer crops its pane from the shared tab surface.

Capabilities belong to **each terminal socket**, are renegotiated on reattach,
and are checked again at dispatch:

| Capability | Contract |
| --- | --- |
| `pane.focus` | Required for attachment; absence fails without legacy takeover. |
| `pane.scroll` | Gates explicit history scrolling, not semantic page keys. |
| `tab.create`, `workspace.create` | Gate creation on the existing source endpoint. |
| `health_check` | Enables ping/pong; input and resize are core codec operations. |
| `surface_interest`, `presentation_effects_fence` | Do not authorize surface-setting or fencing controls. |

Endpoint hellos opt into `surface_delta` and `surface_reuse` by default, unless
disabled; each requires a matching welcome capability. Full surfaces, legacy patches,
Base64-bincode deltas, and JSON reuse controls share a connection-local baseline
before cropping. Legacy patches update named panes and replace the cursor
(including `null`); delta/reuse replaces pane, cursor, hyperlink, and scroll
metadata. Geometry changes require a full surface.

Decoders bound collections and validate boot/projection/surface revisions, spans,
and hyperlink indices. Invalid updates close the stream and clear its baseline;
viewers reattach for a fresh full frame rather than keep stale output. A
connection-wide endpoint observer follows the focused Space to report popup
identity even without pane viewers; the popup terminal uses direct attach.
Kitty graphics are not presented.

`settings.terminal_transport.get/update` persists `surface_codecs` per connection
in `settings.json`. Changes close that runtime's endpoint displays and broadcast
`settings.terminal_transport.updated`; viewers reattach with fresh baselines.
Queued attachments reread settings. Configuration closes do not consume takeover
retries; tasks, legacy sessions, and other runtimes are unaffected. This is a
shared preference, not an authorization boundary.

These codecs reduce **Herdr-to-bridge** traffic; browsers still receive cropped
ANSI repaints. Independently, terminal messages of at least 1 KiB use negotiated
WebSocket compression with per-connection context for WebKit compatibility.
Inbound decompression is shared with client context takeover disabled. Smaller
messages, clipboard payloads, and RPC replies stay uncompressed; backpressure
and generation checks still apply.

### Geometry, input, and selection

`terminal.attach` supplies pane `cols`/`rows` and optionally tab
`surface_cols`/`surface_rows` (both integers in 1..65535). Tab dimensions include
pane borders, not app chrome; surface feedback corrects stale hints. Legacy
attachments use pane dimensions. Repaints clip wide characters and cursors to
the viewer's viewport; browsers reject oversized frames after shrinking.

Root CSS zoom scales the UI. Terminals cancel it and scale xterm fonts directly,
keeping cell measurements, IME, selection, and mouse input in viewport CSS pixels.
Popover positioning likewise cancels zoom and reapplies it to content.

Mobile floating controls clamp their rendered position to the visual viewport
and visible input dock, including resize/scroll and dynamic Composer height.
Keyboard lift is transient; only an explicit drag changes the stored placement,
and saves its delta without the temporary lift. When the normal stack cannot
fit, a scrollable compact row reserves space above a height-bounded input dock.
Its toggle remains focus-neutral, while actual navigation retains keyboard
dismissal. These layout adjustments do not send terminal input or change drafts.

Input waits for readiness and revalidates attachment/session/runtime leases;
it is never replayed into a replacement terminal. Disconnect rejects pending
requests and invalidates clipboard ownership.

- Endpoint keyboard input uses bounded basic CSI-u for modified Enter,
  Backspace, Escape, and ambiguous printable ASCII combinations. The bridge
  reconstructs key identity and modifiers before Herdr encodes for the target
  application. Hardware and custom mobile shortcuts preserve Ctrl+/ separately
  from Ctrl+_, and Alt+[ / Alt+O cannot consume following text as escape prefixes.
  Configured terminal actions take precedence; composition, AltGr, and Apple
  Option text remain native. Legacy/shared attachments retain raw-byte encoding
  because they bypass the semantic classifier. Browser/OS-reserved shortcuts
  are available only if the browser delivers their key events.
- Full PageUp/PageDown sends semantic input for Herdr to route by PTY mode;
  explicit half-page history uses `pane.scroll`, even in mouse-aware apps.
  Legacy attachments retain PageKey/Wheel routing.
- Mouse cells are zero-based and pane-local. Only an in-pane press owns a drag;
  subsequent positions clamp to edges. Reporting changes/closure cancel ownership.
- History scrolling coalesces wheel intent while awaiting RPC and viewport
  feedback, without blocking other commands. No-op replies need no repaint.
  Completed movement is not rebased by history growth; external viewport changes
  become authoritative when no newer intent is queued. Input, missing metrics or
  panes, and closure cancel queued movement.
- Browser selection holds the latest repaint until cleared. Session changes
  retire pending presentation; replay never sends input. Edge-drag history reads
  one overlapping viewport at a time, accepting matching content revisions and
  retaining immutable cells for the complete copied range. Release, blur, lost
  mouse-up, resize, or reset stops scrolling. Content/geometry changes preserve
  captured text but stop further history requests.

### Links

Local detection scans soft-wrapped text with cell coordinates. File detection
also considers bounded, indented continuations because endpoint cell repaints
lack soft-wrap metadata; inferred paths must resolve within the pane's workspace.
File detection accepts POSIX paths plus Windows drive (`C:\`) and backslash
paths; relative paths must resolve, and absolute paths link with `/` separators.
Links detected from text check only that their row still shows the same text
when clicked, so repaints elsewhere, such as TUI timers, do not disable them.
Blank lines separate contexts. Local URL detection never guesses missing tails.

Endpoint repaints carry an opaque `link_frame` identity, stable across identical,
cursor-only, and focus-only surfaces. Content, hyperlink, viewport/scroll, input,
or resize changes invalidate it. Identical repaints do not rewrite xterm, keeping
native link IDs and in-progress clicks intact.

`terminal.link.resolve` verifies attachment ownership and frame identity. OSC 8
uses the cropped frame's hyperlink table; optional plain-text resolution runs on
that exact socket with its content revision and scroll offset. Coordinates are
zero-based **cropped-pane display cells**, never surface origins or CSS pixels.
Hover probes are bounded and independently timed out; hover never activates.

Herdr 0.9.1's `pane.link.resolve` returns inclusive visible regions, not URLs.
Roamgate reconstructs complete HTTP(S) targets, including wrapped/wide cells,
but rejects ambiguous viewport-clipped URLs. It never calls `pane.link.activate`,
which can invoke host plugin handlers. OSC 8 retains explicit destinations even
for partial labels. Local `file://` targets require decoded absolute host paths
and empty/`localhost` authorities; network hosts, UNC paths, credentials,
queries/fragments, malformed encoding, and control characters are rejected.
Other URI schemes are not opened.

Async lookups recheck frame, buffer, geometry, navigation, and connection state,
even while selection freezes presentation. Once clicked, a file menu survives
ordinary output but closes on connection/workspace/navigation changes. Web links
open in the browser; files use the pane's workspace, not later global focus.

Touch long-press resolves the original touched cell, with at most one upstream
probe, then requires an explicit **Open link** or **File actions** gesture.
Selection edits, cancellation, multitouch, scrolling, frame changes, resize, and
reconnect retire lookups. Unsafe explicit OSC 8 targets and failed endpoint touch
reads never fall back to URL-looking labels. Legacy touch supports plain-text
URLs/paths only, without explicit OSC 8 cell metadata.

## Browser navigation and creation

`browserNavigation.ts` projects endpoint browser-local selections into shared UI
fields. Snapshots supply topology, not subsequent navigation; stale layouts and
results cannot overwrite newer selections. Legacy navigation, topology changes,
terminal dimensions, and native same-tab pane focus remain shared.

Active selection/clicks send `terminal.focus` through the attached `pane.focus`
endpoint. Focus restores after split attachment, not on routine frames/snapshots.
Requests serialize per browser across endpoint lanes; superseded selections are
discarded and ownership/leases rechecked. Same-tab cursor ownership remains shared.

Creation uses explicit context and `focus: false`; returned IDs are adopted only
while the initiating selection and lease remain current. The bridge validates
and strips Roamgate-only `browser_source`, then uses the existing endpoint's
serialized focus/scroll lane without another endpoint or focus call. Omitting
synthetic cwd preserves Herdr's `terminal.new_cwd`; explicit cwd wins. Shared
same-tab focus still controls the `follow` source.

Missing source attachments fail. Only first-workspace bootstrap uses control
creation, serializing an empty-topology check per runtime. Competing requests
retry when topology becomes nonempty. A 20-second admission deadline covers
readiness, validation, and queuing: expired undispatched mutations never execute;
dispatched timeouts report uncertain completion, requiring inspection before retry.

## Workspace resource ownership

A **checkout** owns Files/Changes/Commits; a workspace supplies routing, a tab a return
location, and a pane optional path/session context. Repository groups are not
merged working trees. Changes and Last step snapshots do not prove agent ownership.

Git resource keys pair endpoint-qualified `worktree.gui_settings_key` with the
normalized checkout path, scoped by connection. Blank keys fall back to the
trimmed repository key, which cannot distinguish endpoints; enriched identities
do not inherit fallback state. Persistent keys exclude runtime generations.
Non-Git resources use workspace identity.

Shared-checkout workspaces may share caches, but requests retain workspace/runtime
leases and resource revisions. Refresh/removal retires old prefetches. Tab/pane
IDs never own caches. Legacy repository-wide Inspector state is retained but not
automatically migrated because it lacks checkout identity.

Actions capture the originating workspace. A vanished workspace can rebind only
to the same checkout; missing paths never fall back to siblings. Agent cwd is
used only inside the checkout. Removal clears only that checkout's state; closing
one workspace retains resources another workspace still uses. Terminals stay
mounted across Inspector changes; layout preferences and content caches are separate.

Browser UI preferences share namespaced local storage across tabs at the same
origin. Subscribers normalize current keys, legacy keys and deletion markers,
then reread effective values so cleared preferences cannot revive legacy values.
Appearance, layout, shortcuts, pins and display options update without reloading.
Inspector geometry is shared; active views, files, workspace/tab navigation,
drafts and focus stay local to each tab. A saved input-mode choice is read on
explicit dock opening and never remotely enables Direct input in a live session.
Session-storage reload guards and live connection controls remain tab-local.

### Last step capture limits and ownership

Last step captures checkout contents at workspace active/idle boundaries, not
when Changes is viewed. Captures include small untracked files and changes
committed during the turn; they never stage files in the user's index. A private
copy of the current index preserves newly staged gitlinks and sparse-checkout
metadata. Absent skip-worktree entries retain their indexed Git objects rather
than appearing deleted. Materialized files use raw on-disk bytes, without Git
clean filters, CRLF conversion, or `working-tree-encoding` conversion, and override
their indexed contents. Initialized nested repositories retain their current
commit even when untracked; uninitialized submodules retain their indexed commit.
Regular files retain their executable/non-executable distinction. Resolved Git
metadata directories inside the checkout are excluded from capture, including
nonstandard separate Git directories and linked-worktree shared metadata.

Automatic capture refuses the whole snapshot when a file exceeds 8 MiB, regular
file content exceeds 32 MiB in total, or there are more than 10,000 regular files.
The byte limits apply to the bytes actually copied, including tracked changes,
not just preflight sizes. Applicable `filter` attributes (other than unset or
unspecified), symlinks (including symlink ancestors), special/unreadable files,
and newline/tab filenames are unsupported and cause refusal. Unused filter
configuration does not prevent capture. Shared repositories are unsupported:
capture refuses enabled or unrecognized effective `core.sharedRepository` values
(including inherited configuration) before creating quarantine storage or
publishing objects. Only an unset value, `false`, `0`, or `umask` is supported;
manual object publication does not implement Git's shared permission handling.
A capture also fails if required shell file-size limits, hard links, or the GNU/BSD `dd` byte-count report are unavailable;
files on another filesystem from the Git directory cannot be pinned by hard link.
The command has a ten-second caller timeout and refuses to begin publication
once nine seconds have elapsed on the executing host. A refusal is logged and
never publishes a partial range; the previous successfully completed Last step
remains available. Snapshots are not atomic against concurrent file edits.

Capture uses an owner-only, exclusively created
`roamgate-last-step-capture` directory inside the checkout's Git directory (the
worktree-specific Git directory for linked worktrees). Bounded copies, temporary
objects, and the scratch index stay there until Git has finished successfully.
Only complete loose objects are published, by non-overwriting hard links into
Git's ordinary object database. No automatic `git add` or streaming pack write
runs against the user's objects. Successful objects deduplicate normally and
remain subject to Git's existing unreachable-object garbage collection; Roamgate
does not run GC or remove user object files. Metadata and temporary object copies
require space in addition to the 32 MiB content budget.

Normal completion and confirmed command failures remove the owned directory.
Signals or crashes retain it: later captures refuse the existing directory rather
than deleting a possibly live lock or allocating replacement scratch storage.
Disposal does not delete uncertain storage. The `owner-pid` file is diagnostic,
not proof that descendants have exited. For recovery, stop captures for that
checkout and confirm that its capture shell and all children have exited (reboot
the executing host if uncertain). Only then remove the exact
`$(git rev-parse --absolute-git-dir)/roamgate-last-step-capture` directory. Do not
remove anything from `objects`, `objects/pack`, or the user's index.

SSH uses the same script on the selected host. Killing or losing the local SSH
transport does not guarantee a remote signal: an unsignaled remote capture can
finish, publish bounded complete objects, and clean its directory after the
caller has failed. Those objects may be unreachable; no successful snapshot token
is returned to the failed caller. Concurrent captures still contend on the same
fixed remote ownership directory. No remote process-tree termination is assumed.

## Filesystem browsing

`file.list` is checkout-relative with realpath/symlink escape checks. Each
filesystem listing explicitly sends `scope: "filesystem"` and an absolute host
directory; replies confirm scope and return absolute entries. The mode is
view-local, not a persisted permission; retired responses cannot replace a new
view. Search filters loaded entries only.

Absolute previews use `scope=filesystem` download URLs; relative Markdown links
and images resolve beside their source. Upload/delete remain checkout-scoped.
`file.reveal` opens the host file manager with a fixed per-platform argv
(`explorer.exe`, `open`, `xdg-open`), never a shell. It is disabled unless the
host opts in with `ROAMGATE_ALLOW_FILE_REVEAL=1`, and still refuses SSH profiles
and non-loopback peers. The hello `file_reveal` capability reports host opt-in
and peer eligibility; the UI also checks the selected profile. Loopback peers
can be forwarded/tunneled remote browsers: neither TCP loopback nor the browser
URL proves same-machine access. See [deployment](DEPLOYMENT.md#host-file-reveal).

Reveal validates scope explicitly: workspace paths must be relative (including
on Windows), with realpath/symlink confinement; only `scope: "filesystem"`
permits absolute paths outside the checkout. Changes sends `source: "changes"`
with a Git-root-relative path. The server resolves the workspace's Git root and
uses actual existence, not Git status codes, falling back to the nearest existing
ancestor inside that root. Ordinary explorer requests still fail on missing
paths. Download behavior is unchanged. Windows foreground focus through `user32`
(`bun:ffi`) is best effort, not guaranteed; the host needs a usable desktop.
Explorer caches are separate from lazy UI code. Mermaid previews share a lazy
renderer, strip wrappers/metadata only for detection, and retain original source.
Images are inert elements; SVG is never inserted into the app DOM, and direct
SVG responses carry a sandbox CSP blocking scripts and external resources.

HTML previews use a separate empty-sandbox iframe and an enforcing response CSP,
including on direct navigation. The server embeds workspace CSS, images and fonts
as data URLs; Bun's CSS bundler resolves imports and asset URLs. Relative paths
resolve beside their document or stylesheet; root-relative paths resolve within
its workspace. Realpath checks reject resources outside that workspace. HTTPS
stylesheets and their CSS imports are loaded directly by the browser, not fetched
by the bridge; protocol-relative stylesheet URLs use HTTPS. Stylesheet links use
`no-referrer`, and document-supplied referrer metadata is removed. CDN requests
expose the viewer's IP address and are not covered by workspace read limits.
Scripts, forms, embedded documents, external images/fonts and HTTP stylesheets
are blocked. Missing or unsupported workspace resources are omitted. Ordinary
downloads retain original bytes.

HTML and each workspace stylesheet are limited to 512 KiB, each workspace
image/font to 5 MiB, and a preview to 64 resource paths and 10 MiB of resource
bytes. Resource-bearing style processing is limited to 256 blocks/attributes,
with a 20 MiB embedding/output budget. Local and SSH readers check size and read
at most the limit plus one byte to detect growth; oversized previews return
HTTP 413. HTML requests have a 120-second HTTP idle timeout for preparation over
SSH. The source view and downloads remain available.
These limits do not bound decoded image memory or browser rendering cost. User
links and deliberate copy/drag into other controls remain untrusted user actions.

## Agent activity

`agent.list` adds optional `last_activity_at` from session-file mtime without
parsing transcripts. Checks have bounded concurrency and a 1.5-second budget;
missing metadata never removes agents. Remote IDs needing local directory search
stay unresolved. Idle ordering uses mtime, then Herdr state-change sequence,
without browser activity history. [History synchronization](./HISTORY.md) owns
projection, caching, and incremental transcript contracts.

## Agent integrations

`integration.list` keeps Herdr's targets and installation states authoritative.
Missing versions are supplemented by read-only `herdr integration status` on the
selected host: locally for local connections, or through that connection's SSH
account. The CLI binary version must match the running server's `ping` version;
per-agent state and any existing version fields must agree before merging.
The bridge/SSH account must use the same agent configuration environment as Herdr.
RPC metadata is never overwritten, and a `current` state alone does not imply an
available version. CLI commands have five-second timeouts; missing binaries,
failed SSH commands, malformed output, and version mismatches leave missing
metadata unknown without failing the list. There is no remote-to-local fallback.

## Ranger

The bridge owns one Pi Durable assistant service, independent of the selected Herdr
connection. Authenticated browsers share its configuration, saved conversations,
active conversation, and single active turn. `bridge.assistant.*` RPC and dedicated
assistant snapshot pushes are
bridge-global; snapshots carry a service instance ID and monotonically increasing
revision. The browser reconciles pushes and replies, retires old instances, and
fetches state after reconnect without replaying sends. Request IDs deduplicate
explicit retries. Hiding the window only changes presentation; stopping work is
a separate RPC.

Model credentials default to the separate Roamgate Ranger store. Reusing the
bridge OS account's Pi credentials requires an explicit source choice. Login
captures that choice and updates only the selected store; configuration changes
are blocked until login completes or is cancelled. Provider prompts and authorization URLs stay out
of conversation history and persisted snapshots; provider credentials remain on
the bridge host. [Deployment](DEPLOYMENT.md#ranger-model-connection) owns paths
and setup instructions.

The protocol-independent tool catalog in `server/src/assistant/tools.ts` owns
tool names, descriptions, and JSON schemas. `callWorkspaceTool` validates the
named tool and arguments before invoking a reader bound to the service's
approved turn scope. Its result keeps text and sources separate; the Pi adapter
formats that result for the model. Adapters share this execution entry point and
the existing context reads, including cancellation and safe error handling.
The catalog does not grant workspace access: adapters must authorize and capture
the scope on the server before binding a reader. Runtime leases remain private
to the context layer.

The model receives `workspace_status`, `workspace_history`, `workspace_diff`,
and `workspace_terminal`, plus six proposal tools for workspace creation,
worktree creation, tab creation, pane splitting, agent startup, and agent prompts.
By default, proposal tools prepare previews for user confirmation. In explicitly
enabled high-permission mode, the service executes the same validated operations
and returns their actual receipts to the model. Built-in tools and discovered extensions, skills,
prompts, and project instruction files are disabled. Evidence is bounded and
treated as untrusted content. The service validates the selected turn scope
against explicitly allowed connection/workspace pairs; none are allowed by
default. Explicitly confirmed high-permission mode also authorizes current and
newly discovered workspaces without changing the saved normal-mode selection.
The `workspace_scope: "all"` consent marker is required alongside automatic
approval; legacy automatic approval alone retains its selected scope. Only the
dedicated permission confirmation can grant the broader scope. Allowed and
per-turn scopes each contain at most 512 workspace pairs, sharing the inventory
bound. A truncated inventory cannot be used as a complete high-permission turn.
Inventory reconciliation prunes saved selections only for removed configured
connections or complete successful current workspace listings. Incomplete,
failed, and disconnected listings do not prove deletion. Running turns and tasks
retain concrete admitted identities; live permission checks still apply after
the global mode changes.
Each turn captures runtime identity/generation and rechecks its leases
before and after reads. A replaced runtime or vanished workspace fails without
falling back to another host or workspace.

`workspace_diff` lists working-tree changes when `path` is omitted. To read a
listed file, pass its `path` and `kind`: `staged`, `unstaged`, `untracked`, or
`conflicted`. Omitting `kind` reads unstaged changes.

`workspace_terminal` reads the selected pane's recent output, including its active
agent output, through Herdr `pane.read`. The model can choose `lines` from 1 to
1,000; omitting it reads 120 lines. The response identifies its requested line
window and retains the newest 32,000 characters when the text budget is exceeded,
with an explicit truncation warning. Reads allow 25 seconds for Herdr to collect
supported idle agents' application history and restore their viewport. Available
history depends on Herdr support and agent state; increasing the requested line
window does not guarantee recovery of every application-owned response.

Each proposal captures its original runtime lease and exact target. Agent
operations also recheck the pane occupant before execution. Tab creation uses
Herdr's default terminal tab in the workspace's verified directory. Pane splitting
pins the source tab, pane, terminal, working directory, and right/down direction;
confirmation rechecks these identities before changing the layout. Result reads
verify the created tab or pane and include its identifiers in the receipt.
Models can read `workspace_status` after confirmation before proposing an agent
start in a newly created pane. Authenticated bridge
browsers can confirm or cancel the shared preview through `action.confirm` and
`action.cancel`. Confirmation accepts only the proposal ID, never new parameters.
The service saves an executing receipt before starting an operation and admits
only one operation at a time. Duplicate confirmations return the same receipt.
Result reads verify workspace creation and agent startup; prompt delivery is
reported separately from whether the agent completed the requested task. Failed
or uncertain operations are not automatically retried.

`configure_approval` persists the global `approval_mode` independently of model
and workspace configuration; missing values mean `manual`. Ordinary `configure`
preserves the live mode, so stale browser settings cannot re-enable it. Automatic
execution requires both the admitted turn's mode and the current global mode to
be `auto`, checked after preparation and immediately before execution. Switching
back to `manual` is allowed during a turn and prevents subsequent automatic
operations. Already dispatched effects retain their ordinary receipt semantics.
Automatic action and task-creation tools execute sequentially and remain unsafe
to replay. Revocation before action reservation leaves a pending preview; a
reserved action rejected before dispatch returns a failed receipt stating that
nothing was sent. Automatically
created schedules return confirmed task receipts through the same tool path.

Worktree creation shares the ordinary UI's base synchronization, parent tracking,
and setup-hook execution. A changed setup command requires fresh confirmation;
an already-created worktree can therefore have a partial setup result. New
questions or configuration changes retire pending previews. On bridge restart,
pending previews become cancelled and executing receipts become uncertain;
captured execution closures are never restored. Manually confirmed results clear
retained model context and are supplied as receipts in subsequent questions;
automatic results are returned within the active durable turn. Creating a
workspace does not add it to the allowed scope.

Sources carry their workspace, runtime generation, kind, and read time. They
describe evidence at that time rather than live workspace state; browser source
navigation rechecks runtime generation. Configuration, transcript, deduplication
IDs, and model context are persisted in private bridge data. Changing allowed
workspaces, turn scope, or captured runtime generation clears retained model
context before the next turn. **New chat** archives the current nonempty
conversation and starts a new transcript and model context. `select_session`
restores a saved conversation's transcript, model context, and deduplication IDs
while keeping the current global configuration. New chats and switches require an
idle service and retire pending action previews; archived actions never replay.
Snapshots include the active session ID and summaries for the history list. A
send may include that session ID to reject a stale browser's submission after
another device changes the active conversation. The service records an admitted
run before submitting it to a persistent Pi Durable conversation. Reopening the
bridge resumes the same request without a browser resending it. Graceful shutdown
pauses work; **Stop** explicitly aborts it. Recovery waits for the original
connections, verifies their configured endpoint fingerprints and Herdr boot IDs,
and checks workspace directory/worktree identities before acquiring fresh leases.
Changed or unsupported identities, removed permissions, and unavailable original
models prevent automatic recovery. Unsent drafts stay in browser-tab memory,
keyed by conversation.

Completed tool results are retained. Interrupted reads may replay after scope
validation; proposal tools are not replay-safe. Confirmed operations retain their
existing receipt and uncertainty rules and are never automatically repeated.
Interrupted model streams are regenerated; aborted partial answers are excluded
from the completed answer displayed in the chat.

Each retained transcript is limited to the newest 80 messages and 1 MB of serialized
UTF-8 data. Answers are capped at 32,000 characters, 64 tool activities, and 64
sources each. Durable conversations compact model context while retaining the original
entries on disk. The active state
and history summaries live in `state.json`; inactive conversations are stored in
private `sessions/<UUID>.json` files. Existing single-conversation state is
migrated without clearing its messages. Private
`durable/<UUID>/execution.sqlite` databases use Pi Durable's SQLite backend to
hold execution checkpoints, transcripts, and tool results; `state.json` retains
their active context reference and pending run. SQLite uses WAL mode and
`synchronous = FULL` with a process ownership lock. Missing or invalid execution
stores cannot create replacement contexts.
Tool activity cards expose bounded argument JSON and text results, including
safe tool failure messages. Historical details are projected from existing
execution logs through a read-only SQLite connection without resuming a run or
rewriting saved conversations. Missing or ambiguous records leave details
unavailable. Images and internal execution metadata are not included.
There is no automatic deletion or aggregate disk quota
for saved conversations or durable stores, including contexts retired by scope
changes. One bridge process must own an assistant data directory.

Scheduled tasks are independent of chat sessions. A confirmed form or chat
proposal persists the exact prompt, scope, model configuration, original
endpoint/Herdr/workspace identities, and next deadline. Every admission is saved
before its isolated Ranger service starts. `tasks.sqlite` stores tasks, runs,
proposals and deduplication records in separate queryable tables. Each state
change commits in one transaction before being published; a failed save rolls
back in-memory changes and pauses scheduling. Schema creation is transactional,
and invalid databases disable scheduling instead of clearing saved tasks.
Each run uses the ordinary send,
durable resume, and Stop paths with its own transcript and execution directory;
credential lookup remains in the main assistant directory. Runs verify the
original identities and current global workspace permissions before reading or
proposing operations. Automatic management execution additionally requires the
task's saved `approval_mode` and the live global mode to both be `auto`. Existing
manual tasks are not escalated when the global mode changes; editing a task
captures the currently selected mode for future runs. Disabling the global mode
also revokes automatic execution in existing task children.

One scheduled model run is admitted at a time; interactive chat has a separate
service. Interrupted runs waiting for their original connections return to the
queue and release the model slot. Their original start time and checkpoint
directory are retained so the next admission resumes the same run, including
while its schedule is paused. A run waiting for operation confirmation retains
its service and blocks new runs of the same task, while other tasks can proceed.
Restart cancels those
previews under the ordinary receipt rules. A task has at most one outstanding
run; overdue occurrences are combined rather than replayed in a backlog.
Interval schedules preserve their cadence, daily schedules use explicit IANA
timezones (skip gaps, first overlap occurrence), and one-time schedules admit
their scheduled occurrence only once. Manual runs do not resume a paused task
or change its schedule. Pause leaves current work running; Stop ends only the
current run; Cancel stops it and disables future admissions. Editing preserves
paused status.
Cancelled tasks can be deleted. Up to 50 tasks and the latest 20 runs per task are
retained. List snapshots contain task and run summaries; full run transcripts are
fetched separately through `bridge.assistant.task.get`.

After a task state change commits, transitions to `succeeded`, `failed`, or
`waiting` emit a dedicated global `assistant_notification` push and Web Push
with fixed text and the task/run UUIDs. Success uses the `completed` notification
preference; failures and confirmation requests use `blocked`. Repeated states,
initial history, Stop, and Cancel do not emit alerts. Delivery is best effort;
notification failures do not change task results, and alerts are not replayed
after downtime. Click targets open the specific Ranger run independently of the
selected connection. Notification text includes the task title and fixed status
guidance; prompts and provider errors stay in the run transcript.

Confirmed scheduled runs also expose `send_user_notification`, with a bounded
title, body, `completed`/`attention` kind and stable event key. Interactive chats
propose a monitoring schedule; they do not expose the sending tool. The service
binds delivery to its own current task/run UUIDs and revalidates the original
workspace identities, current permissions and cancellation before accepting a
notice. Models cannot choose recipients, URLs or another task's target.
Notification kind describes the observed Agent outcome or need for attention,
independently of whether the Ranger check itself succeeds.

Task `notification_mode` defaults to `status`. In `agent` mode, routine
successful checks are silent. A custom notice also replaces the fixed success
alert for that run; fixed failures and confirmation requests remain available.
Each task retains its latest 100 custom notification receipts. The original
target identity hash scopes event-key deduplication and the history supplied to
subsequent runs, so editing a task's scope cannot expose earlier workspace
content to its new model scope. A run accepts at most one custom notice.
Receipts commit before dispatch; repeated keys within the retained history do
not dispatch again. Pi marks the tool sequential and unsafe to replay, so an
interrupted delivery can be lost but is not automatically repeated. Tool results
report acceptance with best-effort delivery, never confirmation that a device
displayed the notice. Notification receipts remain after their run transcripts
are pruned and are removed with the task.

## Task notifications

With the default `herdr` source, each runtime keeps one passive endpoint shell
(`surface_active: false`) on the render socket, gated on endpoint generation 1.
Herdr never promotes it to foreground or tab geometry controller, but delivers
`SemanticNotification` (frozen tag 14) to it after applying Herdr's own policy.
Only this shell decodes tag 14; per-pane terminal shells ignore it, so open views
do not multiply alerts. Finished/needs-attention map to completed/blocked;
pane-less custom alerts use their sound (`request` = blocked). The runtime relays
each one to Web Push and to browsers as `roamgate.task_notification`; the bridge
hello advertises `herdr_task_notifications` so pages disable their own status
tracker. The shell reconnects with capped backoff. Servers without endpoint
support (older Herdr, or endpoints disabled) fall back to the status tracker
below, relayed the same way; a temporarily disconnected endpoint server does not.

The `status` source tracks agent transitions through per-pane subscriptions and
periodic reconciliation, even without browsers. Initial state is silent;
snapshots cannot overwrite newer events. Transitions emit once; disposal stops
observation and queued sends recheck the owning lease.

Web Push persists private VAPID keys and device subscriptions. Authenticated
same-origin HTTP manages enrollment/revocation; encrypted sends use a provider
allowlist, ten-second deadline, four concurrent requests, and a bounded
256-delivery memory queue. Failures/overflow are logged, not durably replayed.
The Service Worker checks connection generation when routing clicks; enrolled
pages suppress duplicate local notifications. See [delivery limits](./DEPLOYMENT.md#web-push-notifications).

## SSH transport

Each runtime supervises one OpenSSH process forwarding both sockets into a private
temporary directory. Readiness requires control `ping` and render handshake.
Transient failures retry six times with cancellable backoff capped at 30 seconds,
reset after 30 seconds stable-ready. Authentication, host-key, and permanent
protocol failures do not retry. Post-ready exit retires the generation first.
CLI SSH uses the same probes without persistence or automatic retry.

Only OpenSSH aliases or `user@host` are accepted, after `--` with fixed options.
Host-key checks remain enabled; service authentication is noninteractive. OpenSSH
configuration owns credentials/options. Stderr is bounded/sanitized. Cleanup
removes owned paths only after confirmed child exit; otherwise it preserves them
and reports failure. Host operations share this boundary; see [connection setup](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

## Distribution model

Production embeds frontend assets and Bun into one executable; targets need no
Bun/Node.js. Builds use the `roamgate` release identity across binaries, archives,
checksums, and manifests. Missing/legacy manifests fail closed without archive
discovery. Publication requires all six platform asset sets and no legacy update
aliases. Old clients require [manual migration](./DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).

## Trust boundary

Roamgate is trusted single-user administration, not a sandbox or multi-user
permission system. Normal runtime requires authentication, which grants full
authority; see [Security](../SECURITY.md#trust-model) for the local development
exception, login limits, TLS, and outer access controls.

The browser accepts one unscoped bridge hello before other messages. Message kinds
are exclusive and validated; downstream events cannot inject reserved bridge
fields. NDJSON lines/acknowledgements are bounded; malformed terminal frames are
dropped. Observable HTTP traversal is rejected, but Bun may normalize dot segments
before routing; legacy aliases prevent distinguishing every such normalization.
