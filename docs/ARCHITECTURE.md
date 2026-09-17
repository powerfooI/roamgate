# Architecture

This document describes Roamgate's current system contracts. See
[FEATURES.md](../FEATURES.md) for behavior and shortcuts and
[DEPLOYMENT.md](./DEPLOYMENT.md) for supported configurations.

## System overview

Browsers cannot open Unix domain sockets or Windows named pipes directly. A
Bun bridge serves the frontend, authenticates browsers, and connects to Herdr:

```text
Browser (React + Vite)
   |  same-origin HTTP / WebSocket
   v
Bridge (Bun + TypeScript) -- node:net --> Herdr sockets
```

`herdr.sock` carries NDJSON control requests; `herdr-client.sock` carries binary
terminal traffic. Browser RPC uses `{ id, method, params }` and returns either
`{ id, result }` or `{ id, error }`, with connection identity attached to scoped
traffic. Subscribed Herdr events are pushed as `{ event: ... }`.

The bridge owns socket access, local/SSH runtimes, file/Git/worktree/hook/session
operations, terminal and clipboard relay, authentication, health, and updates.
React owns presentation and browser-local preferences. xterm displays Herdr's
server-rendered output rather than reconstructing a PTY in the bridge.

## Agent activity

The bridge enriches `agent.list` with optional `last_activity_at` epoch
milliseconds from the session file's modification time. Resolution uses the
reported session identity and the connection's file access, without parsing
transcripts. File checks have bounded concurrency and a 1.5-second response
budget; unavailable metadata never removes agents from the list. Remote IDs
that require local directory searches are left unresolved rather than matched
to this host's sessions. The browser uses timestamps for idle-agent recency,
with Herdr's state-change sequence as a fallback, and stores no activity history.

## Task notifications

Each connection runtime observes agent transitions through its existing per-pane
status subscription and periodic pane reconciliation, even with no browser
clients. A runtime-local tracker seeds initial state silently, ignores snapshots
that raced newer events, and emits completion/input-required transitions once.
Runtime disposal stops observation; queued deliveries check the owning lease.

