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

Input waits for readiness and revalidates attachment/session/runtime leases;
it is never replayed into a replacement terminal. Disconnect rejects pending
requests and invalidates clipboard ownership.

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

A **checkout** owns Files/Changes; a workspace supplies routing, a tab a return
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

## Filesystem browsing

`file.list` is checkout-relative with realpath/symlink escape checks. Each
filesystem listing explicitly sends `scope: "filesystem"` and an absolute host
directory; replies confirm scope and return absolute entries. The mode is
view-local, not a persisted permission; retired responses cannot replace a new
view. Search filters loaded entries only.

Absolute previews use `scope=filesystem` download URLs; relative Markdown links
and images resolve beside their source. Upload/delete remain checkout-scoped.
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

## Task notifications

Each runtime tracks agent transitions through per-pane subscriptions and periodic
reconciliation, even without browsers. Initial state is silent; snapshots cannot
overwrite newer events. Transitions emit once; disposal stops observation and
queued sends recheck the owning lease.

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
permission system. Listener access and required authentication grant authority;
see [Security](../SECURITY.md#trust-model) for loopback, TLS, and outer access controls.

The browser accepts one unscoped bridge hello before other messages. Message kinds
are exclusive and validated; downstream events cannot inject reserved bridge
fields. NDJSON lines/acknowledgements are bounded; malformed terminal frames are
dropped. Observable HTTP traversal is rejected, but Bun may normalize dot segments
before routing; legacy aliases prevent distinguishing every such normalization.
