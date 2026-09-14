# Installation and Deployment

Install, configure, connect, and run Roamgate below. For step-by-step private
access with Tailscale Serve, SSH, or experimental Tailcat, use the
[tutorial](./TUTORIAL.md#networking).

## Requirements

- A running Herdr server.
- The default Herdr sockets at `~/.config/herdr/herdr.sock` and
  `~/.config/herdr/herdr-client.sock` on Unix, or the corresponding
  `%APPDATA%\herdr\` named pipes on Windows.
- [Bun](https://bun.sh) 1.4.1 or newer for source builds. Standalone binaries do
  not require Bun on the target machine.

### Herdr compatibility

This source build supports verified legacy protocols 14-20, from standalone
Herdr 0.7.0 / protocol 14 through Herdr 0.8.2 / protocol 20, and **tagged Herdr
0.9.0 / protocol 22**. The [plugin installer](#herdr-plugin) separately requires
Herdr 0.7.2 or newer. Protocol 21 and unknown versions are rejected at the control
probe and binary handshake. Use a Roamgate build explicitly supporting your
server, or a separate compatible server; do not downgrade a live server.
Published binaries retain the behavior documented for their release in the
[release notes](https://github.com/powerfooI/roamgate/releases).

Herdr 0.9.0 terminals use **stable endpoint generation 1** (distinct from
terminal protocol 22). Set `ROAMGATE_DISABLE_ENDPOINT=1` to use the legacy
direct-terminal fallback:

- Endpoint rendering crops the server-rendered tab to each pane. Unknown endpoint
  generations/codecs are rejected. Missing required `pane.focus` fails attachment
  without silent fallback; optional advertised methods gate creation and history
  scrolling with a reason when unavailable. Input, mouse, paste, resize, and
  rendering can remain usable without optional history support. The explicitly
  enabled legacy fallback uses takeover and can disconnect another owner.
- Terminal-program OSC 52 writes follow Herdr's **foreground-recipient**
  behavior: Roamgate sends only to the browser with input in the last 30 seconds
  matching the receiving endpoint session, never to passive viewers. Herdr
  sends no producing-pane or input identity: a delayed/background write from
  pane A after B becomes foreground can reach B's recent input owner. This is
  not source-PTY isolation or a guarantee of the original initiating browser.
  Detach, session replacement, and connection disposal invalidate ownership.
  Clipboard reads remain disabled; browser permission failures retain the
  existing copy-retry UI. Ordinary browser selection copy and paste are unchanged.
  OSC 52 remains unavailable on the **0.9.0 legacy fallback** because only shell
  endpoints receive it. Legacy servers retain their existing clipboard relay.
- Workspace/tab navigation is browser-local per connection, surviving reconnect
  but not reload or runtime replacement. Same-tab pane focus, topology changes,
  and terminal sizes remain shared; sizing follows Herdr's last-interacting
  client. See [navigation behavior](../FEATURES.md#workspace-tab-and-pane-navigation).
  Tab/workspace creation preserves `terminal.new_cwd` (`follow`, `home`, `current`,
  or a fixed path), with explicit cwd taking precedence. Because same-tab focus
  is shared, `follow` does not isolate the browser's source pane. Open the source
  terminal tab before creating; unavailable sources fail explicitly. See
  [creation contracts](./ARCHITECTURE.md#browser-navigation-and-creation) for
  bootstrap and timeout handling.
- Legacy servers and `ROAMGATE_DISABLE_ENDPOINT=1` retain **Shared navigation**:
  public JSON focus can move other clients. The connection menu shows the mode,
  using the bridge's actual backend selection, not browser version guesses.
  Enhanced Kitty keyboard / modifyOtherKeys parity and pixel mouse are not
  supported. Legacy keyboard-mode messages are decoded, not applied in-browser.
- Closing a workspace does not implicitly close its linked group. If Herdr
  requires group closure, Roamgate leaves it intact and directs you to the CLI:
  `herdr --session <name> workspace close <workspace_id> --group`. Review all
  linked workspaces first; this explicitly closes the entire group.

For endpoint negotiation, input, and reconnect contracts, see
[Architecture](./ARCHITECTURE.md#terminal-endpoints).

## Transition from Herdr Studio / herdr-gui

**Moving from Herdr Studio / herdr-gui 0.6.2 or earlier requires a manual
Roamgate installation, not an in-place update.**
Roamgate 0.7.0+ publishes only `roamgate-*` archives, checksums, update manifests,
and `install-roamgate.sh`. Old default Latest/update URLs no longer work; clients
may report update-check errors. Neither legacy manifests nor archives are
published, because old clients can fall back to archive discovery.

Existing processes and historical tagged assets remain intact, but old clients
receive no new fixes through the retired channel. Custom mirrors and pinned
historical downloads are outside this cutoff.

**Identity migration is implemented in source builds; published 0.7.0 still
uses the old service names, `herdr.studio` plugin ID, and data paths.** Running
today's Latest installer does not add this migration. Build this source checkout
explicitly until a release containing these changes is published; do not reuse
a previously downloaded `server/roamgate` binary.

Roamgate 0.7.0 already uses the new release assets and can receive later in-app
updates. Updating its binary does not rename its service. If only an unmodified
0.7.0-generated legacy definition exists and it points to the executable being
invoked, the new CLI routes `service status`, `restart`, `reload`, and `uninstall`
to that service, preserving its name, definition and
environment until explicit cutover. `uninstall` stops/removes that service but
preserves its configuration and data. No new service is installed automatically.
Ambiguous old/new services, custom or symlinked legacy definitions, a loaded legacy
service without its definition, and detection errors require intervention with
the previous binary or native service manager; the CLI does not guess or silently
report a successful removal. This compatibility does not restore the retired
Herdr Studio update channel or migrate plugin registrations.

To switch an existing installation deliberately:

1. Back up the previous executable, service definition, and configuration with
   permissions intact. Include `~/.config/herdr-gui/` and, on Windows,
   `%APPDATA%\herdr-gui\` plus `~/.config/herdr-gui/` for old settings/profiles.
2. Stop and uninstall the old managed service before installing the new service.
   Before replacing the executable, use `herdr-gui service uninstall` for Herdr
   Studio or `/path/to/previous/roamgate service uninstall` for published 0.7.0.
   After an in-place Roamgate update, `roamgate service uninstall` also handles
   the sole generated legacy definition as described above. These commands
   preserve configuration. For custom definitions/wrappers, explicitly stop,
   disable, and archive the old definition using its native manager instead;
   review custom arguments and environment before recreating it. Stop unmanaged
   processes too. Do not keep old and new auto-start entries enabled together.
3. Build the new executable using [source build instructions](#build-a-standalone-executable).
   Run `./server/roamgate service install` explicitly. Install refuses an
   installed/loaded legacy service, even with `--force`, before changing
   configuration or definitions. A detection error also blocks install.
4. Check service status, login and saved connections. For rollback, uninstall the
   new service with the new binary, then restore the old binary/definition and
   enable only that service. Legacy data remains intact; changes made in the new
   data directory are not synchronized back automatically.

New data lives in `~/.config/roamgate` on Unix and `%APPDATA%\roamgate` on
Windows. Missing auth tokens, settings and connections are copied on first use;
service installation also copies `herdr-gui.env` to `roamgate.env`. Existing new
files win, even when empty or invalid. Copies preserve originals and restrict
permissions to the owner's existing read/write bits; failed copies stop without
replacing files or generating replacement credentials. Legacy symlinks are
rejected. Explicit connection-path overrides are not migrated. On Windows, old
settings/profiles are read from their historical `~/.config/herdr-gui` location.
Stop the old writer first: this is a one-way copy, not ongoing synchronization.

Browser preferences, selections and review drafts use `roamgate:` storage keys.
A missing key reads/copies the legacy value without removing it; new values win,
including empty values. Deletions are remembered so old drafts do not reappear.
This works only on the same browser origin. A hostname or port change cannot
transfer another origin's storage automatically. The website checklist also
copies its legacy key when visited on the same origin, including at the new
Pages path.

For plugin registrations, follow [the explicit plugin migration](#herdr-plugin).
Historical binaries, manifests and release assets retain their original contracts.

### Repository and website addresses

The repository is [powerfooI/roamgate](https://github.com/powerfooI/roamgate).
GitHub redirects former `powerfooI/herdr-studio` Git/release URLs, preserving old
binaries' download addresses. Tags/assets stay intact; new builds use the new
address. **Do not reuse the old repository name:** that removes the redirects.

The website is <https://roamgate.dev/>; the tutorial is
<https://roamgate.dev/tutorial/>. The `/roamgate/` GitHub Pages address redirects
there. Update bookmarks and links; do not rely on the old `/herdr-studio/` path.

### Install historical Herdr Studio

The retained [install-herdr-gui.sh](../scripts/install-herdr-gui.sh) installs only
`herdr-gui`, not Roamgate. It is not included in new releases and does not restore
the old channel. Its default Latest URL is retired; pin a historical version:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/download/v0.6.2/install-herdr-gui.sh \
  | HERDR_GUI_VERSION=0.6.2 sh
```

This installs `herdr-gui` 0.6.2, with no future fixes through the old channel.

## Install a release

Roamgate 0.7.0+ releases support Linux, macOS, and Windows on x86-64/arm64;
historical 0.6.2 has no Roamgate assets. For unreleased checkouts, use
[source builds](#build-a-standalone-executable) or the [source plugin](#herdr-plugin).

On Linux/macOS, the installer verifies checksums and installs to
`~/.local/bin/roamgate`:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | sh
```

Make sure `~/.local/bin` is in `PATH`, then run:

```bash
roamgate --version
roamgate
```

Open the URL printed by the process. Run the installer again to update.

Windows releases provide x64 and ARM64 archives containing `roamgate.exe`.
Download the matching `roamgate-windows-<arch>.tar.xz` and `.sha256` files from
the [latest release](https://github.com/powerfooI/roamgate/releases/latest),
verify the checksum with `Get-FileHash`, and extract the archive with Windows
11's built-in `tar.exe`. Releases predating native ARM64 support contain only
the x64 archive; prefer the native ARM64 package when it is available.

To install into a system directory, set `ROAMGATE_INSTALL_DIR`:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | sudo env ROAMGATE_INSTALL_DIR=/usr/local/bin sh
```

Set `ROAMGATE_VERSION` to a published Roamgate version instead of `latest`
(replace `X.Y.Z` below; pre-Roamgate releases require their historical installer):

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | ROAMGATE_VERSION=X.Y.Z sh
```

`ROAMGATE_RELEASE_BASE_URL` selects a compatible flat release mirror. Mirrors
must use HTTPS, except for loopback testing, and their URLs cannot contain
credentials, query strings, or fragments. The installer and in-app updater
preserve a replaced executable as `roamgate.previous` for manual recovery.

## Herdr plugin

Requires Herdr 0.7.2+ and [Bun](https://bun.sh) for the shim.

**Migrating an existing `herdr.studio` registration:** first stop/uninstall its
service with its previous binary as described in the transition section. Close
any old plugin popup/panes and finish pending actions. Then run:

```bash
herdr plugin disable herdr.studio
herdr plugin unlink herdr.studio
```

`unlink` unregisters without deleting the checkout or data, including for a
managed checkout. Herdr owns this registry; Roamgate never edits it or silently
uninstalls another plugin. Build and link the new checkout only after unlinking
the old ID to avoid duplicate entries. Keep the previous checkout for rollback;
do not run its start action alongside the new service.

The new manifest uses ID `roamgate` (plain ASCII IDs are supported by
[Herdr's manifest contract](https://herdr.dev/docs/plugins/)). Published 0.7.0
uses `herdr.studio`; the commands below apply to the new source-built plugin.
This shim refuses prebuilt downloads through 0.7.0 and directs you to build from
source. It does not validate an already-present binary: always rebuild before
linking this checkout. Release installation of the new identity requires a
published release containing these changes, not the existing 0.7.0 tag.

**Unreleased checkout:** clone the repository to a directory you will keep,
compile explicitly, then link that local directory:

```bash
git clone https://github.com/powerfooI/roamgate.git
cd roamgate
bun scripts/studio-plugin.ts build-source
herdr plugin link .
```

`build-source` installs all workspace dependencies and runs `bun run build`.
Link only after success: linking skips release download and uses `server/roamgate`
(`roamgate.exe` on Windows). Keep the checkout and rebuild after updates.
Building/linking does not start the service.

**Published Roamgate release:** replace `X.Y.Z` with a published Roamgate tag:

```bash
herdr plugin install powerfooI/roamgate --ref vX.Y.Z
```

Remote installation runs the manifest's `build`: download and checksum-verify
the checkout version's Roamgate binary. It never compiles on failure or falls
back to legacy assets. Neither historical 0.6.2 nor unpublished versions can
satisfy this release-only path.

Plugin actions manage the same user service described in
[Run as a user service](#run-as-a-user-service):

```bash
herdr plugin action invoke roamgate.start      # install and start the service
herdr plugin action invoke roamgate.url        # print the login URL
herdr plugin action invoke roamgate.status
herdr plugin action invoke roamgate.restart
herdr plugin action invoke roamgate.uninstall  # remove the service
```

Actions are asynchronous; inspect output with
`herdr plugin log list --plugin roamgate` or open the TUI panel:

```bash
herdr plugin pane open --plugin roamgate --entrypoint panel
```

The panel shows status, login URL, version, and single-key start/restart/uninstall
controls. It defaults to a session-modal popup; `--placement split` (or `tab`,
`zoomed`, `overlay`) creates a regular pane visible to other Herdr clients.

## Basic runtime configuration

Flags override environment variables, which override defaults. Run
`roamgate --help` for the complete list.

Every `ROAMGATE_*` setting below also accepts its legacy `HERDR_GUI_*`
name. The new name takes precedence when both are set, including an explicitly
empty value. This applies to runtime settings, connection registry paths, and
the installer's `VERSION`, `INSTALL_DIR`, and `RELEASE_BASE_URL` settings.
An empty installer `VERSION` selects the latest release; an empty `INSTALL_DIR`
is rejected. Herdr's own `HERDR_*` connection settings are unchanged.
Default data/service identities follow the migration contract above; an explicit
connection registry path remains authoritative, including an empty value.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--host <addr>` | `HOST` | `127.0.0.1` |
| `--port <n>` | `PORT` | `8787` |
| `--password <pw>` | `ROAMGATE_PASSWORD` | Generated token for non-loopback binds |
| `--socket-path <path>` | `HERDR_SOCKET_PATH` | Default Herdr control socket or named pipe |
| `--client-socket-path <path>` | `HERDR_CLIENT_SOCKET_PATH` | Default Herdr render socket or named pipe |
| `--ssh-host <user@host>` | `HERDR_SSH_HOST` | Disabled; supported on Linux and macOS |
| `--session <name>` | `HERDR_SESSION` | Named Herdr session, if set |
| `--public-dir <path>` | `PUBLIC_DIR` | Embedded assets |
| `--log-level <level>` | `ROAMGATE_LOG_LEVEL` | `info` |
| `--open` | `OPEN_BROWSER=1` | Disabled |

Additional runtime settings:

| Environment variable | Purpose |
| --- | --- |
| `ROAMGATE_UPDATE_BASE_URL` | Override the latest-release asset directory |
| `ROAMGATE_DISABLE_UPDATE_CHECK=1` | Disable update checks |
| `ROAMGATE_RESTART_SUPERVISOR=0\|1` | Declare or override external supervisor detection |
| `ROAMGATE_DISABLE_ENDPOINT=1` | Use the legacy terminal fallback; see compatibility limits above |

A custom update mirror must use the same flat asset layout as GitHub Releases
and provide each platform archive, its `.sha256` file, and the corresponding
`roamgate-<platform>.update.json` metadata file with `name: "roamgate"`.
Roamgate rejects legacy manifests and does not fall back to reading archive
metadata when its manifest is missing. HTTPS is required except for
loopback test mirrors. URLs containing credentials, query strings, or fragments
are rejected.

Common examples:

```bash
# Local use without authentication
roamgate

# Listen on all interfaces with a generated token
roamgate --host 0.0.0.0 --port 8787

# Use a fixed password and the login page
roamgate --host 0.0.0.0 --port 8787 --password 's3cr3t'
```

Read [SECURITY.md](../SECURITY.md) before using a non-loopback bind.

## Logging

Logs contain one event per line: ISO timestamp, severity, scope, and bounded
key/value context. Default `info` covers startup, readiness/recovery, degraded
states, and fatal errors, excluding routine RPC, Herdr events, frames, and
successful auto-sync. Temporarily use `debug` for request/lifecycle diagnosis:

```bash
roamgate --log-level debug
# or in roamgate.env
ROAMGATE_LOG_LEVEL=debug
```

Restart services after editing `roamgate.env`. Debug may expose paths and
connection/terminal IDs; return to `info` after diagnosis. Logs omit auth tokens
from browser/LAN URLs; generated tokens stay in the protected file below.

## Multiple and remote Herdr connections

Use the title's connection selector to add/test/connect/disconnect/edit/remove
servers. Authenticated browsers share profiles but select independently. Local
profiles attach to existing sockets, never start Herdr. Creating the first profile
retains the default server as a writable `Local` profile.

![Connection selector showing local and SSH profiles](./screenshots/multi-connection-selector.png)

Open the selector with Enter, Space, Up, or Down; navigate with arrows/Home/End.
There is no global next/previous-connection shortcut.

SSH profiles require an already-running remote Herdr server and accept only an
OpenSSH alias or `user@host`. Leave the remote control and render socket paths
empty to resolve the default sockets under the remote home directory. Configure
ports, jump hosts, identities, and other transport details in `~/.ssh/config`.
Roamgate follows normal OpenSSH host-key and agent or Keychain policies; it
does not store passwords, private keys, passphrases, or arbitrary SSH options.

```text
Destination: workbox
Control socket: (empty - auto)
Render socket:  (empty - auto)
```

SSH profiles and `--ssh-host` currently require Roamgate to run on Linux or
macOS because the stream-local transport cannot expose a forwarded Unix socket
as a local Windows named pipe. Windows supports native local Herdr profiles.

Profiles are stored atomically in `~/.config/roamgate/connections.json` on Unix
or `%APPDATA%\roamgate\connections.json` on Windows (overridable with `ROAMGATE_CONNECTIONS_PATH`), with directory mode `0700` and
file mode `0600` on Unix. Registry/direct-parent symlinks are rejected. Version-1
local registries migrate to version 2 on the first successful mutation. Invalid
registries are preserved with mutations disabled: repair the durable file before
retrying. A failed durable rollback retires routing and disables further profile
changes rather than allowing disk and memory to disagree.

`auto_connect` controls profile startup; browser selection is independent.
Disconnecting or removing a profile stops only its bridge runtime/tunnel, not
Herdr or its workspaces. SSH profiles retry transient transport failures, but
not authentication, host-key, or permanent protocol errors. Confirm host keys
and authentication as the service user before connecting; service SSH cannot
prompt interactively. There is no automatic idle cleanup or aggregate runtime
resource budget, so disconnect unused profiles when conserving resources.
See [connection isolation](./ARCHITECTURE.md#connection-isolation) and
[SSH transport](./ARCHITECTURE.md#ssh-transport).

Explicit CLI/environment socket or SSH settings remain authoritative as a
read-only `legacy-default` process profile; edit those settings to change that
connection. Browser preferences from the old single-connection setup migrate
once into the first real profile without overwriting existing values.

The legacy command-line connection is also available:

```bash
roamgate --ssh-host user@host
```

It forwards both control and terminal-render sockets. Image paste, workspace
file operations, Git operations, and repository worktree hooks then run on the
remote host. Explicit `--socket-path` and `--client-socket-path` values override
the automatically selected tunnel paths.

## Run as a user service

The standalone binary can install and manage a platform-native user service:

```bash
roamgate service install
roamgate service status
roamgate service restart
roamgate service reload
roamgate service uninstall
```

| Command | Behavior |
| --- | --- |
| `service install` | Create or update the service definition and start it |
| `service install --force` | Replace a definition not generated by Roamgate |
| `service status` | Show native service-manager status |
| `service restart` | Restart after changing `roamgate.env` |
| `service reload` | Reload the platform definition, then restart |
| `service uninstall` | Stop and remove the service while preserving configuration and tokens |

Verify the running service with:

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

Linux uses `~/.config/systemd/user/roamgate.service` with `Restart=always`.
macOS uses `~/Library/LaunchAgents/dev.roamgate.plist`, Label `dev.roamgate`,
with `KeepAlive`; logs are `~/Library/Logs/roamgate.stdout.log` and
`roamgate.stderr.log`. Windows registers `dev.roamgate-<user-key>` (a hash of
its per-user config directory), with `roamgate-task.ps1` under
`%APPDATA%\roamgate`. The task starts at login with normal privileges
and restarts on failure. Old `dev.herdr.herdr-gui` / `herdr-gui.service` / hashed
Windows task identities must be stopped and removed first as described above.

A new service listens on `0.0.0.0:8787`, creates a persistent login token, and
prints tokenized localhost and LAN URLs during installation. Configuration is
stored in `~/.config/roamgate/roamgate.env` on Unix or
`%APPDATA%\roamgate\roamgate.env` on Windows and is preserved on reinstall or
uninstall. Edit that file for `HOST`, `PORT`, an optional fixed password, and
Herdr connection settings, then run `roamgate service restart`.

The random token is stored in `~/.config/roamgate/auth-token` on Unix and
`%APPDATA%\roamgate\auth-token` on Windows. Visiting a printed `?token=...` URL
sets an HttpOnly session cookie and removes the token from the address bar. To
rotate the token, stop the service, replace the new token file with a fresh
64-character lowercase hexadecimal secret using mode `0600`, and restart.
Deleting only the new file restores a readable legacy token on next startup.

On Windows, approve the Task Scheduler or firewall prompt if one appears. Allow
Private networks only, or set `HOST=127.0.0.1` before installation for
local-only access. On Linux, enable linger with
`sudo loginctl enable-linger "$USER"` if the service must survive logout.

Templates under `deploy/` remain available for manual customization. A custom
systemd wrapper should replace `ExecStart` while leaving systemd as the restart
owner:

```ini
[Service]
ExecStart=
ExecStart=/absolute/path/service-wrapper -- %h/.local/bin/roamgate --host 0.0.0.0
```

The updater saves the replaced executable as `roamgate.previous`, atomically
installs the verified binary, and exits. It never starts a replacement process.
A subsequent `service install` preserves a custom `ExecStart` from a managed
unit when it still invokes the same Roamgate binary.

## Build a standalone executable

From a checkout, install dependencies and embed the frontend/Bun runtime into
one executable:

```bash
bun scripts/studio-plugin.ts build-source
# server/roamgate (server/roamgate.exe on Windows)
```

With dependencies installed, rebuild with `bun run build`. The executable serves
the frontend, bridge, and HTTP APIs and connects to Herdr; the target needs no Bun.

Cross-compile or package:

```bash
bun run build:linux-x64
bun run build:linux-arm64
bun run build:darwin-x64
bun run build:darwin-arm64
bun run build:windows-x64
bun run build:windows-arm64
bun run build:all

bun run package:linux-x64
bun run package:linux-arm64
bun run package:darwin-x64
bun run package:darwin-arm64
bun run package:windows-x64
bun run package:windows-arm64
```

Bun downloads the target runtime automatically. Use the glibc Linux x86-64
build for Ubuntu, Debian, Fedora, and CentOS; the musl build is not supported on
these hosts because Bun's musl binary still dynamically links `libstdc++` and
`libgcc_s`.

Run or clean a local build with:

```bash
./server/roamgate
bun run clean
```

## Troubleshooting

### Roamgate cannot connect to Herdr

Confirm that Herdr is running and that its control socket exists:

```bash
ls ~/.config/herdr/herdr.sock
roamgate --socket-path /path/to/herdr.sock
```

### Another device cannot open Roamgate

Listen on all interfaces, use the tokenized URL printed at startup, and confirm
that both devices are on the same network and the firewall allows the port:

```bash
roamgate --host 0.0.0.0 --port 8781
```

### `--ssh-host` still connects locally

Do not also set `--socket-path`, `--client-socket-path`, `HERDR_SOCKET_PATH`, or
`HERDR_CLIENT_SOCKET_PATH`; explicit socket paths override automatic SSH
tunnels.

### Open the browser automatically

Pass `--open` or set `OPEN_BROWSER=1`:

```bash
roamgate --open
```

For release preparation and platform packaging requirements, see
[AGENTS.md](../AGENTS.md).
