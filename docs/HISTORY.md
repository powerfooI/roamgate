# History synchronization

`createAgentSessionHandlers` shares one projection cache per connection across
History, summary, transcript preview, and ATIF export. Concurrent requests share
reads; raw preview and download reads stay separate.

## Codex session association

Codex runs with `--no-daemon` inside Herdr so each pane's session hooks inherit
that pane's environment. Roamgate's default Codex launch command uses this mode.
Install the Herdr Codex integration on the agent's machine; the hook reports
session identity automatically when starting, resuming, or forking a conversation.
Custom launch commands must also include `--no-daemon` (Codex 0.163.0 or newer).
For Bash or Zsh terminals, source `scripts/codex-herdr.sh` from the shell startup
file to apply the same rule to commands typed directly in Herdr, including
`resume` and `fork`. It preserves arguments, explicit remote connections and
shared-server management commands; outside Herdr it delegates unchanged. Copy
the script to a stable location before sourcing it if this checkout is temporary.
Existing aliases that invoke `codex`, `command codex`, or an executable path are
routed through the helper with their original arguments and executable intact.
Management subcommands are recognized after global options as well.

Codex's shared background server retains the environment of the terminal that
started it. Its hooks can therefore report another pane's identity, even when
the integration is current. Already-running shared-server sessions must be
closed normally and resumed with `codex --no-daemon resume <session-id>`.
The transcript remains in the same Codex directory. Herdr should own the terminal
process lifetime; it does not need a detached Codex background server.

Lookups use exact IDs under `CODEX_HOME` (default `~/.codex`), including
`sessions` and `archived_sessions`. SSH connections search on the remote host
using Python 3 and never use local transcripts. Duplicate transcript matches are
rejected. Roamgate never guesses an association from a directory or the newest
transcript, and does not offer manual session linking.

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

| Mode       | Response                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot` | `entries` replaces the window. Returned for a missing session, an invalid or expired cursor, a replaced connection, eviction, or file replacement/truncation.   |
| `delta`    | `base_revision`, `upserts`, `removed`, and the full ID `order` only when membership or order changed. An unchanged reply keeps the revision with empty changes. |

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
