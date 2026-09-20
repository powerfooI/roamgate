# Installation and Deployment

Configuration reference for Roamgate. For a guided workflow and private remote
access, use the [tutorial](./TUTORIAL.md#networking).

## Requirements

- A running Herdr server, or [managed local setup](#managed-herdr-setup).
- Default Unix sockets: `~/.config/herdr/herdr.sock` and
  `~/.config/herdr/herdr-client.sock`; Windows uses corresponding named pipes
  under `%APPDATA%\herdr\`.
- [Bun](https://bun.sh) 1.4.1+ for source builds only; standalone needs no Bun/Node.js.

### Herdr compatibility

This source build supports verified legacy protocols 14–20 (Herdr 0.7.0–0.8.2)
and **tagged Herdr 0.9.0 / protocol 22**. Protocol 21 and unknown versions are
rejected at control/binary probes. Use a compatible Roamgate build or separate
server; **do not downgrade a live server**. Published binaries follow their
[release notes](https://github.com/powerfooI/roamgate/releases).
The [plugin](#herdr-plugin) separately requires Herdr 0.7.2+.

Herdr 0.9.0 uses stable endpoint generation 1, distinct from protocol 22.
`ROAMGATE_DISABLE_ENDPOINT=1` explicitly selects legacy direct-terminal fallback.

| Area | Behavior / limitation |
| --- | --- |
| Attachment | Endpoints crop the server-rendered tab per pane. Unknown codecs/generations or missing required `pane.focus` fail without silent fallback. Legacy fallback uses takeover and may disconnect another owner. |
| Optional methods | Creation/history controls require advertised methods; unavailable controls explain why. Input, mouse, paste, resize, and rendering can work without optional history. |
| Navigation | Endpoint workspace/tab selection is browser-local across reconnects, not reload/runtime replacement. Same-tab pane focus, topology, and terminal sizes remain shared; size follows Herdr's last-interacting client. Legacy uses shared navigation. |
| Creation | Requires a connected source terminal, except first-workspace bootstrap. Preserves `terminal.new_cwd` (`follow`, `home`, `current`, fixed path); explicit cwd wins. Shared pane focus means `follow` is not browser-isolated. |
| Input | Pixel mouse and enhanced Kitty keyboard / modifyOtherKeys parity are unsupported; legacy keyboard-mode messages are decoded but not applied in-browser. |

**OSC 52 clipboard writes:** only the browser with input in the last 30 seconds
matching the receiving endpoint session receives them, never passive viewers.
Herdr supplies no producing-pane/input identity: a delayed write from A after B
becomes foreground can reach B's recent input owner. This is not source-PTY or
original-browser isolation. Detach/replacement/disposal invalidates ownership.
Reads are disabled; permission failures show copy-retry UI. Ordinary copy/paste
is unchanged. OSC 52 is unavailable on the **0.9.0 legacy fallback**; older
servers retain their existing relay.

Closing one workspace never implicitly closes its linked group. If Herdr requires
that, inspect all linked workspaces before explicitly running:

```bash
herdr --session <name> workspace close <workspace_id> --group
```

See [endpoint contracts](./ARCHITECTURE.md#terminal-endpoints) and
[creation/timeouts](./ARCHITECTURE.md#browser-navigation-and-creation).

## Install a release

Roamgate 0.7.0+ releases provide Linux/macOS/Windows x86-64 and ARM64 assets.
Older releases may lack native Windows ARM64; prefer it when available.
Unpublished versions require a [source build](#build-a-standalone-executable).

On Linux/macOS, the checksum-verifying installer writes `~/.local/bin/roamgate`:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | sh
```

Add `~/.local/bin` to PATH, run `roamgate --version`, then `roamgate` and open the
printed URL. Rerun the installer to update.

On Windows, download matching `roamgate-windows-<arch>.tar.xz` and `.sha256`
files from the [latest release](https://github.com/powerfooI/roamgate/releases/latest),
verify with `Get-FileHash`, extract with Windows 11's `tar.exe`, and run `roamgate.exe`.

Installer overrides apply to the `sh` command above:

| Setting | Example / behavior |
| --- | --- |
| Pin a version | `ROAMGATE_VERSION=X.Y.Z sh` (no `v`; empty means latest) |
| System directory | `sudo env ROAMGATE_INSTALL_DIR=/usr/local/bin sh` (empty rejected) |
| Release mirror | `ROAMGATE_RELEASE_BASE_URL` selects a compatible flat asset directory |

Mirrors require HTTPS except loopback testing; URLs cannot contain credentials,
queries, or fragments. Installer and in-app updater preserve the old executable
as `roamgate.previous` for manual recovery.

## Managed Herdr setup

```bash
roamgate herdr setup
roamgate herdr status
```

If absent, setup downloads **Herdr 0.9.0**, verifies build-pinned SHA-256 hashes,
and installs to `~/.local/bin/herdr` on Unix or
`%APPDATA%\roamgate\herdr\0.9.0` on Windows. It never replaces a binary it did not
install. If already installed, it uses the first binary on PATH or in those
locations, leaving it in place. Unix's standard location supports `herdr update`;
Windows uses Roamgate's private versioned directory, not the official junctioned
store, and needs a newer verified Roamgate install for replacement.

Setup installs/starts `herdr server` as a user service: `roamgate-herdr.service`
(Linux), `dev.roamgate.herdr` (macOS), or a per-user Windows scheduled task.
Definitions carry a Roamgate marker; unrelated existing definitions are untouched.
The web UI offers the same confirmed **Set up Herdr / Start Herdr** action when
the default local server is unreachable, with visible failures/retry.

Only default local configuration is supported. SSH profiles/`--ssh-host`, named
sessions, and explicit control/render socket flags or environment variables are
refused; start Herdr yourself for those configurations.

To stop and disable, use native tools:

```bash
systemctl --user disable --now roamgate-herdr.service  # Linux
launchctl bootout gui/$(id -u)/dev.roamgate.herdr      # macOS
# Windows: find dev.roamgate.herdr-<key> in herdr-task.ps1
schtasks /End /TN "<task-name>"
schtasks /Delete /TN "<task-name>" /F
```

Then remove only its generated definition:
`~/.config/systemd/user/roamgate-herdr.service`,
`~/Library/LaunchAgents/dev.roamgate.herdr.plist`, or
`%APPDATA%\roamgate\herdr-task.ps1`. Linux also needs
`systemctl --user daemon-reload`. Remove an installed binary only if unwanted
and owned by this setup; never delete the shared `~/.local/bin` directory.

## Transition from Herdr Studio / herdr-gui

**Herdr Studio / herdr-gui 0.6.2 and earlier require manual installation.**
Roamgate 0.7.0+ publishes only `roamgate-*` assets/manifests and
`install-roamgate.sh`. Old Latest/update channels no longer deliver fixes and may
error; historical tagged downloads and running processes remain intact.
Legacy assets are not republished because old clients can discover archives
without manifests. Custom mirrors/pinned historical downloads are outside this cutoff.

**Service, data, and plugin identity migration requires Roamgate 0.7.1+.**
0.7.0 can update its binary through the new channel, but still uses legacy service
names, paths, and `herdr.studio` plugin ID. Binary updates never rename services
or migrate plugin registrations automatically.

1. Back up executable, service definition, and config with permissions intact.
   Include `~/.config/herdr-gui/` and Windows `%APPDATA%\herdr-gui\` plus the old
   `~/.config/herdr-gui/` settings/profile location.
2. Before replacing the executable, stop/uninstall with `herdr-gui service uninstall`
   or the previous Roamgate binary's `service uninstall`. For custom wrappers,
   stop/disable/archive through the native manager and preserve args/environment.
   Stop unmanaged processes too; never leave both auto-start entries enabled.
3. Install 0.7.1+ or build source, then explicitly run `roamgate service install`
   (`./server/roamgate service install` for source). Install rejects existing/loaded
   legacy services and detection errors, even with `--force`, before changing files.
4. Verify status, login, and connections. To roll back, uninstall with the new
   binary, restore the old binary/definition, and enable only that service.
   New-directory changes are not synchronized back.

After an in-place 0.7.0 update, the new CLI can route status/restart/reload/uninstall
to the **sole unmodified generated legacy definition pointing at this executable**.
It preserves name/environment/data and installs nothing automatically. Ambiguous
old/new services, custom/symlinked definitions, loaded services missing definitions,
or detection errors require the previous binary/native manager; the CLI never guesses.

New data lives in `~/.config/roamgate` or Windows `%APPDATA%\roamgate`:

- Missing tokens/settings/connections copy on first use; service install also
  copies `herdr-gui.env` to `roamgate.env`. Existing new files win, even empty/invalid.
- Copies retain originals and restrict permissions to the owner's existing
  read/write bits. Copy failures stop without replacement credentials; legacy
  symlinks are rejected. Explicit registry-path overrides are not migrated.
- Windows reads old settings/profiles from historical `~/.config/herdr-gui`.
  Stop old writers first: migration is one-way, not synchronization.
- Browser `roamgate:` keys copy missing legacy values on the **same origin** only.
  New values win; remembered deletions prevent old drafts reappearing. The website
  checklist follows the same rule. Host/port changes cannot transfer storage.

[Plugin migration](#herdr-plugin) is explicit. Historical releases retain their contracts.

### Repository and website addresses

Use [powerfooI/roamgate](https://github.com/powerfooI/roamgate) and
<https://roamgate.dev/> ([tutorial](https://roamgate.dev/tutorial/)). GitHub redirects
old `powerfooI/herdr-studio` Git/release URLs; **do not reuse the old repo name**,
which would remove redirects. The `/roamgate/` Pages URL redirects to the new site;
do not rely on `/herdr-studio/`.

### Install historical Herdr Studio

The retained [legacy installer](../scripts/install-herdr-gui.sh) installs only
`herdr-gui`, has no working Latest channel, and is absent from new releases.
Pin a historical tag, with no future fixes through that channel:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/download/v0.6.2/install-herdr-gui.sh \
  | HERDR_GUI_VERSION=0.6.2 sh
```

## Herdr plugin

Requires Herdr 0.7.2+ and Bun for the shim. Plugin ID is `roamgate` from 0.7.1;
0.7.0 uses `herdr.studio`. The shim refuses prebuilt downloads through 0.7.0.

**Migrating `herdr.studio`:** stop/uninstall its old service first, close old plugin
panes, finish pending actions, then unregister:

```bash
herdr plugin disable herdr.studio
herdr plugin unlink herdr.studio
```

Unlink retains checkout/data, including managed checkouts. Keep them for rollback;
do not run old and new start actions together. Roamgate never edits Herdr's registry.

For an **unreleased checkout**, build before linking (existing binaries are not
validated). Keep the checkout and rebuild after updates:

```bash
git clone https://github.com/powerfooI/roamgate.git
cd roamgate
bun scripts/studio-plugin.ts build-source
herdr plugin link .
```

`build-source` installs workspace dependencies and builds `server/roamgate`
(`roamgate.exe` on Windows). Linking after success skips release download;
neither step starts the service.

For a **published release**, replace `X.Y.Z` with 0.7.1 or newer:

```bash
herdr plugin install powerfooI/roamgate --ref vX.Y.Z
```

The manifest downloads/checksum-verifies that version's binary. Failure never
falls back to compilation or legacy assets; unpublished versions cannot use this path.

Plugin actions manage the same [user service](#run-as-a-user-service):

```bash
herdr plugin action invoke roamgate.start      # install/start
herdr plugin action invoke roamgate.url        # login URL
herdr plugin action invoke roamgate.status
herdr plugin action invoke roamgate.restart
herdr plugin action invoke roamgate.uninstall  # remove service, retain data
```

Actions are asynchronous. Inspect `herdr plugin log list --plugin roamgate` or
open `herdr plugin pane open --plugin roamgate --entrypoint panel` for status,
URL, version, and start/restart/uninstall controls. Default is a session-modal
popup; `--placement split`, `tab`, `zoomed`, or `overlay` creates a regular pane
visible to other Herdr clients.

## Basic runtime configuration

Flags override environment variables, then defaults; `roamgate --help` lists all
options. Standalone ignores cwd `.env`/`bunfig.toml`: export variables, pass flags,
or edit the service environment file. Source `bun run` retains normal Bun loading.

`ROAMGATE_*` accepts legacy `HERDR_GUI_*` aliases, including installer settings.
The new name wins **even when empty**. Herdr's `HERDR_*` settings are unchanged;
explicit connection registry paths remain authoritative, including empty values.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--host <addr>` | `HOST` | `127.0.0.1` |
| `--port <n>` | `PORT` | `8787` |
| `--password <pw>` | `ROAMGATE_PASSWORD` | Generated token for non-loopback |
| `--tls-cert <path>` | `ROAMGATE_TLS_CERT` | Disabled; PEM chain, requires key |
| `--tls-key <path>` | `ROAMGATE_TLS_KEY` | Disabled; PEM key, requires certificate |
| `--socket-path <path>` | `HERDR_SOCKET_PATH` | Default control socket/pipe |
| `--client-socket-path <path>` | `HERDR_CLIENT_SOCKET_PATH` | Default render socket/pipe |
| `--ssh-host <user@host>` | `HERDR_SSH_HOST` | Disabled; Linux/macOS only |
| `--session <name>` | `HERDR_SESSION` | Default session |
| `--public-dir <path>` | `PUBLIC_DIR` | Embedded assets |
| `--log-level <level>` | `ROAMGATE_LOG_LEVEL` | `info` |
| `--open` | `OPEN_BROWSER=1` | Disabled |

| Additional environment variable | Purpose |
| --- | --- |
| `ROAMGATE_UPDATE_BASE_URL` | Latest-release mirror directory |
| `ROAMGATE_DISABLE_UPDATE_CHECK=1` | Disable update checks |
| `ROAMGATE_RESTART_SUPERVISOR=0\|1` | Override external supervisor detection |
| `ROAMGATE_DISABLE_ENDPOINT=1` | Legacy terminal fallback; see compatibility |

Update mirrors need platform archives, `.sha256` files, and
`roamgate-<platform>.update.json` with `name: "roamgate"`. Missing/legacy manifests
fail closed without archive discovery. HTTPS is required except loopback tests;
credentials, queries, and fragments in URLs are rejected.

```bash
roamgate                              # local, no login
roamgate --host 0.0.0.0 --port 8787     # generated token
```

For a fixed password, prefer `ROAMGATE_PASSWORD` over process-visible
`--password`. Read [Security](../SECURITY.md) before non-loopback use.

### Native HTTPS

Supply both a PEM chain (leaf first) and matching unencrypted private key:

```bash
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert /path/to/cert-chain.pem \
  --tls-key /path/to/private-key.pem
```

Missing/unreadable/malformed/mismatched files stop startup, never fall back to
HTTP. Without TLS settings, HTTP is used. HTTPS adds `Secure` cookies and HTTPS
startup links, but **does not change authentication**: loopback bypasses login;
non-loopback requires a token/password. Do not expose directly to the public internet.

For private LAN testing, use your issuer or [mkcert](https://github.com/FiloSottile/mkcert).
Replace this reserved example IP with the host's actual LAN address:

```bash
mkcert -install
mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1 192.0.2.10
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert "$PWD/cert.pem" --tls-key "$PWD/key.pem"
```

- SANs must match each client hostname/IP; `localhost` does not cover LAN addresses.
- Every device must trust the issuer. Transfer only mkcert's `rootCA.pem` from
  `mkcert -CAROOT`, **never `rootCA-key.pem`**. On iOS, install the CA profile and
  enable full trust in Settings > General > About > Certificate Trust Settings.
- Bypassing warnings does not enable Service Workers/secure APIs. Verify trusted
  HTTPS before Home Screen installation; remove temporary CA profiles after tests.
- Protect keys and keep them out of Git. Issuance/renewal is external; restart
  after replacement. Services need absolute paths in their environment file.

## Web Push notifications

1. Use trusted HTTPS; on iOS/iPadOS 16.4+, open the installed Home Screen app.
2. Enable **Task notifications**, grant permission, and choose **Agent needs input**
   and/or **Task completed**. **Background push** confirms enrollment; existing
   local-only users should toggle off/on once.

Server push is enabled by default; every device still needs enrollment.
`ROAMGATE_WEB_PUSH_SUBJECT` optionally sets a `mailto:`/HTTPS operator contact,
not a delivery destination. Default: `https://github.com/powerfooI/roamgate/issues`.
An explicitly empty value disables push; restart after changes. Removing the
variable restores the default and enables delivery.

Private VAPID keys/subscriptions live in `~/.config/roamgate/web-push.json` or
`%APPDATA%\roamgate\web-push.json`; override with `ROAMGATE_WEB_PUSH_PATH`.
**Protect/back up this file, never share/commit it, and use one writer per file.**
Corrupt data is preserved and push disabled rather than silently rotating keys.
After intentional key replacement, reopen/toggle notifications to re-enroll.
Browser profiles/subscriptions are device-specific.

Delivery needs outbound HTTPS to Apple (`*.push.apple.com`), Google
(`fcm.googleapis.com`), Mozilla (`*.push.services.mozilla.com`), or Windows
(`*.notify.windows.com`); other providers are rejected. No public inbound endpoint
is needed. Devices must reach their provider and Roamgate when opening an alert.

The bridge and relevant Herdr runtimes must stay connected. It observes
`working -> blocked` and `working -> done/idle` without open browsers; startup
snapshots are silent. Delivery is best-effort: OS/Focus settings, outages, expired
subscriptions, or stopped runtimes can prevent it. Messages expire after five
minutes, with no durable replay; HTTP 404/410 removes expired subscriptions.

Turning notifications off revokes on the server before browser unsubscribe.
If revocation fails, reconnect/retry or revoke OS/browser permission immediately;
already-accepted messages may arrive. Server-wide disable retains the registry
for reuse when re-enabled. Password changes do not revoke device subscriptions.

**Active page only** is the fallback when push is unavailable; do not rely on it
while suspended/closed. Encrypted payloads contain agent names/routing IDs, not
terminal output, and may appear on lock screens.

## Logging

Logs use one line per event: timestamp, severity, scope, bounded key/value context.
`info` covers lifecycle/failures, not routine RPC/events/frames/successful auto-sync.
Use `roamgate --log-level debug` or `ROAMGATE_LOG_LEVEL=debug` temporarily;
restart services after editing their environment. Debug can expose paths/IDs;
return to `info` afterwards. Logs omit URL auth tokens, which remain in protected files.

## Multiple and remote Herdr connections

The title's selector adds/tests/connects/disconnects/edits/removes shared profiles;
each browser selects independently. Local profiles attach to sockets, not start
Herdr. The first saved profile retains the default as writable `Local`.

![Connection selector with local and SSH profiles](./screenshots/multi-connection-selector.png)

Use Enter/Space/Up/Down to open; arrows/Home/End navigate. There is no global
next/previous-connection shortcut.

SSH requires an already-running remote Herdr and accepts an OpenSSH alias or
`user@host`. Leave socket paths empty to resolve remote home defaults. Put ports,
jump hosts, keys, and other options in `~/.ssh/config`; Roamgate stores no SSH
passwords/keys/passphrases/options. Verify host keys and noninteractive service-user
authentication first. SSH forwarding requires a Linux/macOS bridge; Windows only
supports native local profiles because forwarded Unix sockets are not named pipes.

Profiles live atomically in `~/.config/roamgate/connections.json` or Windows
`%APPDATA%\roamgate\connections.json` (`ROAMGATE_CONNECTIONS_PATH` overrides).
Unix directory/file modes are `0700`/`0600`; registry/direct-parent symlinks are
rejected. Version 1 migrates on first successful mutation. Invalid files remain
intact with mutations disabled; repair before retry. Failed durable rollback
retires routing and blocks edits rather than letting memory/disk disagree.

`auto_connect` controls startup, not browser selection. Disconnect/removal stops
only the runtime/tunnel, never Herdr/workspaces. SSH retries transient failures,
not auth/host-key/permanent protocol errors. There is no idle cleanup or aggregate
resource budget; disconnect unused profiles.

Explicit CLI/environment connection settings create a read-only `legacy-default`
profile. Change those settings to edit it. Old browser preferences migrate once
into the first real profile without overwriting values.

```bash
roamgate --ssh-host user@host
```

CLI SSH forwards both sockets; file, image-paste, Git, and hooks run remotely.
Explicit socket flags/environment variables override automatic tunnel paths.
See [isolation](./ARCHITECTURE.md#connection-isolation) and
[SSH lifecycle](./ARCHITECTURE.md#ssh-transport).

## Worktree hooks

Configure [Paseo hooks](https://paseo.sh/docs/worktrees) in `paseo.json`:

```json
{
  "worktree": {
    "setup": "bun install",
    "opened": "./scripts/worktree-opened.sh",
    "teardown": "./scripts/worktree-teardown.sh",
    "removed": "./scripts/worktree-removed.sh"
  }
}
```

| Hook | Timing / working directory |
| --- | --- |
| `setup` | After create/open; new worktree |
| `opened` | After opening an existing worktree; opened worktree |
| `teardown` | Before removal; target worktree |
| `removed` | After removal; source checkout |

For the first three, the target's config wins; only an absent file falls back to
the source. `removed` normally uses source config because the target is gone.
Commands run through `sh -c`, remotely for SSH connections.

| Variable | Value |
| --- | --- |
| `PASEO_HOOK` | Hook name |
| `PASEO_CHECKOUT_PATH` | Target path, including former path after removal |
| `PASEO_SOURCE_CHECKOUT_PATH` | Source checkout when known |
| `ROAMGATE_HOOK_EVENT` | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `ROAMGATE_HOOK_CHECKOUT_PATH` | Same target path |
| `ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH` | Same source path |

Legacy `HERDR_GUI_HOOK_*` aliases remain. Notices show bounded diagnostics.
**Failed teardown stops removal; other failures do not roll back completed actions.**
Hooks default on; inspect/disable per repository under **Worktree hooks** or
**Worktree Lifecycle**. They are trusted, unsandboxed code: review before acting.

## Run as a user service

| Command | Behavior |
| --- | --- |
| `roamgate service install` | Create/update definition and start |
| `roamgate service install --force` | Replace a non-Roamgate definition (not a legacy migration bypass) |
| `roamgate service status` | Native manager status |
| `roamgate service restart` | Restart after environment changes |
| `roamgate service reload` | Reload definition, then restart |
| `roamgate service uninstall` | Stop/remove service; retain configuration/tokens |

| Platform | Definition / behavior |
| --- | --- |
| Linux | `~/.config/systemd/user/roamgate.service`, `Restart=always` |
| macOS | `~/Library/LaunchAgents/dev.roamgate.plist`, label `dev.roamgate`, `KeepAlive`; logs `~/Library/Logs/roamgate.stdout.log` / `roamgate.stderr.log` |
| Windows | Task `dev.roamgate-<user-key>` (config-path hash), `%APPDATA%\roamgate\roamgate-task.ps1`; login start, normal privileges, restart on failure |

Stop/remove legacy services first via the [migration procedure](#transition-from-herdr-studio--herdr-gui).
**New services bind `0.0.0.0:8787`**, generate a persistent token, and print
localhost/LAN token URLs. Config lives in `~/.config/roamgate/roamgate.env` or
`%APPDATA%\roamgate\roamgate.env`, preserved on reinstall/uninstall. Edit HOST,
PORT, password, and Herdr settings there, then restart. For local-only installation,
set `HOST=127.0.0.1` first. On Windows, allow Private networks only if prompted;
on Linux, `sudo loginctl enable-linger "$USER"` keeps services after logout.

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

Tokens live in `~/.config/roamgate/auth-token` or `%APPDATA%\roamgate\auth-token`.
A `?token=...` visit sets an HttpOnly cookie and removes the URL token. To rotate,
stop the service, replace the file with a fresh 64-character lowercase hexadecimal
secret (mode `0600`), then restart. **Deleting only the new file can restore a
readable legacy token**, not rotate it.

Manual templates live under `deploy/`. Keep systemd as restart owner for wrappers:

```ini
[Service]
ExecStart=
ExecStart=/absolute/path/service-wrapper -- %h/.local/bin/roamgate --host 0.0.0.0
```

The updater saves `roamgate.previous`, atomically installs a verified binary, and
exits; it never starts its replacement. Reinstall preserves custom `ExecStart`
in a managed unit when it still invokes the same binary.

## Build a standalone executable

```bash
bun scripts/studio-plugin.ts build-source
# Output: server/roamgate (server/roamgate.exe on Windows)
```

This installs dependencies and embeds frontend/Bun. Afterward, `bun run build`
rebuilds; targets need no Bun. Cross-build/package with `bun run build:<target>`
or `bun run package:<target>`:

| Targets | Architectures |
| --- | --- |
| `linux-x64`, `linux-arm64` | Linux x86-64 / ARM64 |
| `darwin-x64`, `darwin-arm64` | macOS Intel / Apple Silicon |
| `windows-x64`, `windows-arm64` | Windows x86-64 / ARM64 |

`bun run build:all` builds all targets. Bun downloads runtimes automatically.
Use glibc Linux x64 for Ubuntu/Debian/Fedora/CentOS; musl is unsupported there
because Bun's musl binary still dynamically links `libstdc++`/`libgcc_s`.
Run `./server/roamgate`; `bun run clean` removes generated builds.
Release packaging/publishing follows [AGENTS.md](../AGENTS.md#release-notes).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Cannot connect to Herdr | Check server and both socket paths; default local setup can use `roamgate herdr setup`. Override with `--socket-path /path/to/herdr.sock` only deliberately. |
| Another device cannot open the page | Check bind, token URL, network/firewall, and [private access setup](./TUTORIAL.md#networking). |
| SSH connects locally | Remove explicit socket flags/`HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH`; they override tunnel paths. |
| Want automatic browser launch | Use `roamgate --open` or `OPEN_BROWSER=1`. |

For step-by-step diagnosis, see [the tutorial](./TUTORIAL.md#troubleshooting).
