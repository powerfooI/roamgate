# Installation and Deployment

Configuration reference for Roamgate. For a guided walkthrough and private
remote access, see the [tutorial](./TUTORIAL.md#networking).

## Requirements

- A running Herdr server, or let Roamgate [set one up](#managed-herdr-setup).
  Roamgate uses Herdr's default sockets (`~/.config/herdr/herdr.sock` and
  `herdr-client.sock`; named pipes under `%APPDATA%\herdr\` on Windows).
- Release binaries need nothing else. Source builds need
  [Bun](https://bun.sh) 1.4.3+.
- On Windows, local Git features need [Git for Windows](https://gitforwindows.org/)
  on PATH.

### Herdr compatibility

| Herdr | Support |
| --- | --- |
| 0.7.0–0.8.2 (protocols 14–20) | Legacy terminal mode |
| 0.9.0 and 0.9.4 (protocol 22) | Endpoint terminal mode (recommended) |
| Protocol 21 and unknown versions | Rejected |

Do not downgrade a live Herdr server. The [plugin](#herdr-plugin) and tab
reordering need Herdr 0.7.2+. `ROAMGATE_DISABLE_ENDPOINT=1` forces legacy mode.

Known limitations:

- Endpoint mode shares pane focus, layout, and terminal size between clients;
  only workspace/tab selection is per browser. Legacy mode shares everything and
  may take over the terminal from another client.
- Creating tabs or workspaces needs a connected terminal (except the first
  workspace in an empty session) and keeps Herdr's `terminal.new_cwd` policy.
- Pixel mouse reporting and enhanced Kitty keyboard modes are not supported.
- **OSC 52 clipboard writes** go only to the browser that typed into that
  session in the last 30 seconds. Herdr does not say which pane produced a
  write, so a late write can reach the wrong recent typist. Clipboard reads are
  disabled. OSC 52 is unavailable in protocol 22 legacy mode.
- Closing a workspace never closes its linked group. To do that, inspect the
  group and run `herdr --session <name> workspace close <workspace_id> --group`.

See [endpoint contracts](./ARCHITECTURE.md#terminal-endpoints).

## Install a release

Releases include Linux, macOS, and Windows binaries for x86-64 and ARM64.

On Linux/macOS, the checksum-verifying installer writes `~/.local/bin/roamgate`:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | sh
```

Add `~/.local/bin` to PATH, then run `roamgate` and open the printed URL.
`roamgate update` updates (or rerun the installer); `roamgate rollback` restores
the previous binary (`roamgate.previous`).

On Windows, download `roamgate-windows-<arch>.tar.xz` and its `.sha256` from the
[latest release](https://github.com/powerfooI/roamgate/releases/latest), verify
with `Get-FileHash`, extract with `tar.exe`, and run `roamgate.exe`.

Installer settings go on the `sh` side of the pipe (`curl ... | <setting> sh`):

| Installer setting | Example / behavior |
| --- | --- |
| Pin a version | `ROAMGATE_VERSION=X.Y.Z sh` (no `v`; empty means latest) |
| Install directory | `sudo env ROAMGATE_INSTALL_DIR=/usr/local/bin sh` |
| Release mirror | `ROAMGATE_RELEASE_BASE_URL=<https URL of a flat asset directory> sh` |

## Managed Herdr setup

```bash
roamgate herdr setup
roamgate herdr status
```

If Herdr is missing, setup downloads Herdr 0.9.4, verifies its pinned SHA-256,
and installs it (`~/.local/bin/herdr`, or `%APPDATA%\roamgate\herdr\0.9.4` on
Windows x64). An existing Herdr on PATH is used as is. Setup then runs
`herdr server` as a user service: `roamgate-herdr.service` (Linux),
`dev.roamgate.herdr` (macOS), or a per-user scheduled task (Windows). The web UI
offers the same **Set up Herdr / Start Herdr** action when the local server is
unreachable.

Only the default local setup is supported; for SSH, named sessions, or custom
sockets, start Herdr yourself.

To remove the service:

```bash
systemctl --user disable --now roamgate-herdr.service  # Linux
launchctl bootout gui/$(id -u)/dev.roamgate.herdr      # macOS
# Windows: find the task name (dev.roamgate.herdr-<key>) in herdr-task.ps1
schtasks /End /TN "<task-name>"
schtasks /Delete /TN "<task-name>" /F
```

Then delete its definition (`~/.config/systemd/user/roamgate-herdr.service` plus
`systemctl --user daemon-reload`, `~/Library/LaunchAgents/dev.roamgate.herdr.plist`,
or `%APPDATA%\roamgate\herdr-task.ps1`).

## Transition from Herdr Studio / herdr-gui

**Herdr Studio / herdr-gui 0.6.2 and earlier cannot auto-update to Roamgate.**
Their update channel no longer receives fixes. Service, data, and plugin
migration needs Roamgate **0.7.1+**.

1. Back up the executable, service definition, and config, keeping permissions:
   `~/.config/herdr-gui/`, plus `%APPDATA%\herdr-gui\` on Windows (Windows
   also keeps settings and connections in `~/.config/herdr-gui/`).
2. Stop and uninstall the old service with `herdr-gui service uninstall` (or the
   old binary's `service uninstall`). Stop any unmanaged processes too. Never
   leave both services enabled.
3. Install Roamgate and run `roamgate service install`. It refuses to run while
   a legacy service exists, even with `--force`.
4. Check status, login, and connections. To roll back, uninstall with the new
   binary and restore the old binary and service.

On first use, Roamgate copies missing tokens, settings, and connections into
`~/.config/roamgate` (`%APPDATA%\roamgate` on Windows), and service install
copies `herdr-gui.env` to `roamgate.env`. Existing new files always win. The
copy is one-way; stop old processes first. Files at custom
`HERDR_GUI_SETTINGS_PATH`/`HERDR_GUI_CONNECTIONS_PATH` locations are not copied.
Browser preferences carry over only when the URL (host and port) is unchanged.
Migrate the [plugin](#herdr-plugin) separately.

After an in-place update from 0.7.0, the new CLI manages an old service only if
it is the single unmodified generated definition for this executable. Otherwise
(custom, ambiguous, or missing definitions), use the previous binary or the
native service manager.

### Repository and website addresses

The project lives at [powerfooI/roamgate](https://github.com/powerfooI/roamgate)
and <https://roamgate.dev/>. Old `powerfooI/herdr-studio` URLs redirect.

### Install historical Herdr Studio

The [legacy installer](../scripts/install-herdr-gui.sh) installs `herdr-gui`
only and must be pinned to a historical tag:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/download/v0.6.2/install-herdr-gui.sh \
  | HERDR_GUI_VERSION=0.6.2 sh
```

## Herdr plugin

The plugin (ID `roamgate`; `herdr.studio` in 0.7.0) needs Herdr 0.7.2+ and Git.
It uses the standalone executable, so Bun is not required.

Install a published release (0.7.1 or newer):

```bash
herdr plugin install powerfooI/roamgate --ref vX.Y.Z
```

The installer verifies the package checksum, version, and platform before
replacing the executable. To upgrade, run the same command with the new tag;
`herdr plugin update` stays on the original tag.

For an unreleased checkout, build before linking, and rebuild after updates:

```bash
git clone https://github.com/powerfooI/roamgate.git
cd roamgate
bun scripts/studio-plugin.ts build-source
herdr plugin link .
```

Plugin actions manage the same [user service](#run-as-a-user-service):

```bash
herdr plugin action invoke roamgate.start      # install/start
herdr plugin action invoke roamgate.url        # login URL
herdr plugin action invoke roamgate.status
herdr plugin action invoke roamgate.restart
herdr plugin action invoke roamgate.uninstall  # remove service, keep data
```

Actions run asynchronously; check `herdr plugin log list --plugin roamgate`, or
open the panel with `herdr plugin pane open --plugin roamgate --entrypoint panel`.
After updating the plugin, reopen the panel before Start or Restart.

**Migrating from `herdr.studio`:** uninstall its service, close its panes, then
run `herdr plugin disable herdr.studio` and `herdr plugin unlink herdr.studio`.

## Basic runtime configuration

Flags override environment variables, which override defaults. Release binaries
ignore `.env` files: export variables, pass flags, or edit the service
environment file. `roamgate --help` lists everything.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--host <addr>` | `HOST` | `127.0.0.1` |
| `--port <n>` | `PORT` | `8787` |
| `--password <pw>` | `ROAMGATE_PASSWORD` | Generated token |
| None | `ROAMGATE_PIN` | Disabled; see [PIN login](#optional-pin-login) |
| `--tls-cert <path>` | `ROAMGATE_TLS_CERT` | Disabled; PEM chain |
| `--tls-key <path>` | `ROAMGATE_TLS_KEY` | Disabled; PEM key |
| `--socket-path <path>` | `HERDR_SOCKET_PATH` | Default control socket |
| `--client-socket-path <path>` | `HERDR_CLIENT_SOCKET_PATH` | Default render socket |
| `--ssh-host <user@host>` | `HERDR_SSH_HOST` | Disabled; Linux/macOS only |
| `--session <name>` | `HERDR_SESSION` | Default session |
| `--public-dir <path>` | `PUBLIC_DIR` | Embedded assets |
| `--log-level <level>` | `ROAMGATE_LOG_LEVEL` | `info` |
| `--notification-source <herdr\|status>` | `ROAMGATE_NOTIFICATION_SOURCE` | `herdr` |
| `--profile` | `ROAMGATE_PROFILE=1` | Disabled; see [profiling](#performance-profiling) |
| `--profile-duration <seconds>` | `ROAMGATE_PROFILE_DURATION` | `30` (1-300) |
| `--profile-dir <path>` | `ROAMGATE_PROFILE_DIR` | `<data dir>/profiles` |
| `--open` | `OPEN_BROWSER=1` | Disabled |

| Other environment variable | Purpose |
| --- | --- |
| `ROAMGATE_UPDATE_BASE_URL` | HTTPS update mirror directory |
| `ROAMGATE_DISABLE_UPDATE_CHECK=1` | Disable update checks |
| `ROAMGATE_RESTART_SUPERVISOR=0\|1` | Override supervisor detection |
| `ROAMGATE_DISABLE_ENDPOINT=1` | Force legacy terminal mode |
| `ROAMGATE_ALLOW_FILE_REVEAL=1` | Enable [host file reveal](#host-file-reveal) |
| `ROAMGATE_UPLOAD_MAX_BYTES` | Max terminal upload size (default 100 MiB) |
| `ROAMGATE_UPLOAD_RETENTION_HOURS` | Upload retention (default 24) |
| `ROAMGATE_SETTINGS_PATH` | GUI settings file (one per bridge) |
| `ROAMGATE_CONNECTIONS_PATH` | Connection profiles file |
| `ROAMGATE_ASSISTANT_DIR` | Ranger data directory |
| `ROAMGATE_WEB_PUSH_PATH` / `ROAMGATE_WEB_PUSH_SUBJECT` | [Web Push](#web-push-notifications) |

Legacy `HERDR_GUI_*` names still work; the `ROAMGATE_*` name wins, even when
empty.

```bash
roamgate                                # loopback, generated token
roamgate --host 0.0.0.0 --port 8787     # all interfaces, generated token
```

Prefer `ROAMGATE_PASSWORD` over `--password`. Passwords must be 8-1024
characters; use 15+ for anything beyond a trusted private network. See
[Security](../SECURITY.md#trust-model).

### Optional PIN login

For a server reachable only through a trusted VPN or private network, set
`ROAMGATE_PIN` to 6-12 digits (environment or service file only; there is no
flag) and restart. The login form then starts in PIN mode, with the
password/token still available. Changing the PIN signs out all browsers. See
[PIN security](../SECURITY.md#optional-pin-login).

### Host file reveal

**Off by default.** With `ROAMGATE_ALLOW_FILE_REVEAL=1`, local profiles accessed
over loopback get **Reveal on host** and **Open folder on host**, which open the
file manager on the Roamgate host. SSH profiles and non-loopback clients are
refused. **Tunnelled or reverse-proxied loopback clients count as local too**,
so enable it only if every such client may open windows on the host.

### Native HTTPS

Pass a PEM certificate chain (leaf first) and its unencrypted key:

```bash
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert /path/to/cert-chain.pem \
  --tls-key /path/to/private-key.pem
```

Invalid files stop startup instead of falling back to HTTP. HTTPS only adds
encryption; it does not change authentication.

For LAN testing with [mkcert](https://github.com/FiloSottile/mkcert) (use your
host's real LAN IP):

```bash
mkcert -install
mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1 192.0.2.10
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert "$PWD/cert.pem" --tls-key "$PWD/key.pem"
```

Every device must trust the CA: copy only `rootCA.pem` (from `mkcert -CAROOT`),
**never `rootCA-key.pem`**. On iOS, install the profile and enable it under
Settings > General > About > Certificate Trust Settings. Clicking through
certificate warnings does not enable PWA features. Restart after renewing
certificates; services need absolute paths.

## Ranger model connection

Open **Ranger > Settings**, choose a **Provider**, and **Sign in** or **Enter API
key**. Then pick a model, allow workspaces under **Workspace access**, and
**Save settings**.

- **Shared Pi credentials** reuses Pi's `auth.json` and `models.json` for the
  bridge account instead of Ranger's own store.
- **Custom models** add an OpenAI- or Anthropic-compatible endpoint; use a
  separate provider ID per endpoint.
- On a **remote bridge**, use the provider's device-code or manual login; a
  `localhost` callback would reach the browser's machine, not the bridge.
- **High-permission mode** grants every workspace and skips confirmations.
  Workspace content may be sent to the model provider. High-permission settings
  saved by older versions keep their selected workspaces until you confirm the
  all-workspaces option once.
- On Windows SSH hosts, Ranger can read status and terminal output only.

Ranger runs as the bridge's OS account and keeps its data (credentials,
conversations, and scheduled tasks) in `~/.config/roamgate/assistant/`
(`%APPDATA%\roamgate\assistant\`, or `ROAMGATE_ASSISTANT_DIR`). It may contain
secrets: keep it private, use one bridge per directory, and stop the bridge
before backing it up. **Upgrades can migrate `tasks.sqlite` irreversibly**, so
older builds cannot open it: back up the directory before upgrading if you may
roll back.

Unfinished questions and task runs resume after a bridge restart if their
original connections and workspaces are still the same; confirmed actions are
never repeated. See [Ranger](../FEATURES.md#ranger) and
[contracts](ARCHITECTURE.md#ranger).

## Web Push notifications

1. Use trusted HTTPS (or loopback HTTP). On iOS/iPadOS 16.4+, open the installed
   Home Screen app.
2. Enable **Task notifications**, grant permission, and choose **Task needs
   attention** and/or **Task completed**. **Background push** confirms the
   device is enrolled.

`roamgate push test` sends a test notification to every enrolled device. Push is
on by default; setting `ROAMGATE_WEB_PUSH_SUBJECT` to an empty value disables it
(otherwise it is an optional `mailto:` or HTTPS contact). After upgrading,
reload each browser/PWA once so the new notification worker is active.

VAPID keys and subscriptions live in `~/.config/roamgate/web-push.json`
(`%APPDATA%\roamgate\web-push.json`). **Keep it private and backed up**;
replacing it requires every device to re-enroll.

Delivery needs outbound HTTPS to the browser's push service (Apple, Google,
Mozilla, or Microsoft); no inbound port is needed. The bridge and Herdr must stay
running. By default (`--notification-source herdr`, Herdr 0.9+), Roamgate relays
Herdr's own notifications, matching its toasts and suppression rules. With
`status` (or older Herdr), Roamgate watches agents go from working to
blocked/done. Delivery is best-effort; messages expire after five minutes.

Turning notifications off revokes the subscription on the server first. Changing
the password does not revoke devices. Notification text can appear on lock
screens.

### Local notification testing

`http://localhost` and `http://127.0.0.1` are secure contexts, so notifications
work without TLS. Use an isolated data directory and browser profile. To test
end to end, enable **Task notifications**, ask Ranger for a monitoring task with
**Let Ranger decide**, confirm it, and use **Run now**. The automated
integration test covers scheduling and deduplication, but not real browser
delivery:

```sh
bun test server/src/assistant-recovery.integration.test.ts --test-name-pattern 'confirmed Ranger proposals schedule custom notifications'
```

## Logging

Logs have one line per event. `info` covers lifecycle events and failures. Use
`--log-level debug` (or `ROAMGATE_LOG_LEVEL=debug`) temporarily; debug logs can
include paths and IDs, but never URL tokens. `roamgate service logs -f` follows a
managed service.

### Performance profiling

Run a short CPU capture on a spare port, then reproduce the slow interaction in
that instance:

```bash
roamgate --host 127.0.0.1 --port 8788 --profile --profile-duration 30 --open
```

The capture stops automatically and writes a private directory under
`--profile-dir` containing `summary.txt` (CPU, memory, event-loop delay, hottest
functions) and `cpu.json` (raw Bun/JSC samples, **not** Chrome's `.cpuprofile`
format). Files may contain source paths; review before sharing and delete when
done. For readable function names, run from source with
`bun server/src/index.ts --profile`. For services, set `ROAMGATE_PROFILE=1` in
the environment file, restart, and remove it afterwards.

## Multiple and remote Herdr connections

The connection selector in the title bar adds, tests, connects, edits, and
removes profiles shared by all browsers; each browser picks its own.
`roamgate connections` does the same from a terminal. Disconnecting never stops
Herdr.

![Connection selector with local and SSH profiles](./screenshots/multi-connection-selector.png)

**SSH profiles** need an already-running remote Herdr and an OpenSSH alias or
`user@host`. Put ports, keys, and jump hosts in `~/.ssh/config`; Roamgate stores
no SSH secrets. Verify host keys and make sure non-interactive login works. Leave
socket paths empty to use the remote defaults. SSH profiles need a Linux/macOS
bridge; a Windows bridge supports local profiles only. File moves need `python3`
on the remote host.

**Windows SSH hosts:** choose **Windows** as the remote OS, install Herdr 0.9.1+
(including its `conpty/` directory), and start the session first. The SSH shell
must be able to run `powershell.exe`. Roamgate looks for `herdr.exe` on PATH and
in `%LOCALAPPDATA%\Programs\Herdr\bin\`, or you can set its path and session
name. Terminals and Herdr operations work; file, Git, worktree, and agent-history
features need a Unix host. Run Herdr and the SSH user at the same privilege
level: an elevated Herdr 0.9.4 server rejects ordinary clients unless started
with `--allow-unelevated-clients`.

Profiles are stored in `~/.config/roamgate/connections.json`
(`%APPDATA%\roamgate\connections.json`). `auto_connect` controls whether a
profile connects at startup. Transient SSH failures retry; authentication and
host-key failures do not. GUI preferences live in `settings.json` beside it.
Give each bridge on the same account its own `ROAMGATE_SETTINGS_PATH` (an
absolute, stable path; changing it requires logging in again).

Connection flags or variables such as `--ssh-host` create a read-only
`legacy-default` profile:

```bash
roamgate --ssh-host user@host
```

Explicit socket flags/variables override the SSH tunnel paths. See
[isolation](./ARCHITECTURE.md#connection-isolation) and
[SSH transport](./ARCHITECTURE.md#ssh-transport).

## PWA instance names

**Configuration > Instance > Title suffix** turns `Roamgate` into, for example,
`Roamgate · Home` in the page title and PWA name, so several servers are easy to
tell apart. The suffix (up to 32 characters) is saved on the server and shared by
all viewers. Set it before installing the PWA; already installed apps (especially
on Android) may keep the old name until the browser updates the manifest or you
reinstall.

## Worktree hooks

Configure hooks in `roamgate.json` at the repository root:

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

| Hook | When / working directory |
| --- | --- |
| `setup` | After create/open; new worktree |
| `opened` | After opening an existing worktree; that worktree |
| `teardown` | Before removal; target worktree |
| `removed` | After removal; source checkout |

Roamgate uses the first file found, in order: target `roamgate.json`, source
`roamgate.json`, target `paseo.json`, source `paseo.json` (legacy). Files are
never merged. `{}` disables fallback; invalid files report an error. Hooks run
with `sh -c` on the connected (local or SSH) host. To migrate, rename
`paseo.json` to `roamgate.json`.

| Variable | Value |
| --- | --- |
| `ROAMGATE_HOOK_EVENT` | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `ROAMGATE_HOOK_CHECKOUT_PATH` | Target worktree path |
| `ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH` | Source checkout, when known |

`HERDR_GUI_HOOK_*` and `PASEO_HOOK` / `PASEO_CHECKOUT_PATH` /
`PASEO_SOURCE_CHECKOUT_PATH` are also set.

**Hooks are on by default and run unsandboxed repository code with your
permissions.** Review them, or disable them per repository under **Worktree
hooks** or **Worktree Lifecycle**. A failed teardown stops removal; other
failures do not undo completed steps.

## Run as a user service

| Command | Behavior |
| --- | --- |
| `roamgate service install` | Create or update the service and start it |
| `roamgate service install --force` | Replace a non-Roamgate definition |
| `roamgate service status` | Show status |
| `roamgate service restart` | Restart after config changes |
| `roamgate service reload` | Reload the definition, then restart |
| `roamgate service uninstall` | Stop and remove; keeps config and tokens |
| `roamgate service logs [-f]` | Show recent output |

| Platform | Definition |
| --- | --- |
| Linux | `~/.config/systemd/user/roamgate.service` (`Restart=always`) |
| macOS | `~/Library/LaunchAgents/dev.roamgate.plist` (`KeepAlive`); logs in `~/Library/Logs/roamgate.*.log` |
| Windows | Scheduled task `dev.roamgate-<key>` running `%APPDATA%\roamgate\roamgate-task.ps1` at login |

**New services listen on `0.0.0.0:8787`** with a generated token and print
localhost/LAN login URLs. Settings live in `~/.config/roamgate/roamgate.env`
(`%APPDATA%\roamgate\roamgate.env`); edit it and restart, or run
`roamgate config set NAME=value --restart`. For local-only access, set
`HOST=127.0.0.1`. On Linux, `sudo loginctl enable-linger "$USER"` keeps the
service running after logout. Remove legacy services first
([migration](#transition-from-herdr-studio--herdr-gui)).

On macOS the env file is parsed, not executed: use `NAME=value` lines (optionally
prefixed with `export`) with quotes, comments, and `$NAME`/`${NAME}` references
to `HOME` or variables defined earlier in the file. Command substitution and
other outside variables are rejected.

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

**Credentials and sessions.** The generated token is in
`~/.config/roamgate/auth-token` (`%APPDATA%\roamgate\auth-token`). A `?token=`
URL logs in and sets a cookie. Cookies are signed by a separate secret in the
same directory (`session-secret.json`, or `session-secret-<sha256>.json` when
`ROAMGATE_SETTINGS_PATH` is set). Protect both like passwords.

- `roamgate auth rotate` replaces the token, signs out every browser, and
  restarts the service. **Do not just delete `auth-token`**: after a migration,
  the legacy token is copied back on the next start. To rotate by hand, stop
  the service and write a fresh 64-character lowercase hex secret (mode `0600`).
- `roamgate auth revoke-sessions` signs out every browser without changing
  credentials.
- Changing the password or PIN also signs out every browser on the next start.
  Stop all listeners of the instance before changing credentials.
- If startup was killed and a stale `session-secret*.json.lock` directory
  remains, stop all listeners and delete only that lock directory.

Manual templates live in `deploy/`. When wrapping the binary, keep systemd as
the restart owner:

```ini
[Service]
ExecStart=
ExecStart=/absolute/path/service-wrapper -- %h/.local/bin/roamgate --host 0.0.0.0
```

The updater installs a verified binary, keeps `roamgate.previous`, and exits so
the supervisor restarts it.

## Command-line management

These commands act on the [user service](#run-as-a-user-service)'s config and
data, not on the current shell's flags. They exit 0 on success, 1 on failure,
and 2 on bad arguments; many accept `--json`.

| Command | Purpose |
| --- | --- |
| `roamgate doctor [--offline]` | Check config, credentials, TLS, service, network exposure, Herdr, connections, Web Push, and updates, with a fix for each problem. Prints no secrets. |
| `roamgate url [--qr] [--address <host>]` | Print login URLs; `--qr` shows a QR code for a phone (it contains the token); `--address` substitutes a VPN or Tailscale name. |
| `roamgate config show\|get\|set\|unset\|edit\|path` | Read or change `roamgate.env` atomically. `--restart` restarts the service; `KEY=-` reads a secret from stdin. |
| `roamgate auth show\|rotate\|revoke-sessions` | Show the login method, replace the token, or sign out every browser. |
| `roamgate connections list\|test\|add\|remove\|set-default` | Manage [connection profiles](#multiple-and-remote-herdr-connections). Edits are refused while the managed service runs unless `--restart` is given. Only the service config's address is checked, so stop other processes sharing the registry (such as a foreground run on another port) first. |
| `roamgate push test` | Send a test [Web Push](#web-push-notifications) notification. |
| `roamgate update [--check]` / `roamgate rollback` | Update to the latest release or restore `roamgate.previous` (Linux/macOS). |
| `roamgate service logs [-f] [-n <count>]` | Show service output (not available for Windows tasks). |
| `roamgate completion bash\|zsh\|fish` | Print a shell completion script. |

## Build a standalone executable

```bash
bun scripts/studio-plugin.ts build-source
# Output: server/roamgate (server/roamgate.exe on Windows)
```

Afterwards `bun run build` rebuilds. Cross-compile with `bun run build:<target>`
or package with `bun run package:<target>`; `bun run build:all` builds every
target:

| Targets | Architectures |
| --- | --- |
| `linux-x64`, `linux-arm64` | Linux x86-64 / ARM64 (glibc; musl is unsupported) |
| `darwin-x64`, `darwin-arm64` | macOS Intel / Apple Silicon |
| `windows-x64`, `windows-arm64` | Windows x86-64 / ARM64 |

`bun run clean` removes builds. Releases follow
[AGENTS.md](../AGENTS.md#release-notes).

Release binaries have no source maps. Each release run keeps a
`debug-roamgate-<tag>-<target>` CI artifact for 30 days with source maps; extract
its tar and run it to get readable stack traces. To build one locally, run
`bun run build:web` and `bun run --cwd server compile --sourcemap`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Not sure what is wrong | Run `roamgate doctor`. |
| Cannot connect to Herdr | Check that Herdr runs and both sockets exist; try `roamgate herdr setup`. |
| Another device cannot open the page | Check the bind address, token URL, firewall, and [private access setup](./TUTORIAL.md#networking). |
| SSH profile connects locally | Remove socket flags and `HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH`; they override tunnels. |
| Want the browser to open automatically | Use `roamgate --open` or `OPEN_BROWSER=1`. |

For step-by-step diagnosis, see [the tutorial](./TUTORIAL.md#troubleshooting).
