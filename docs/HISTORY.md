# History synchronization

`createAgentSessionHandlers` shares one projection cache per connection across
History, summary, transcript preview, and ATIF export. Concurrent requests share
reads; raw preview and download reads stay separate.

## Cache and consistency

The cache keeps at most 16 sessions, four recent revisions per session, and about
32 MiB of data (an estimate, not a heap bound). Oversized projections are served
but not cached.

Each refresh stats the session file. Changes to path, provider, session, file
identity, size, or mtime invalidate the projection; a change during the read
triggers up to three retries. Incomplete JSONL lines wait for the next change.
This is not a filesystem transaction: same-size in-place rewrites may be missed
until the next change.

## Version 2 protocol

Send `history_version: 2` to `agent_history.get`, optionally with the last
accepted `cursor: { epoch, revision }`. Legacy callers get conversation-only
`messages`.

| Mode | Response |
| --- | --- |
| `snapshot` | `entries` replaces the window. Returned for a missing session, an invalid or expired cursor, a replaced connection, eviction, or file replacement/truncation. |
| `delta` | `base_revision`, `upserts`, `removed`, and the full ID `order` only when membership or order changed. An unchanged reply keeps the revision with empty changes. |

The window holds the latest **200 conversation entries** (including errors);
associated tool calls do not count. Raw and ATIF exports stay complete. Entry IDs
identify projected entries, **not durable source records or ATIF step numbers**.
Clients accept a reply only against their request cursor and current
pane/connection lease.

History refreshes every four seconds while open and visible, never overlapping.
Cards show up to 4,000 characters; full tool details open on demand.

## Message filters

User and Agent start enabled; Tool starts disabled. Agent includes assistant
errors; Tool includes calls, outputs, and errors. Counts reflect the unfiltered
window, and the header shows visible/total when filtered. Filters persist while
the panel is mounted, not across reloads. **Show all types** restores them.

Search is a case-insensitive literal match over all loaded text and combines
with the type filters. It never fetches older messages or hidden tool payloads.
**Reset filters** clears search and type filters. Timestamps use local
`MM-DD HH:mm`, with the year outside the current year.

![History filtered to tool calls and outputs using synthetic data](screenshots/history-tool-filter.png)

## Resource limits

Changed files are re-read and re-projected in full: there is no incremental
parser or database. Raw previews and ATIF exports can be large.