Web Push uses a private persistent VAPID key pair and per-device subscriptions
with independent completion/blocked preferences. Authenticated same-origin HTTP
manages enrollment and revocation. Sends use encrypted payloads, an outbound
provider allowlist, a ten-second deadline, four concurrent requests, and a bounded
256-delivery in-memory queue. Queue overflow and provider failures are logged;
there is no durable event replay. The Service Worker shows notifications without
an active page and routes clicks through the connection-generation-checked pane
navigation path. Enrolled pages suppress duplicate local system notifications.
See [deployment and delivery limits](DEPLOYMENT.md#web-push-notifications).

## Terminal endpoints

Interface text size uses root CSS zoom. Terminal surfaces cancel that zoom and
scale xterm's font size directly, so cell measurements, selection, mouse input,
and IME positioning stay in viewport CSS pixels. Radix popovers also cancel zoom
around their positioning wrapper and reapply it to the content; their viewport
limits convert back to content units.

Backend selection uses the verified protocol allowlist, not browser version
inference. See [Herdr compatibility](./DEPLOYMENT.md#herdr-compatibility) for
versions, fallback configuration, and clipboard limitations.

Herdr 0.9.0 endpoints require generation 1 and the exact codecs
`shell.snapshot.v1`, `shell.surface.v1`, `shell.input.semantic.v1`, and
`shell.blob.v1`. Unknown generations/codecs are rejected regardless of advertised
capabilities. Attachment waits for the initial snapshot. Each terminal crops its
pane from the server-rendered tab surface and sends semantic input to that pane;
panes retain their shared layout dimensions.

Incremental surface patches update only the named panes; other pane metadata
remains available for cropping and cursor delivery. Each patch replaces the
complete cursor state, including `null` to clear it. Pane topology changes
require a full surface; patches naming unknown panes are discarded.

`terminal.attach` carries pane content dimensions in `cols`/`rows`. When layout
is available, the browser also supplies `surface_cols`/`surface_rows` for the
complete tab, including pane borders but excluding app sidebar/tab-bar insets.
The bridge validates this optional pair as integers in 1..65535 and uses it in
new endpoint handshakes. Surface feedback corrects stale or missing hints;
legacy direct attachments continue to use the pane content dimensions.
Endpoint repaints are clipped to each viewer's requested viewport, including
wide-character and cursor boundaries. Browsers discard oversized frames that
arrive after a local shrink or were held during text selection.

Terminal links retain cell coordinates while scanning soft-wrapped text. Endpoint
cell repaints do not contain soft-wrap metadata, so file detection also considers
adjacent path fragments with application-inserted indentation and padding. These
inferred paths must pass workspace-scoped file resolution before activation;
ordinary rows remain independent when no combined file exists. Scanning is bounded,
blank lines separate contexts, and HTTP links use only explicit soft wraps. Pending
lookups are discarded if the buffer, text, cell positions, or wrapping changes.

Method/capability advertisements belong to each terminal socket, never another
terminal or runtime. Reattachment negotiates again; browser reconnect and
connection changes clear cached availability until refreshed. The bridge returns
availability in attach replies and scoped workspace metadata, then checks every
method again at dispatch:

- `pane.focus` is required for safe attachment; absence fails without legacy
  takeover.
- `pane.scroll` gates history scrolling; `tab.create` and `workspace.create`
  gate creation on the existing source endpoint. UI controls explain missing
  methods or pending negotiation. Unrelated control-API operations are unaffected.
- Input and resize are core codec operations, not optional methods. Only
  `health_check` enables endpoint ping/pong. `surface_interest` and
  `presentation_effects_fence` do not enable surface-setting or fencing controls.

Full page-key requests use semantic PageUp/PageDown input on endpoints. Herdr
routes them to the application or host scrollback using the PTY's current modes;
they do not require `pane.scroll`. Explicit half-page history requests continue
to use `pane.scroll`, including in mouse-aware applications. Legacy attachments
retain their PageKey/Wheel routing. Both keyboard shortcuts and mobile buttons
use this contract.

Mouse input uses zero-based pane-local cells, bounded to the crop. Only a press
inside the pane acquires drag/release ownership; later positions clamp to its
edge. Reporting changes and session closure cancel ownership. Mouse-aware apps
receive semantic mouse events; ordinary wheels and explicit history shortcuts
use history scrolling. History requests coalesce wheel intent while one dispatch
awaits both its RPC reply and viewport feedback; other terminal commands remain
usable. A confirmed no-op reply needs no repaint. Completed movement is not
rebased by later history growth. Surfaces have no request identity: a changed
viewport can also be an external replacement, which becomes authoritative when
no newer wheel intent is queued. Input, missing panes or scroll metrics, and
session closure cancel queued history movement. During browser selection,
presentation retains only the latest full repaint and resumes when selection clears. Pane/session changes
retire pending presentation; selection replay cannot send application input.
Endpoint frames include content revision and absolute viewport rows when the
viewer receives the complete pane crop. Edge-drag selection requests overlapping
history viewports one at a time, admitting only matching-revision repaints while
retaining immutable copies of visited cells. Copy uses the complete absolute
range, not just its visible highlight. Release, lost mouse-up, blur, resize, and
attachment reset stop drag scrolling. Changed content or geometry stops further
history requests and preserves the already captured selection.

Input waits for attachment readiness and revalidates the attachment, session,
and routing lease. It is never replayed into a detached or replaced terminal.
Disconnect rejects pending endpoint requests and invalidates clipboard ownership.

Mermaid file previews and Markdown fences share a lazy renderer and independent
zoomable viewports. Source wrappers and leading metadata/comments are removed
before diagram-type detection; source views retain the original file. Layout and
theme remain controlled by Studio. Image previews use inert image elements;
workspace SVG endpoints also send a sandbox CSP for direct navigation, blocking
scripts and external resources. SVG source is never inserted into Studio's DOM.

## Browser navigation and creation

On endpoint connections, `browserNavigation.ts` projects browser-local
workspace/tab/pane choices into the shared UI selection fields. Snapshots supply
topology, not subsequent navigation. Stale layouts and delayed action results
cannot replace newer browser selections. This is independent workspace/tab
navigation, not independent native same-tab pane focus. Legacy navigation,
topology mutations, and terminal dimensions remain shared.

Active terminal selection and terminal clicks send `terminal.focus` through the
attached shell's `pane.focus` endpoint so the tab surface supplies that pane's
cursor. The browser restores its selection after split attachments become ready,
but does not refocus on streaming frames or routine snapshots. Focus requests are
serialized per browser across endpoint lanes, superseded queued selections are
discarded, and attachment ownership and connection leases are rechecked before
dispatch. Same-tab cursor ownership remains shared with other Herdr clients.

Creation uses explicit context and `focus: false`, adopting returned IDs only
while the initiating selection and connection lease remain current. Roamgate-only
`browser_source` identifies the source terminal, pane, tab, and workspace. The
bridge validates attachment ownership and live topology, strips that field, and
calls the advertised create method on the existing endpoint's serialized
focus/scroll lane. It creates no extra endpoint or focus call. Omitting a
synthesized cwd preserves Herdr's `terminal.new_cwd` policy; explicit cwd wins.
Same-tab pane focus, including the `follow` cwd source, remains shared.

Missing source attachments fail explicitly. The only exception is first-workspace
bootstrap: each runtime serializes an empty `workspace.list` check and control
creation, rechecking lease and deadline before dispatch. Competing creations must
retry once topology becomes nonempty. The 20-second admission deadline covers
readiness, validation, and queue residence, below the browser RPC timeout.
Expired undispatched mutations never execute; dispatched timeouts report uncertain
completion so callers check Herdr before retrying.

Subscription acknowledgements, including reconnects, trigger fresh snapshots;
events during refresh queue another refresh. This reconciles missed changes,
not an atomic or replayable event log.

## Connection isolation

A bridge-global `ConnectionManager` owns shared profiles and independent
`ConnectionRuntime` instances. Each runtime owns its transport, clients, viewers,
clipboard relay, subscriptions, services, caches, and reconnect lifecycle.
Browser selection does not start or stop other runtimes; render streams open
only while viewed. Disconnect/removal disposes the bridge runtime and SSH tunnel,
not Herdr or its workspaces.

Downstream RPC/HTTP requires an immutable connection ID, runtime generation, and
request-local ready-runtime lease. Replies, errors, events, terminal frames, and
clipboard pushes carry that identity. HTTP streams recheck the lease per chunk
and cancel their source on replacement. Dispatched effects may finish on the
original runtime, but retired replies, chunks, and metadata cannot publish.
Explicit malformed, unknown, stale, or not-ready identities fail without fallback.
Omitted identities and legacy HTTP aliases remain a bounded, logged compatibility
path for older single-connection clients only.

Bridge-global authentication, health, updates, client accounting, and profile
management remain independent of downstream readiness. Global RPC rejects
misleading connection fields. Only ready runtimes route requests; start, stop,
replacement, and post-ready transport exit invalidate leases before publishing
status. Starts/stops are serialized, shutdown is bounded, and one failed runtime
does not block management or healthy connections.

Browser mount keys, caches, local storage, notification targets, and asynchronous
actions are connection-scoped. Switching connections retires the browser lease;
same-ID runtime replacement clears active and inactive cached sessions before
resource IDs can be reused.

## Workspace resource ownership

A checkout owns Files/Changes data; a workspace supplies its runtime route; a tab
is a return location; a pane supplies optional path/session context. Repository
groups do not represent a combined working tree. Changes describe checkout edits,
not proof that one agent produced them. Last step uses recorded activity snapshots,
not attribution of arbitrary working-tree edits.

Git resource keys encode the endpoint-qualified repository identity
(`worktree.gui_settings_key`) and normalized checkout path as a pair. The path
separates linked checkouts; the repository identity separates SSH destinations
when a saved connection is repointed. Missing or blank settings keys fall back
to the trimmed repository key, which cannot distinguish endpoints on its own.
Newly enriched identities do not inherit this fallback's stored state. Runtime
generations are not part of persistent keys. Non-Git resources use workspace
identity. All are connection-scoped.
Workspaces sharing a checkout may share caches, but requests retain
workspace/runtime leases and resource revisions: refresh/removal retires
older prefetches. Tab/pane IDs do not own resource caches.

Older repository-wide Inspector storage is not automatically migrated: its file
selections, layout preferences, and review drafts do not identify their original
checkout. The original browser storage is retained, while checkout-specific
state starts fresh. Switching checkouts restores that checkout's saved selection
or shows its file list when nothing has been selected.

Inspector actions capture the originating workspace instead of consulting global
focus when results arrive. A vanished workspace can rebind only to the same
checkout; a missing path must not fall back to a sibling worktree. Agent cwd is
used only inside the checkout, otherwise browsing starts at its root. Successful
worktree removal clears that checkout's state and retargets/closes the Inspector
without affecting siblings. Closing one workspace does not erase resources still
used by another workspace for that checkout.

The terminal stays mounted across Inspector views and geometry changes. Resource
layout/preferences are separate from content caches. See
[Workspace Inspector](../FEATURES.md#workspace-inspector) for controls and
[History synchronization](./HISTORY.md) for session projection contracts.

## Filesystem browsing

`file.list` stays checkout-relative by default, including realpath checks for
symlink escapes. Each filesystem listing explicitly sends `scope: "filesystem"`
and an absolute host directory; returned entries use absolute paths and the reply
confirms its scope. This mode is local to the open explorer and is never persisted
as a browser-wide permission or shared with another checkout/connection. Directory
responses from a retired view cannot replace its successor. Search filters only
loaded entries and never recursively scans the filesystem.

Absolute preview resources use `scope=filesystem` on download URLs. Relative
Markdown links and images resolve beside their absolute source document. Upload
and delete remain checkout-scoped; filesystem mode exposes browsing, previews,
copying paths, and downloads. Explorer resource caches stay separate from the lazy
UI so opening a terminal does not load the file-search matcher or browser controls.

## SSH transport

Each SSH runtime supervises one OpenSSH process forwarding both sockets into a
private temporary directory. Readiness requires control `ping` and a render
handshake. Transient failures use cancellable backoff capped at 30 seconds and
six attempts, resetting after 30 seconds stable-ready; authentication, host-key,
and permanent protocol failures do not retry. Post-ready exit retires the runtime
generation before retry. CLI SSH uses the same validation/probes but does not
persist or automatically retry.

Only an OpenSSH alias or `user@host` is accepted, passed after `--` with fixed
options. Host-key checking stays enabled; service authentication is noninteractive.
Credentials/options remain in the service user's OpenSSH configuration. Stderr is
bounded and sanitized, not relayed as raw banners. Cleanup removes owned paths
only after confirmed child exit; unconfirmed termination preserves paths and
reports failure. Remote file, Git, hook, and supported session operations use the
same runtime host boundary. See [connection setup](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

## Distribution model

Production builds embed the frontend and Bun runtime into one platform executable;
users need neither Bun nor Node.js. Source builds use Bun and Vite. See
[standalone builds](./DEPLOYMENT.md#build-a-standalone-executable).

Roamgate has a separate release namespace: executable and package members,
archive/checksum filenames, and manifest identity all use `roamgate`. Every
release provides a manifest; missing or legacy metadata fails closed without
an archive-discovery fallback. Publication checks require exactly the six
platforms' Roamgate assets and prohibit legacy update aliases. Historical
clients cannot discover Roamgate from their old Latest URLs; see the
[manual transition contract](./DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).

## Trust boundary

Roamgate is a trusted single-user administration tool, not a sandbox or multi-user
permission system. Authenticated browsers can control terminals, change files,
manage shared profiles, and execute trusted repository hooks. It provides neither
TLS termination nor rate limiting; see [SECURITY.md](../SECURITY.md).

The bridge performs no browser-Origin or request-Host checks; listener access and
any required authentication determine authority. Secure the outer access path as
described in [SECURITY.md](../SECURITY.md#trust-model), including for forwarded
loopback listeners. The browser accepts one valid unscoped bridge hello before
other messages. Replies/events have validated, exclusive message kinds; downstream
events cannot inject reserved bridge fields. NDJSON lines and subscription
acknowledgements are bounded, and malformed terminal frames are dropped.
Observable HTTP traversal forms are rejected, but Bun can normalize dot segments
before routing; legacy aliases prevent distinguishing every such pre-handler
normalization.
