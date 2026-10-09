# Installation and Deployment

Configuration reference for Roamgate. For a guided workflow and private remote
access, use the [tutorial](./TUTORIAL.md#networking).

## Requirements

- A running Herdr server, or [managed local setup](#managed-herdr-setup).
- Default Unix sockets: `~/.config/herdr/herdr.sock` and
  `~/.config/herdr/herdr-client.sock`; Windows uses corresponding named pipes
  under `%APPDATA%\herdr\`.
- [Bun](https://bun.sh) 1.4.1+ for source builds only; standalone needs no Bun/Node.js.

Windows local Git features require [Git for Windows](https://gitforwindows.org/)
with Git available on PATH. Changes, Commits, and branch auto-sync locate its
bundled Bash beside Git or in standard system/per-user installation directories;
`sh.exe` does not need to be on PATH. For a portable or custom installation,
add its `cmd` or `bin` directory to PATH and restart Roamgate. These commands use
Git Bash even when Roamgate starts from PowerShell; SSH workspaces continue to
use the remote host's shell and tools.

### Herdr compatibility

This source build supports verified legacy protocols 14–20 (Herdr 0.7.0–0.8.2)
and **tagged Herdr 0.9.0 / protocol 22**. Protocol 21 and unknown versions are
rejected at control/binary probes. Use a compatible Roamgate build or separate
server; **do not downgrade a live server**. Published binaries follow their
[release notes](https://github.com/powerfooI/roamgate/releases).
The [plugin](#herdr-plugin) separately requires Herdr 0.7.2+.
Tab reordering requires Herdr 0.7.2+; Herdr 0.7.0 and 0.7.1 retain their fixed
tab order. The bridge confirms support before enabling dragging.

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
| `--password <pw>` | `ROAMGATE_PASSWORD` | Generated token when authentication is enabled |
| `--tls-cert <path>` | `ROAMGATE_TLS_CERT` | Disabled; PEM chain, requires key |
| `--tls-key <path>` | `ROAMGATE_TLS_KEY` | Disabled; PEM key, requires certificate |
| `--socket-path <path>` | `HERDR_SOCKET_PATH` | Default control socket/pipe |
| `--client-socket-path <path>` | `HERDR_CLIENT_SOCKET_PATH` | Default render socket/pipe |
| `--ssh-host <user@host>` | `HERDR_SSH_HOST` | Disabled; Linux/macOS only |
| `--session <name>` | `HERDR_SESSION` | Default session |
| `--public-dir <path>` | `PUBLIC_DIR` | Embedded assets |
| `--log-level <level>` | `ROAMGATE_LOG_LEVEL` | `info` |
| `--notification-source <herdr\|status>` | `ROAMGATE_NOTIFICATION_SOURCE` | `herdr`; see [Web Push](#web-push-notifications) |
| `--profile` | `ROAMGATE_PROFILE=1` | Disabled; bounded server CPU capture |
| `--profile-duration <seconds>` | `ROAMGATE_PROFILE_DURATION` | `30`; integer 1..300 |
| `--profile-dir <path>` | `ROAMGATE_PROFILE_DIR` | Roamgate data directory's `profiles/` |
| `--open` | `OPEN_BROWSER=1` | Disabled |

| Additional environment variable | Purpose |
| --- | --- |
| `ROAMGATE_UPDATE_BASE_URL` | Latest-release mirror directory |
| `ROAMGATE_DISABLE_UPDATE_CHECK=1` | Disable update checks |
| `ROAMGATE_RESTART_SUPERVISOR=0\|1` | Override external supervisor detection |
| `ROAMGATE_DISABLE_ENDPOINT=1` | Legacy terminal fallback; see compatibility |
| `ROAMGATE_ALLOW_FILE_REVEAL=1` | Opt into [host file reveal](#host-file-reveal); disabled by default |
| `ROAMGATE_UPLOAD_MAX_BYTES` | Maximum size of a terminal file upload; default 100 MiB |
| `ROAMGATE_UPLOAD_RETENTION_HOURS` | Staged terminal file retention; default 24 hours |

Update mirrors need platform archives, `.sha256` files, and
`roamgate-<platform>.update.json` with `name: "roamgate"`. Missing/legacy manifests
fail closed without archive discovery. HTTPS is required except loopback tests;
credentials, queries, and fragments in URLs are rejected.

```bash
roamgate                              # loopback, generated token
roamgate --host 0.0.0.0 --port 8787     # generated token
```

For a fixed password, prefer `ROAMGATE_PASSWORD` over process-visible
`--password`. It must contain 15-1024 Unicode characters; values outside that
range stop startup, including existing short passwords. Normal runtime requires
login; see [Security](../SECURITY.md#trust-model) for the local development
exception, login limits, and remote access guidance.

### Host file reveal

Desktop file reveal is **off by default**. To enable it, set
`ROAMGATE_ALLOW_FILE_REVEAL=1` in the host process environment (or the service
environment file and restart the service). Only local Herdr profiles and
loopback TCP peers are eligible; SSH profiles and non-loopback peers are refused.
The menus open the **Roamgate host's** file manager, which requires a usable
desktop session. Foreground focus, especially on Windows, is best effort.

**Opt-in also allows loopback-forwarded/tunnel clients to open windows on the
host.** A loopback peer or browser URL cannot prove the browser runs on that
machine. Enable only when that is acceptable for every client reaching the
loopback listener, including reverse proxies and SSH forwards. The browser's
platform is not used to name the host desktop.

### Native HTTPS

Supply both a PEM chain (leaf first) and matching unencrypted private key:

```bash
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert /path/to/cert-chain.pem \
  --tls-key /path/to/private-key.pem
```

Missing/unreadable/malformed/mismatched files stop startup, never fall back to
HTTP. Without TLS settings, HTTP is used. HTTPS adds `Secure` cookies and HTTPS
startup links; it does not change the [authentication rules](../SECURITY.md#trust-model).
Do not expose directly to the public internet.

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

## Ranger model connection

Open the global **Ranger** window and its **Settings** button. Choose
**Ranger connection** or **Shared Pi credentials**, select a provider, and use the available **Sign in**
or **Enter API key** action. Complete the provider's web/device-code or manual
authorization prompt in the window, choose a default model, select allowed
workspaces, and **Save connection**. Each question automatically uses saved
authorized workspaces that are currently available; no workspaces are authorized
by default.

**High-permission mode** is a separate Settings control, off by default. Enabling
it requires an explicit confirmation and authorizes all currently discoverable
workspaces, including new workspaces that appear while the mode is enabled,
without individual selection. Workspace content may be sent to the selected
model provider. Ranger can then execute its supported workspace,
worktree, tab, pane, agent and prompt operations, and create schedules, without
individual approval. Each admitted question and scheduled task retains its
concrete workspace targets; new workspaces do not widen an already-running turn
or an existing task. Disabling the mode restores the saved normal-mode workspace
selection and takes effect before subsequent
automatic operations, including in running tasks; an operation already dispatched
may finish.
Existing tasks retain their saved mode and need an edit to adopt high-permission
mode. Ranger's built-in write/command tools remain disabled.

Existing saved high-permission configurations from older versions keep their
selected-workspace permissions. Confirm the updated all-workspaces option once
to authorize the broader scope; upgrading alone does not grant it.

Deleted workspaces are removed from the list and saved normal-mode selection
after a successful complete inventory confirms their absence. Temporary
disconnects, failed listings, and truncated inventories do not erase saved
permissions. A deleted workspace that later reappears must be selected again in
normal mode; high-permission mode includes it automatically. Inventories and
concrete scopes are bounded to 512 workspaces. If an inventory is truncated,
Ranger will not silently treat the partial result as all workspaces. Large scopes
can take longer to validate and send more workspace context to the model.

For a compatible endpoint, expand **Configure custom models** and enter a unique
provider ID, API format, API base URL, model IDs, and API key. Enter one model ID
per line or separate IDs with commas, up to 100 IDs of 500 characters each.
Duplicate IDs are saved once. Supported formats are OpenAI Chat Completions,
OpenAI Responses, and Anthropic Messages. Use a
dummy key for an unauthenticated local server. **Save custom models** saves the
whole batch and selects the first ID; then select allowed workspaces and
**Save connection**. Select a custom provider and model to **Edit custom models**;
a blank key keeps its existing key. Stop running tasks before changing a model
connection. Existing models outside the batch keep their settings.
Use a separate provider ID for a different endpoint so existing providers keep
their connection settings.

Custom model IDs do not declare reasoning support automatically. For a model
whose endpoint supports thinking, choose **Enable reasoning for all IDs** under
**Reasoning capability** and save the custom models. Existing models can be
edited in place; no new provider or API key is needed. The default **Keep
existing / model defaults** preserves each model's declaration, while new IDs
remain non-reasoning. An explicit enable or disable applies to every entered
ID, so use separate batches for models with different capabilities. Existing
Pi thinking-level maps and compatibility settings are preserved. Select the
desired **Thinking effort** and save the connection, or use the chat selector.
Pi determines the available levels and translates the selected effort into the
chosen API format; declaring support does not verify a third-party endpoint's
capabilities. Without a custom thinking-level map, reasoning models expose
Off, Minimal, Low, Medium, and High; imported maps can restrict or extend these.

**Provider** lists OAuth logins and API keys from the selected credential
source. Click a saved provider to select it, or expand **Connect another provider**
to choose one without saved credentials and log in from the window. **Refresh**
reads changes made outside the window. These labels report stored
credentials, not a successful live connection test; credentials are checked or
refreshed when used.
**Search providers** filters saved and other providers by name or ID, ignoring
case. Matching providers without saved credentials expand automatically;
filtering does not change the selected provider.

Ranger runs as the Roamgate bridge's OS account, including when the browser
is on a phone or a workspace uses SSH. Provider credentials therefore belong on
the bridge host. Separate Ranger credentials live in
`~/.config/roamgate/assistant/auth.json` or
`%APPDATA%\roamgate\assistant\auth.json`; custom endpoints live in `models.json`
beside them. Configuration, the active conversation,
model context, and history summaries live beside them in `state.json`. Inactive
conversations live in private `sessions/<UUID>.json` files. Durable execution
state and tool results live in `durable/<UUID>/execution.sqlite`. Stop the bridge
before backing up the whole assistant directory to retain saved chats, database
files and credentials. These files may contain secrets or workspace content.
Keep them private and use one bridge
process per data directory.
`ROAMGATE_ASSISTANT_DIR` overrides this directory; the legacy
`HERDR_GUI_ASSISTANT_DIR` alias is also accepted.

An unfinished question resumes when the bridge restarts and its original
connections become ready, even with the browser closed. Recovery requires the
same Herdr server boot and workspace identity and a supported endpoint handshake.
It waits for manually connected profiles until the user reconnects them; it does
not connect additional profiles itself. If Herdr also restarted or the original
target, permissions, or provider is unavailable, send a new question. **Stop**
cancels work; stopping the bridge pauses it. Confirmed management operations are
never automatically retried. Durable stores have no automatic retention quota.

The Ranger **Tasks** view manages one-time, daily, and interval schedules.
Task creation requires an endpoint with a stable Herdr boot identity, the chosen
model, and an explicitly allowed workspace scope. If creation fails, the
returned error names the unmet requirement, such as an older Herdr server
that does not expose a boot identity. Tasks keep their original
model and target identities; after a Herdr restart or target change, edit the
task to authorize the current targets. The bridge must be running for schedules
to fire. After downtime, missed occurrences are combined into one run.
If an original connection is temporarily unavailable, its run stays queued while
other ready tasks can run. Manual connection profiles still require the user to
reconnect them; scheduling does not override their `auto_connect` setting.
Daily times use the task's IANA timezone, independently of the bridge's local
timezone; daylight-saving gaps are skipped and overlaps fire only once.
Plans, proposals, deduplication records and run receipts live in `tasks.sqlite`,
with private per-run state under `tasks/<task UUID>/runs/<run UUID>/`. The task
database and Pi Durable databases use WAL mode with `synchronous = FULL`.
The task database upgrades schemas 1 and 2 to schema 3 automatically and
transactionally to store notification modes, custom-notification receipts, and
bound workspace/Agent references. Older builds
cannot open the upgraded task database. If you need rollback, back up the Ranger
data directory while the bridge is stopped before upgrading.
An invalid database disables task scheduling instead of discarding saved plans.
Task runs share the selected bridge credential store; credentials are not copied
into run directories. Include
these files when backing up the assistant directory. The latest 20 runs per
task are retained; cancelling keeps history, while deleting a cancelled task
removes its saved runs. There is no aggregate byte quota for durable stores.

**Shared Pi credentials** explicitly opts into Pi's existing credential store
for that bridge account. Signing in or entering an API key in this mode updates
that store, so Pi can also use the saved credentials. The separate **Ranger connection**
keeps its own store. Neither mode requires terminal interaction to log in.
The catalog uses credentials saved in Pi's `auth.json` and compatible endpoints
in Pi's `models.json`. Custom model changes in shared mode update that file.
**Refresh** rereads both files. Environment-only credentials for built-in
providers are not imported. Model-file keys may use Pi's environment or command
syntax; entering a key in **Configure custom model** accepts literal keys only.
Pi's extensions, skills, project instructions, and
built-in write/command tools are not loaded into Ranger.

For remote bridge deployments, follow the provider's displayed device-code or
manual authorization flow. A browser's localhost callback points to the browser
machine; it does not automatically reach the bridge host. Cancelling a login
does not disconnect the bridge or its Herdr profiles. See
[Ranger behavior](../FEATURES.md#ranger) and
[tool and session contracts](ARCHITECTURE.md#ranger).

## Web Push notifications

1. Use trusted HTTPS; on iOS/iPadOS 16.4+, open the installed Home Screen app.
2. Enable **Task notifications**, grant permission, and choose **Task needs attention**
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

After upgrading Roamgate, reopen or reload each browser/PWA once to activate the
current notification worker. Until then, an older worker can show a Ranger alert
but open only the app instead of its task run when clicked.

Delivery needs outbound HTTPS to Apple (`*.push.apple.com`), Google
(`fcm.googleapis.com`), Mozilla (`*.push.services.mozilla.com`), or Windows
(`*.notify.windows.com`); other providers are rejected. No public inbound endpoint
is needed. Devices must reach their provider and Roamgate when opening an alert.

The bridge and relevant Herdr runtimes must stay connected; alerts arrive without
open browsers. The default `herdr` notification source relays Herdr's own
notifications (Herdr 0.9+), so Roamgate alerts match Herdr's toasts, including
`[ui.notifications] external_agents` suppression and alerts sent with
`herdr notification show`. Roamgate keeps one passive client-shell connection per
runtime for this; Herdr counts it as a connected client for `notification show`,
but it never takes focus or tab geometry. `status` (or older Herdr servers) instead
observes `working -> blocked` and `working -> done/idle`; startup snapshots are
silent. Delivery is best-effort: OS/Focus settings, outages, expired
subscriptions, or stopped runtimes can prevent it. Messages expire after five
minutes, with no durable replay; HTTP 404/410 removes expired subscriptions.

Turning notifications off revokes on the server before browser unsubscribe.
If revocation fails, reconnect/retry or revoke OS/browser permission immediately;
already-accepted messages may arrive. Server-wide disable retains the registry
for reuse when re-enabled. Password changes do not revoke device subscriptions.

**Active page only** is the fallback when push is unavailable; do not rely on it
while suspended/closed. Encrypted payloads contain notification text and routing
IDs, including Ranger's custom titles and messages, and may appear on lock
screens.

### Local notification testing

HTTP loopback origins such as `http://localhost` and `http://127.0.0.1` are
[secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
and can test browser notifications and Web Push without local TLS. With
`bun run dev:web`, the Vite origin on port 5173 proxies the bridge on port 8788.
For a bridge on another port, run `bun run build:web` and open that bridge's URL
directly. Use an isolated data directory and browser origin for test permissions,
subscriptions and Ranger tasks.

Enable **Task notifications** in the test browser, then ask Ranger to propose
a monitoring task using **Let Ranger decide** and confirm it. **Run now** exercises
the task and its notification; click the alert to verify the exact run opens.
Repeat the same observed event to check deduplication. To isolate active-page
system delivery, first turn notifications off to revoke an existing subscription,
set `ROAMGATE_WEB_PUSH_SUBJECT=''`, restart the bridge and enable notifications.
To test closed-page delivery, restore the default subject,
restart and re-enroll until **Background push** appears, then close the test
origin's pages while leaving the bridge and Herdr running. Browser and OS
notification permissions and outbound access to the push provider still apply.

The reproducible local-model integration test covers proposal, confirmation,
scheduled execution, custom text and deduplication across a bridge restart:

```sh
bun test server/src/assistant-recovery.integration.test.ts --test-name-pattern 'confirmed Ranger proposals schedule custom notifications'
```

It uses the real Pi driver and bridge with a scripted model transport and fixture
Herdr sockets. It does not establish browser or system notification delivery.

## Logging

Logs use one line per event: timestamp, severity, scope, bounded key/value context.
`info` covers lifecycle/failures, not routine RPC/events/frames/successful auto-sync.
Use `roamgate --log-level debug` or `ROAMGATE_LOG_LEVEL=debug` temporarily;
restart services after editing their environment. Debug can expose paths/IDs;
return to `info` afterwards. Logs omit URL auth tokens, which remain in protected files.

### Performance profiling

Start a short foreground capture on an unused port, then reproduce the slow
interaction in that instance's browser page:

```bash
roamgate --host 127.0.0.1 --port 8788 --profile --profile-duration 30 --open
```

Sampling begins during startup and stops automatically after the requested
interval; the server keeps running. Ctrl+C/SIGTERM attempts to save the partial
capture before normal shutdown. Force-kill/crash or a forced shutdown deadline
may lose it. The deadline is event-loop scheduled, so a blocked loop can delay
completion. Profiling adds CPU/memory overhead and exporting the report can
briefly pause the server; leave it off for ordinary use. No debugger port or
profiling HTTP endpoint is opened.

Each run creates a private, uniquely named subdirectory under `--profile-dir`
(default `~/.config/roamgate/profiles`, or `%APPDATA%\\roamgate\\profiles` on Windows).
The log reports the output directory. Files are owner-only on POSIX; Windows
access follows directory ACLs. Keep diagnostic files private and remove them
when no longer needed; captures accumulate without automatic cleanup.

- `summary.txt`: elapsed time, process CPU time, ending RSS, event-loop-delay
  statistics, hottest sampled functions and JIT-tier/bytecode breakdown.
- `cpu.json`: Bun/JSC's raw `functions`, `bytecodes` and `stackTraces` result.
  This is **not Chrome's `.cpuprofile` format**. It can contain source paths,
  function names and source-map references; review it before sharing.

Process CPU time sums all process threads and can exceed elapsed time. The
20 ms event-loop-delay probe includes scheduling delays; it cannot by itself
separate CPU contention from synchronous JavaScript. CPU samples also do not
measure browser drawing, network wait or keyboard-to-screen latency. Minified
standalone builds may have shortened function names; for source-level diagnosis,
run the matching checkout with `bun server/src/index.ts --profile` after building
web assets. To investigate browser stalls, separately record its Performance
panel while reproducing the same interaction.

For a managed service, set `ROAMGATE_PROFILE=1` and optionally
`ROAMGATE_PROFILE_DURATION`/`ROAMGATE_PROFILE_DIR` in its environment file, then
restart when appropriate. The capture is once per process start, not an on-demand
capture of an already running process. Remove the settings afterwards. Do not
combine `--profile` with Bun's other CPU sampling profilers in the same process.

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

GUI preferences and worktree source relationships live in
`~/.config/roamgate/settings.json` (Windows: `%APPDATA%\roamgate\settings.json`).
Use `ROAMGATE_SETTINGS_PATH` to give another bridge its own settings file;
`HERDR_GUI_SETTINGS_PATH` remains a supported alias.

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

## PWA instance names

Use **Configuration > Instance > Title suffix** to distinguish Roamgate servers
installed from different addresses. A suffix such as `Home` produces
`Roamgate · Home` in the page title and PWA installation metadata. The name is
shared by every viewer of that Roamgate instance, including across devices; it
is independent of the selected Herdr connection. Use **Reset to default** or save
an empty suffix to restore `Roamgate`.

Suffixes accept up to 32 Unicode characters after whitespace normalization.
Keep them short so Android launchers can display the distinguishing part.
The `title_suffix` setting is saved in the server's GUI settings file and
survives restarts. When running multiple bridges under one OS account, use a
separate `ROAMGATE_SETTINGS_PATH` for each, as described in
[connection setup](#multiple-and-remote-herdr-connections).

Set the suffix before installing the PWA when possible. Saving updates the open
page immediately; other open pages refresh the name when brought to the
foreground. Existing installed apps may keep their old launcher name until the
browser processes the manifest update and asks for confirmation. If it stays
unchanged, reinstall the PWA from that instance's address. This does not rename
an installed Android app instantly. See
[Chrome's Android app update guidance](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en).

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

| Hook | Timing / working directory |
| --- | --- |
| `setup` | After create/open; new worktree |
| `opened` | After opening an existing worktree; opened worktree |
| `teardown` | Before removal; target worktree |
| `removed` | After removal; source checkout |

Roamgate selects the first existing file in this order:

1. Target worktree's `roamgate.json`
2. Source checkout's `roamgate.json`
3. Target worktree's `paseo.json` (legacy compatibility)
4. Source checkout's `paseo.json` (legacy compatibility)

One complete configuration is selected; files are never merged and hooks never
run twice. Missing or blank hook commands are skipped. Valid empty objects (`{}`
or `{"worktree": {}}`) suppress fallback. Empty files, invalid JSON, non-object
configuration or `worktree` values, non-string known hook fields, and read
failures report an error with the selected path, without trying another file.
Unknown fields are ignored.

After removal, the target is gone and resolution uses the source checkout;
the `removed` configuration and its scripts must be available there.
Configuration reads and commands run on the connected local or SSH host.
Commands use the existing `sh -c` runner and the working directories above.

To migrate, rename `paseo.json` to `roamgate.json`, preserving its `worktree`
object. Review both checkouts: even a source native file overrides a target
legacy file. No automatic migration is performed. **Worktree Hooks** and
**Worktree Lifecycle** show the effective path, errors, and legacy compatibility.
The settings RPC exposes `config_path` and `config_source` (`roamgate`, `paseo`,
or `null`); the compatibility field `paseo_path` is set only for a Paseo file.

Prefer the `ROAMGATE_HOOK_*` variables in new scripts:

| Variable | Value |
| --- | --- |
| `ROAMGATE_HOOK_EVENT` | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `ROAMGATE_HOOK_CHECKOUT_PATH` | Target path, including former path after removal |
| `ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH` | Source checkout when known |

`HERDR_GUI_HOOK_*` remains an alias for each corresponding Roamgate variable.
`PASEO_HOOK` contains `setup`, `opened`, `teardown`, or `removed`;
`PASEO_CHECKOUT_PATH` and `PASEO_SOURCE_CHECKOUT_PATH` retain the same paths.
All aliases are available for both native and legacy configuration.
Notices show bounded diagnostics including the actual configuration path.
**Failed teardown stops removal; other failures do not roll back completed actions.**
Hooks default on; inspect/disable per repository under **Worktree hooks** or
**Worktree Lifecycle**. Disabling applies to both formats and skips execution
even when configuration is invalid. Hooks are trusted, unsandboxed repository
code executed with the execution user's permissions. A native filename does
not establish trust: review configuration and scripts before worktree operations.

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
On macOS, installation checks the configured listener before registering the
launchd job. If another process owns the port, it reports the conflict and leaves
the preserved config available for choosing a different port.

macOS service installation validates effective config values without executing
the file. Use one `NAME=value` assignment per line, optionally prefixed by
`export`, with shell single/double quotes, backslash escapes, and comments.
`$NAME` and `${NAME}` expand variables defined earlier in the file; `HOME` is
available as the service user's home directory. For example:

```sh
SECRET='replace-with-a-strong-password'
ROAMGATE_PASSWORD="$SECRET"
```

The expanded password must contain 15 to 1024 Unicode characters. An explicitly
empty `ROAMGATE_PASSWORD` selects generated-token authentication, even when the
legacy password variable is set. Define other referenced variables in the config:
the installing terminal's environment is not the launchd environment. References
to externally defined variables, shell-special assignments, command substitutions,
standalone commands, and other unsupported shell expressions are rejected before
config migration or service changes. Keep the config self-contained; resolve
dynamic values yourself before installing or reinstalling.

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

Tokens live in `~/.config/roamgate/auth-token` or `%APPDATA%\roamgate\auth-token`.
A separate `session-secret.json` in the same directory stores the private random
cookie signing secret; preserve it across restarts and protect it like the login
token. `ROAMGATE_PASSWORD` and the generated token are login credentials only.
The first upgrade from credential-signed cookies requires logging in again.
Changing the effective credential rotates the signing secret at startup, so old
sessions stay revoked even if that credential is later restored. Stop all
listeners sharing this directory before credential changes. To revoke every
session without changing the login credential, stop the server, remove only
`session-secret.json`, then restart. Malformed or unsafe signing state fails
startup rather than silently resetting authentication. Concurrent startups use a
short-lived `session-secret.json.lock` directory. If startup was killed while
holding it, stop all listeners using this data directory, confirm no startup is
running, and remove that lock directory before restarting. A busy lock fails
closed after a bounded wait; it is never stolen from a potentially live writer.

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

Standalone builds omit source maps to keep release downloads smaller. Errors
report positions in the compiled code rather than the original TypeScript.
The Release workflow retains a separate `debug-roamgate-<tag>-<target>` CI
artifact for 30 days, containing a tar archive of the same version built with
embedded source maps and its `.map` file. Extract the tar before running the
debug executable; this preserves its executable permissions. These debug
artifacts are not published to GitHub Releases or used by automatic updates.
Use the matching debug executable to
reproduce errors with source-level stack traces.

To build a debug executable locally, first run `bun run build:web`, then
`bun run --cwd server compile --sourcemap`, or use
`compile:<target> --sourcemap` for another platform. This replaces the local
executable with a mapped build; run the normal compile command again before
packaging a production executable. Merely placing a `.map` file beside a
map-free executable does not restore source-level stack traces.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Cannot connect to Herdr | Check server and both socket paths; default local setup can use `roamgate herdr setup`. Override with `--socket-path /path/to/herdr.sock` only deliberately. |
| Another device cannot open the page | Check bind, token URL, network/firewall, and [private access setup](./TUTORIAL.md#networking). |
| SSH connects locally | Remove explicit socket flags/`HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH`; they override tunnel paths. |
| Want automatic browser launch | Use `roamgate --open` or `OPEN_BROWSER=1`. |

For step-by-step diagnosis, see [the tutorial](./TUTORIAL.md#troubleshooting).
