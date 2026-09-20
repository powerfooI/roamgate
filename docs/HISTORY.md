# History synchronization

`createAgentSessionHandlers` shares a per-connection projection cache across
History, summary, transcript preview, and ATIF export. Concurrent requests share
in-flight reads/projection; raw preview prefix reads/downloads stay separate.

## Cache and consistency

The cache retains at most 16 sessions, four recent History revisions per session,
and an estimated 32 MiB of values. Admission counts UTF-16 strings and structural
overhead without serialization, conservatively recounting shared values.
Oversized/deep projections are served but not retained; transient parsing memory
is not included in the estimate.

Refresh resolves/stats the session. Path, provider, session, file identity,
size/mtime, change metadata, and provider descriptors invalidate projections.
A post-read stat triggers up to three retries on change. Errors invalidate data;
incomplete JSONL records wait for later changes. This is not a filesystem
transaction: later writes appear on the next refresh, and coarse metadata may
miss same-size in-place rewrites.

## Version 2 protocol

Send `history_version: 2` to `agent_history.get`, optionally with the last accepted
`cursor: { epoch, revision }`. Legacy callers receive conversation-only `messages`.

| Mode | Response |
| --- | --- |
| `snapshot` | `entries` replaces the window. Missing files/sessions yield empty snapshots. Invalid/expired cursors, connection replacement, eviction, file replacement, or truncation reset this way. |
| `delta` | `base_revision`, `upserts`, `removed`, plus complete ID `order` only when membership/order changes. No `messages`, `entries`, or trajectory. No-change replies keep revision with empty changes. |

The window holds the latest **200 conversation entries**, including errors;
associated tools do not count toward the limit. Eviction emits removals; raw/ATIF
exports remain complete. IDs identify projected occurrences/tool calls, **not
durable source records or ATIF step numbers**. Full-window comparisons handle
provider representation changes; synthetic timestamps remain stable within a
cached file generation. Clients accept replies only against the request cursor
and current pane/connection lease.

History refreshes every four seconds only while open and visible, without
overlapping requests. Cards cap default DOM content at 4,000 characters; full
tool details open as escaped text. Names/call IDs associate results without
moving them from their transcript positions.

## Message filters

The Session header offers counts, details, transcript preview, raw export, and
refresh. Info toggles metadata/messages in wide and compact layouts, preserving
filters/selection; session changes return to messages.

User/Agent start enabled; Tool starts disabled. Agent includes assistant errors;
Tool includes calls, outputs, and errors. Button counts reflect the unfiltered
window; the header shows visible/total when filtered. Minimap/numbering follow
visible entries, but hidden entries still update and exports remain complete.
Type filters survive pane switches/reopening while mounted, not reloads;
**Show all types** restores all message types.

Search combines type filters with case-insensitive literal matching across full
loaded text, not just card previews. Redacted tools become searchable only after
explicit loading; search never fetches older messages or tool payloads. **Reset
filters** clears search and enables all types. Search resets on pane/connection changes.

Click a card's header/text/background for details; Copy stays separate. Timestamps
use local `MM-DD HH:mm`, prefixed with `YYYY-` outside the current year.

![History filtered to tool calls and outputs using synthetic data](screenshots/history-tool-filter.png)

## Consistency and resource limits

Changed files still require **full JSONL reads and provider projection**: no
incremental parser, byte cursor, database, or new transport. Raw previews/full
ATIF exports can remain large; cache limits are not exact JavaScript heap bounds.
