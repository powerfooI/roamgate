# History synchronization

`createAgentSessionHandlers` shares one projection cache per connection across
History, summary, transcript preview, and ATIF export. Concurrent requests share
reads; raw preview and download reads stay separate.

## Codex session association

Codex history requires an explicit association between the pane and the session.
A shared Codex background server can inherit another pane's environment, so an
installed Herdr integration does not guarantee that association was reported.
Roamgate does not infer it from a working directory or the newest transcript.

In Session, expand **Link Codex session**, enter the complete ID of the
conversation currently displayed in the terminal, and choose **Check session**.
Review the directory and transcript before confirming. This replaces the
pane's association in Herdr for all viewers; it does not restart Codex or disable
its background server. The confirmation expires after five minutes and is
rejected if the observed foreground process, terminal, existing association, or
transcript identity changed. This is a recovery operation, not automatic
tracking of conversation switches inside a shared-server client.

Lookups use exact IDs under `CODEX_HOME` (default `~/.codex`), including
`sessions` and `archived_sessions`. SSH connections search on the remote host
using Python 3 and never use local transcripts. Metadata must match the entered
ID; duplicate transcript matches are rejected. The initial metadata record must
fit within the 1 MiB preview limit.

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

Tool entries arrive redacted: empty `text` plus `text_bytes` (UTF-8 length) and
`text_hash` (content hash) of the withheld payload. `agent_history.entry`
returns the full `text` with its `text_hash`. Clients keep a fetched payload
only while its hash matches the entry's, so a payload rewritten under the same
ID, even at the same length, is fetched again.

## Message filters

User and Agent start enabled; Tool starts disabled. Agent includes assistant
errors; Tool includes calls, outputs, and errors. Counts reflect the unfiltered
window, and the header shows visible/total when filtered. Filters persist while
the panel is mounted, not across reloads. **Show all types** restores them.

The **Chat view** has no type filters: it shows every entry, with consecutive
tool entries collapsed into blocks. Its search keeps a tool call and its
result together, so a match on either shows the whole step.

Search is a case-insensitive literal match over all loaded text and combines
with the type filters. It never fetches older messages or hidden tool payloads.
**Reset filters** clears search and type filters. Timestamps use local
`MM-DD HH:mm`, with the year outside the current year.

![History filtered to tool calls and outputs using synthetic data](screenshots/history-tool-filter.png)

## Resource limits

Changed files are re-read and re-projected in full: there is no incremental
parser or database. Raw previews and ATIF exports can be large.
